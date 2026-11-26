/**
 * NEON-ZERO-1 N-10a: manual payment on D1 FAILS CLOSED. The D1 write (ledger + subscription, one batch) is the first change;
 * stores.plan, the claim and the receipt (Postgres) follow. A reference another store holds, a lost compare-and-set or any
 * D1 refusal must leave all three untouched.
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
vi.mock('../../apps/api/src/services/billing/charge-amount', async importOriginal => ({
  ...(await importOriginal<object>()),
  resolvePlatformVat: async () => ({ enabled: false, rateBps: 0, mode: 'inclusive' }),
}));
const h = vi.hoisted(() => ({
  storeUpdate: vi.fn(async () => ({})),
  claimUpdateMany: vi.fn(async () => ({ count: 1 })),
  claimFindMany: vi.fn(async () => [{ id: 'claim-1' }]),
  claimFindFirst: vi.fn(async (): Promise<{ amountMinor: number } | null> => null),
  approve: vi.fn(async () => ['rcpt-1']),
}));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeUpdate: h.storeUpdate,
}));
vi.mock(
  '../../apps/api/src/services/payment-providers/instapay-receipt.service',
  async importOriginal => {
    const real = await importOriginal<{ InstapayReceiptService: object }>();
    return {
      ...real,
      InstapayReceiptService: Object.assign(Object.create(real.InstapayReceiptService), {
        approveSubmitted: h.approve,
        deleteImages: vi.fn(async () => undefined),
      }),
    };
  }
);
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // routed models -> the real routed proxy (D1); the few Postgres models the flow touches -> fakes
  const fake: Record<string, unknown> = {
    store: { findUnique: async () => ({ ownerId: null, billingSuspendedReason: null }) },
    manualPaymentClaim: {
      updateMany: h.claimUpdateMany,
      findMany: h.claimFindMany,
      findFirst: h.claimFindFirst,
    },
  };
  const prisma = new Proxy(real.prisma, {
    get: (t, p) => (typeof p === 'string' && p in fake ? fake[p] : Reflect.get(t, p)),
  });
  return { ...real, prisma, withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma) };
});

import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import { recordManualPayment } from '../../apps/api/src/services/billing/account.service';

const MIG = PLATFORM_MIGRATION_SQL;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function world() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG);
  const stmt = (sql: string, v: unknown[]) =>
    /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
      ? { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) } };
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
    batch: async (l: Array<{ __run: () => { meta: { changes: number } } }>) => {
      db.exec('BEGIN');
      try {
        const out = l.map(s => s.__run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  for (const [id, slug] of [
    [A, 'a'],
    [B, 'b'],
  ])
    db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, ?, ?, 'o')`).run(
      id,
      slug,
      slug
    );
  db.prepare(
    `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor) VALUES ('p', 'growth', 'g', 'g', 'professional', '{}', 5000)`
  ).run();
  db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c', ?, '{}')`).run(
    cutoverKey('billing')
  );
  setCfBindings({ PLATFORM_DB: d1 } as never);
  return db;
}

const input = (storeId: string, over: Record<string, unknown> = {}) => ({
  storeId,
  planCode: 'growth',
  interval: 'monthly' as const,
  amountMinor: 5000,
  method: 'instapay' as const,
  reference: '12345678901',
  paidAt: new Date(),
  actorId: 'admin',
  now: new Date(),
  ...over,
});

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
  Object.values(h).forEach(f => f.mockClear());
  h.storeUpdate.mockResolvedValue({});
});

describe('manual payment on D1 fails closed', () => {
  it('BILLING-AMOUNT-GUARD-1: a typed amount that is not the plan price is refused with the expected amount', async () => {
    const db = world();
    await expect(recordManualPayment(input(A, { amountMinor: 4000 }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'AMOUNT_MISMATCH',
      details: { expectedAmountMinor: 5000, amountMinor: 4000 },
    });
    expect(db.prepare('SELECT COUNT(*) n FROM billing_events WHERE store_id = ?').get(A)).toEqual({
      n: 0,
    });
    expect(h.storeUpdate).not.toHaveBeenCalled();
  });

  it('BILLING-AMOUNT-GUARD-1: a claim fixes the expected amount (what the merchant was told), even after the price moved', async () => {
    const db = world();
    h.claimFindFirst.mockResolvedValueOnce({ amountMinor: 4321 });
    await recordManualPayment(input(A, { amountMinor: 4321, claimId: 'claim-1' }));
    expect(
      (
        db.prepare('SELECT amount_minor a FROM billing_events WHERE store_id = ?').get(A) as {
          a: number;
        }
      ).a
    ).toBe(4321);
    // and the list price is NOT accepted for that claim
    h.claimFindFirst.mockResolvedValueOnce({ amountMinor: 4321 });
    await expect(
      recordManualPayment(
        input(A, { amountMinor: 5000, claimId: 'claim-1', reference: 'ref-other-77' })
      )
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', details: { expectedAmountMinor: 4321 } });
  });

  it('BILLING-AMOUNT-GUARD-1: a replay of an already recorded payment is a duplicate, never a 409, after the price changed', async () => {
    const db = world();
    const first = await recordManualPayment(input(A));
    db.prepare(`UPDATE plans SET price_monthly_minor = 9000 WHERE code = 'growth'`).run();
    const again = await recordManualPayment(input(A));
    expect(again).toEqual({ duplicate: true, billingEventId: first.billingEventId });
  });

  it('BILLING-AMOUNT-GUARD-1: with an explicit reason the different amount is recorded, reason in the ledger row', async () => {
    const db = world();
    await recordManualPayment(
      input(A, { amountMinor: 4000, overrideAmountReason: 'partner discount agreed on WhatsApp' })
    );
    const row = db
      .prepare('SELECT amount_minor a, raw FROM billing_events WHERE store_id = ?')
      .get(A) as { a: number; raw: string };
    expect(row.a).toBe(4000);
    expect(JSON.parse(row.raw)).toMatchObject({
      expectedAmountMinor: 5000,
      amountOverrideReason: 'partner discount agreed on WhatsApp',
    });
  });

  it('a reference store B already holds is refused for store A: 409, and nothing in Postgres moved', async () => {
    const db = world();
    db.prepare(
      `INSERT INTO billing_events (id, store_id, type, amount_minor, provider, idempotency_key, status) VALUES ('e-b', ?, 'manual_payment', 5000, 'manual', 'manual:instapay:12345678901', 'succeeded')`
    ).run(B);
    await expect(recordManualPayment(input(A))).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFERENCE_USED_ELSEWHERE',
    });
    expect(h.storeUpdate).not.toHaveBeenCalled();
    expect(h.claimUpdateMany).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM store_subscriptions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM billing_events WHERE store_id = ?').get(A)).toEqual({
      n: 0,
    });
  });

  it('a lost compare-and-set (subscription moved) refuses with 409 retryable and touches nothing in Postgres', async () => {
    const db = world();
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status, updated_at) VALUES ('s', ?, 'growth', 'trialing', 1)`
    ).run(A);
    // the D1 batch reports the lost compare-and-set (the unit test of the batch itself is platform-billing-d1-money)
    const spy = vi.spyOn(
      await import('../../apps/api/src/services/platform/billing-d1'),
      'commitManualPaymentD1'
    );
    spy.mockResolvedValueOnce('conflict');
    await expect(recordManualPayment(input(A))).rejects.toMatchObject({
      statusCode: 409,
      code: 'SUBSCRIPTION_CHANGED',
    });
    expect(h.storeUpdate).not.toHaveBeenCalled();
    expect(h.claimUpdateMany).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a D1 outage refuses the payment before any Postgres change', async () => {
    const db = world();
    void db;
    setCfBindings({
      PLATFORM_DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            all: async () => {
              if (/system_settings/.test(sql)) return { results: [{ key: cutoverKey('billing') }] };
              if (/INSERT INTO billing_events/.test(sql)) throw new Error('d1 down');
              return { results: [] };
            },
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
          }),
        }),
        batch: async () => Promise.reject(new Error('d1 down')),
      },
    } as never);
    resetCutoverCache();
    await expect(recordManualPayment(input(A))).rejects.toBeTruthy();
    expect(h.storeUpdate).not.toHaveBeenCalled();
    expect(h.claimUpdateMany).not.toHaveBeenCalled();
  });

  it('same-store retry after a failed Postgres half is an idempotent replay that repeats the half once', async () => {
    const db = world();
    h.storeUpdate.mockRejectedValueOnce(new Error('postgres down'));
    await expect(recordManualPayment(input(A))).rejects.toThrow('postgres down');
    // D1 holds the payment, Postgres does not yet
    expect(db.prepare('SELECT COUNT(*) n FROM billing_events WHERE store_id = ?').get(A)).toEqual({
      n: 1,
    });
    expect(db.prepare('SELECT plan_code p, status s FROM store_subscriptions').get()).toEqual({
      p: 'growth',
      s: 'active',
    });
    expect(h.claimUpdateMany).not.toHaveBeenCalled();

    const again = await recordManualPayment(input(A));
    expect(again).toMatchObject({ duplicate: true });
    expect(h.storeUpdate).toHaveBeenCalledTimes(2); // the failed try + the heal
    expect(h.claimUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) n FROM billing_events').get()).toEqual({ n: 1 }); // no second ledger row
  });

  it('a replay never drags stores.plan back once the subscription has moved to another plan', async () => {
    const db = world();
    h.storeUpdate.mockRejectedValueOnce(new Error('postgres down'));
    await expect(recordManualPayment(input(A))).rejects.toThrow();
    db.prepare(
      `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES ('p2', 'basic', 'b', 'b', 'starter', '{}')`
    ).run();
    db.prepare(`UPDATE store_subscriptions SET plan_code = 'basic'`).run();
    h.storeUpdate.mockClear();
    expect(await recordManualPayment(input(A))).toMatchObject({ duplicate: true });
    expect(h.storeUpdate).not.toHaveBeenCalled();
  });
});
