/**
 * Review of #1128 (money): the InstaPay add-on approval runs through the REAL `settleApprovedPayment` and the REAL `maySettle`
 * (no stub of either) on the platform D1 rig. #687's may-settle predicate holds any success that states no amount: the approval
 * used to pass only { status, providerRef }, so EVERY approval was held (merchant paid, add-on never on, P1). The approval now
 * states the amount the person confirmed (the claim carries the server quote) and the row's own currency, so a matching claim
 * settles and grants once, and a claim whose amount differs from the ledger row is held and grants nothing.
 */
import { PLATFORM_MIGRATION_SQL } from '../helpers/platform-migrations';
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

vi.mock('../../apps/api/src/services/payment-providers/instapay-receipt.service', () => ({
  InstapayReceiptService: {
    markReviewed: vi.fn(async () => undefined),
    deleteImages: vi.fn(async () => undefined),
  },
}));

import { prisma } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import { sendAlert } from '../../apps/api/src/services/alerts.service';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import { approveAddonClaim } from '../../apps/api/src/services/billing/addon-instapay';
import { activeAddons } from '../../apps/api/src/services/billing/addon-grant';
import {
  listHeldBillingWebhooks,
  resolveHeldBillingWebhook,
} from '../../apps/api/src/services/billing/subscription-billing.service';
import { planCodeOfSku } from '../../apps/api/src/services/billing/addon-catalog';

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
  // the InstaPay claims and receipts are their own family (`payments`) with their own cutover marker
  db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c2', ?, '{}')`).run(
    cutoverKey('payments')
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

const SKU = 'ai:topup_300';
const CLAIM = '44444444-4444-4444-8444-444444444444';
const seed = (db: DatabaseSync, claimAmount: number, rowAmount?: number) => {
  db.prepare(
    `INSERT INTO manual_payment_claims (id, store_id, plan_code, billing_interval, amount_minor, method, payment_reference, payer_reference, status)
     VALUES (?, ?, ?, 'monthly', ?, 'instapay', 'EBD-ADDON01', 'payer-ref-123456', 'pending')`
  ).run(CLAIM, STORE, planCodeOfSku(SKU), claimAmount);
  if (rowAmount !== undefined)
    // an earlier half-finished approval already opened the ledger row for this claim (the resume path)
    db.prepare(
      `INSERT INTO billing_events (id, store_id, type, plan_code, billing_interval, amount_minor, currency, provider, idempotency_key, status)
       VALUES (?, ?, 'upgrade', ?, 'monthly', ?, 'EGP', 'instapay', ?, 'pending')`
    ).run(EV, STORE, planCodeOfSku(SKU), rowAmount, `addon-instapay:${CLAIM}`);
};
const act = () => approveAddonClaim({ storeId: STORE, claimId: CLAIM, actorId: 'admin-1' });
const addons = () => activeAddons(prisma as never, STORE, new Date());
const heldAlerts = () =>
  vi
    .mocked(sendAlert)
    .mock.calls.filter(c =>
      String((c[0] as { source?: string }).source).startsWith('billing.webhook.held')
    );
const claimStatus = (db: DatabaseSync) =>
  (
    db.prepare('SELECT status s FROM manual_payment_claims WHERE id = ?').get(CLAIM) as {
      s: string;
    }
  ).s;

