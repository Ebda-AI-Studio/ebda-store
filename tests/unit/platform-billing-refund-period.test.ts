/**
 * R-REFUND-PERIOD-1: a FULL card refund of the charge that paid the current period rolls the period back
 * (the card twin of the InstaPay void); keepAccess and partial refunds leave it. Real billing code on the D1 path.
 */
import { PLATFORM_MIGRATION_SQL } from '../helpers/platform-migrations';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/billing/billing-notify', () => ({
  runBillingEffects: vi.fn(async () => undefined),
}));
const storeUpdateMock = vi.hoisted(() => vi.fn(async () => ({})));
const captured = vi.hoisted(() => ({
  guard: undefined as undefined | ((m: string, o: string) => void),
}));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeUpdate: storeUpdateMock,
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...real,
    setRoutedModelGuard: (fn: (m: string, o: string) => void) => {
      captured.guard = fn;
      real.setRoutedModelGuard(fn);
    },
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(real.prisma),
    currentStoreId: () => '11111111-1111-4111-8111-111111111111',
  };
});

import { prisma, setModelWriteObserver } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import { refundCharge } from '../../apps/api/src/services/billing/subscription-billing.service';

const MIG = PLATFORM_MIGRATION_SQL;

const STORE = '11111111-1111-4111-8111-111111111111';
const STORE2 = '22222222-2222-4222-8222-222222222222';

const EV = '33333333-3333-4333-8333-333333333333';

function rig() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG);
  const stmt = (sql: string, v: unknown[]) => {
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql))
      return { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } };
    return {
      results: [],
      meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) },
    };
  };
  const prep = (sql: string) => ({
    bind: (...v: unknown[]) => ({
      all: async () => (await Promise.resolve(), stmt(sql, v)),
      run: async () => (await Promise.resolve(), stmt(sql, v)),
      first: async () => (await Promise.resolve(), (stmt(sql, v).results[0] ?? null) as never),
      __run: () => stmt(sql, v),
    }),
  });
  const d1 = {
    prepare: prep,
    // atomic: roll everything back if a statement throws (D1 batch semantics)
    batch: async (list: Array<{ __run: () => { meta: { changes: number } } }>) => {
      db.exec('BEGIN');
      try {
        const out = list.map(s => s.__run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, 's', 's', 'o')`).run(STORE);
  for (const [code, tier] of [
    ['free', 'free'],
    ['growth', 'professional'],
    ['basic', 'starter'],
  ] as const)
    db.prepare(
      `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor) VALUES (?, ?, ?, ?, ?, '{}', 1000)`
    ).run(`p-${code}`, code, code, code, tier);
  db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c', ?, '{}')`).run(
    cutoverKey('billing')
  );
  setCfBindings({ PLATFORM_DB: d1 } as never);
  return db;
}

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
  storeUpdateMock.mockReset();
  storeUpdateMock.mockResolvedValue({});
});

const DAY = 86_400_000;
const provider = (status: 'succeeded' | 'pending' = 'succeeded') =>
  ({
    name: 'stub',
    refund: vi.fn(async () => ({ status, refundId: 'rf-1', raw: {} })),
  }) as never;

/** A store paid through renewal EV: the period it bought is [start, end]. */
function world(over: { type?: string; subStatus?: string; start?: number; end?: number } = {}) {
  const db = rig();
  const start = over.start ?? Date.now() - 2 * DAY;
  const end = over.end ?? start + 30 * DAY;
  db.prepare(
    `INSERT INTO store_subscriptions (id, store_id, plan_code, status, current_period_start, current_period_end, billing_interval)
     VALUES ('s1', ?, 'basic', ?, ?, ?, 'monthly')`
  ).run(STORE, over.subStatus ?? 'active', start, end);
  db.prepare(
    `INSERT INTO billing_events (id, store_id, subscription_id, type, plan_code, billing_interval, for_period_end, amount_minor, provider, provider_ref, idempotency_key, status)
     VALUES (?, ?, 's1', ?, 'basic', 'monthly', ?, 1000, 'stub', 'ch-1', 'k-ev', 'succeeded')`
  ).run(EV, STORE, over.type ?? 'renewal', start);
  return { db, start, end };
}
const sub = (db: DatabaseSync) =>
  db
    .prepare(
      'SELECT status, plan_code p, current_period_end e, dunning_attempts d, next_retry_at r, provider pv FROM store_subscriptions'
    )
    .get() as {
    status: string;
    p: string;
    e: number;
    d: number;
    r: number | null;
    pv: string | null;
  };

describe('refundCharge rolls the paid period back on a FULL refund', () => {
  it('renewal: access ends at once (free / canceled) and NO automatic charge can follow', async () => {
    const { db } = world();
    const out = await refundCharge({ eventId: EV, provider: provider() });
    expect(out.status).toBe('succeeded');
    expect(db.prepare('SELECT status FROM billing_events WHERE id = ?').get(EV)).toEqual({
      status: 'refunded',
    });
    // canceled + no provider + no retry date: the daily cycle never selects it, nothing re-charges the card
    expect(sub(db)).toMatchObject({ status: 'canceled', p: 'free', r: null, pv: null });
  });

  it('checkout: access ends at once too', async () => {
    const { db } = world({ type: 'checkout' });
    await refundCharge({ eventId: EV, provider: provider() });
    expect(sub(db)).toMatchObject({ status: 'canceled', p: 'free', r: null });
  });

  it('keepAccess (goodwill): money goes back, the period stays', async () => {
    const { db, end } = world();
    await refundCharge({ eventId: EV, keepAccess: true, provider: provider() });
    expect(sub(db)).toMatchObject({ status: 'active', e: end });
  });

  it('a PARTIAL refund never touches the period', async () => {
    const { db, end } = world();
    await refundCharge({ eventId: EV, amountMinor: 400, provider: provider() });
    expect(sub(db)).toMatchObject({ status: 'active', e: end });
  });

  it('a newer paid charge owns the current period: refunding the OLD charge leaves it', async () => {
    const { db, end } = world();
    db.prepare(
      `INSERT INTO billing_events (id, store_id, subscription_id, type, plan_code, billing_interval, amount_minor, provider, provider_ref, idempotency_key, status, created_at)
       VALUES ('44444444-4444-4444-8444-444444444444', ?, 's1', 'renewal', 'basic', 'monthly', 1000, 'stub', 'ch-2', 'k-new', 'succeeded', ?)`
    ).run(STORE, Date.now() + 1000);
    await refundCharge({ eventId: EV, provider: provider() });
    expect(sub(db)).toMatchObject({ status: 'active', e: end });
  });

  it('an async (pending) refund stores keepAccess at CLAIM time and leaves the plan until it settles', async () => {
    const { db, end } = world();
    const p = {
      name: 'stub',
      refund: vi.fn(async () => {
        // while the gateway call is in flight the row already carries the operator's choice
        const raw = db.prepare("SELECT raw FROM billing_events WHERE type = 'refund'").get() as {
          raw: string;
        };
        expect(JSON.parse(raw.raw)).toMatchObject({ keepAccess: true });
        return { status: 'pending', refundId: 'rf-1', raw: {} };
      }),
    } as never;
    await refundCharge({ eventId: EV, keepAccess: true, provider: p });
    expect(sub(db)).toMatchObject({ status: 'active', e: end }); // nothing yet
  });
});