describe('InstaPay add-on approval through the REAL settle + may-settle (review of #1128)', () => {
  it('a matching claim settles: the add-on is active, nothing is held, no alert, and a second approval grants nothing more', async () => {
    const db = rig();
    seed(db, 5000);
    vi.mocked(sendAlert).mockClear();
    await act();
    expect((await addons()).map(a => a.sku)).toEqual([SKU]);
    expect(await listHeldBillingWebhooks({ status: 'open' })).toHaveLength(0);
    expect(heldAlerts()).toHaveLength(0);
    expect(claimStatus(db)).toBe('confirmed');
    await act(); // a double click / retry
    expect(await addons()).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) n FROM billing_events WHERE plan_code = ? AND status = 'succeeded'`
        )
        .get(planCodeOfSku(SKU))
    ).toEqual({ n: 1 });
  });

  it('a claim whose amount differs from the ledger row is HELD (queued, P1), grants nothing and the claim is not confirmed', async () => {
    const db = rig();
    seed(db, 5000, 4000);
    vi.mocked(sendAlert).mockClear();
    await expect(act()).rejects.toMatchObject({ statusCode: 409, code: 'ADDON_PAYMENT_HELD' });
    expect(await addons()).toHaveLength(0);
    expect(claimStatus(db)).toBe('pending');
    expect(
      db.prepare('SELECT status s, failure_reason f FROM billing_events WHERE id = ?').get(EV)
    ).toEqual({ s: 'pending', f: 'held:amount_mismatch' });
    const open = await listHeldBillingWebhooks({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      reason: 'amount_mismatch',
      expectedMinor: 4000,
      gotMinor: 5000,
    });
    expect(heldAlerts()).toHaveLength(1);
    // a retry refuses the same way and still grants nothing
    await expect(act()).rejects.toMatchObject({ code: 'ADDON_PAYMENT_HELD' });
    expect(await addons()).toHaveLength(0);
  });
});

describe('resolving a held add-on payment closes the merchant claim behind it (follow-up to #1128)', () => {
  const resolve = (id: string, action: 'credited' | 'refunded' | 'not_ours') =>
    resolveHeldBillingWebhook({
      id,
      actorId: 'admin-1',
      action,
      note: 'checked with the merchant',
      audit: async () => {},
    });
  const claimRow = (db: DatabaseSync) =>
    db
      .prepare(
        'SELECT status s, payer_reference p, review_note n, billing_event_id b FROM manual_payment_claims WHERE id = ?'
      )
      .get(CLAIM) as { s: string; p: string; n: string | null; b: string | null };
  const heldClaim = async () => {
    const db = rig();
    seed(db, 5000, 4000);
    await expect(act()).rejects.toMatchObject({ code: 'ADDON_PAYMENT_HELD' });
    const [h] = await listHeldBillingWebhooks({ status: 'open' });
    return { db, h };
  };

  it.each(['refunded', 'not_ours'] as const)(
    '%s: the claim is rejected with the note, its reference is freed and it no longer reads pending',
    async action => {
      const { db, h } = await heldClaim();
      expect(claimRow(db).s).toBe('pending'); // the stuck shape this closes
      await resolve(h.id, action);
      const c = claimRow(db);
      expect(c.s).toBe('rejected');
      expect(c.n).toBe('checked with the merchant');
      expect(c.p).toContain('#rejected-'); // the unique transfer reference is free for re-filing
      expect(await addons()).toHaveLength(0);
    }
  );

  it('credited with NO granted add-on: rejected with a note that says so, never confirmed', async () => {
    const { db, h } = await heldClaim();
    await resolve(h.id, 'credited');
    const c = claimRow(db);
    expect(c.s).toBe('rejected');
    expect(c.n).toMatch(/^Credited by hand, but no active add-on of this kind was found/);
  });

  it('credited with the add-on actually granted: confirmed against that term', async () => {
    const { db, h } = await heldClaim();
    db.prepare(
      `INSERT INTO billing_events (id, store_id, type, plan_code, billing_interval, amount_minor, currency, provider, idempotency_key, status, for_period_end)
       VALUES ('99999999-9999-4999-8999-999999999999', ?, 'upgrade', ?, 'monthly', 5000, 'EGP', 'manual', 'manual:granted', 'succeeded', ?)`
    ).run(STORE, planCodeOfSku(SKU), Date.now() + 20 * 86_400_000);
    await resolve(h.id, 'credited');
    expect(claimRow(db)).toMatchObject({
      s: 'confirmed',
      b: '99999999-9999-4999-8999-999999999999',
    });
  });

  it('a failing queue close leaves the claim already closed, and the retry completes without touching it twice', async () => {
    const { db, h } = await heldClaim();
    db.exec(
      `CREATE TRIGGER fail_queue_close BEFORE UPDATE ON billing_webhook_events WHEN NEW.outcome = 'held_resolved'
       BEGIN SELECT RAISE(ABORT, 'injected: queue close failed'); END`
    );
    await expect(resolve(h.id, 'refunded')).rejects.toThrow();
    expect(claimRow(db).s).toBe('rejected');
    db.exec('DROP TRIGGER fail_queue_close');
    await resolve(h.id, 'refunded');
    expect(claimRow(db).s).toBe('rejected');
    expect(claimRow(db).p.match(/#rejected-/g)).toHaveLength(1);
    expect(await listHeldBillingWebhooks({ status: 'open' })).toHaveLength(0);
  });
});
