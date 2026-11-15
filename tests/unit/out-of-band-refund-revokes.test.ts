/**
 * #837 (money-abuse audit S6, P1): a refund or chargeback made OUTSIDE Ebda (Kashier dashboard, a reversal, a bank
 * dispute) used to be ignored (`unknown_refund`) and the paid plan stayed active.
 *
 * Runs the real billing code on the D1 path (an in-memory SQLite with the platform migrations), like
 * platform-billing-d1-money.test.ts:
 *  - a confirmed refund webhook for a charge with no Ebda refund row is booked against that charge, flips it to
 *    `refunded` and revokes the plan it paid for, and raises a P1;
 *  - replay-safe (webhook dedupe + one ledger row per gateway reversal id);
 *  - an external money fact is never refused: an amount above what the charge holds is recorded, clamped, paged;
 *  - a partial reversal changes no plan; a reversal of an OLD charge revokes nothing;
 *  - the daily reconcile books a reversal no webhook reported (Kashier's webhook docs list no chargeback event).
 */
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
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeUpdate: storeUpdateMock,
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...real,
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(real.prisma),
    currentStoreId: () => '11111111-1111-4111-8111-111111111111',
  };
});

import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import { sendAlert } from '../../apps/api/src/services/alerts.service';
import { runBillingEffects } from '../../apps/api/src/services/billing/billing-notify';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import { StubBillingProvider } from '../../apps/api/src/services/billing/stub.provider';
import {
  applyWebhookEvent,
  reconcileGatewayReversals,
} from '../../apps/api/src/services/billing/subscription-billing.service';

const MIG = ['0001_init.sql', '0002_invariants.sql']
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');

const STORE = '11111111-1111-4111-8111-111111111111';
const CHARGE = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';
const DAY = 86_400_000;

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
  ] as const)
    db.prepare(
      `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor) VALUES (?, ?, ?, ?, ?, '{}', 1000)`
    ).run(`p-${code}`, code, code, code, tier);
  db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c', ?, '{}')`).run(
    cutoverKey('billing')
  );
  setCfBindings({ PLATFORM_DB: d1 } as never);
  // A Growth subscription paid by card: an old renewal, then the charge that paid the CURRENT period.
  db.prepare(
    `INSERT INTO store_subscriptions (id, store_id, plan_code, status, provider, provider_payment_method_ref, current_period_end) VALUES ('s1', ?, 'growth', 'active', 'stub', 'tok', ?)`
  ).run(STORE, Date.now() + 25 * DAY);
  const charge = (id: string, ref: string, createdAt: number) =>
    db
      .prepare(
        `INSERT INTO billing_events (id, store_id, type, plan_code, billing_interval, amount_minor, provider, provider_ref, idempotency_key, status, created_at) VALUES (?, ?, 'renewal', 'growth', 'monthly', 1000, 'stub', ?, ?, 'succeeded', ?)`
      )
      .run(id, STORE, ref, `k-${id}`, createdAt);
  charge(OLD, 'txn-old', Date.now() - 35 * DAY);
  charge(CHARGE, 'txn-pay', Date.now() - 5 * DAY);
  return db;
}

const refundHook = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'refund.succeeded',
    eventId: 'txn-rf-1:SUCCESS',
    merchantOrderId: CHARGE,
    providerRef: 'txn-rf-1',
    amountMinor: 1000,
    currency: 'EGP',
    failureReason: undefined,
    raw: {},
    customerRef: undefined,
    card: undefined,
    occurredAt: new Date(),
    ...over,
  }) as never;

const sub = (db: DatabaseSync) =>
  db.prepare('SELECT plan_code p, status s FROM store_subscriptions').get();
const chargeStatus = (db: DatabaseSync, id = CHARGE) =>
  (db.prepare('SELECT status FROM billing_events WHERE id = ?').get(id) as { status: string })
    .status;
const refunds = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT amount_minor a, provider_ref r, related_event_id c, status s FROM billing_events WHERE type = 'refund' ORDER BY created_at`
    )
    .all();
const alerts = () =>
  vi.mocked(sendAlert).mock.calls.map(c => c[0] as { level: string; title: string; body: string });
const effectKinds = () =>
  vi
    .mocked(runBillingEffects)
    .mock.calls.flatMap(c => (c[0] as Array<{ kind: string }>).map(e => e.kind));

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
  storeUpdateMock.mockReset().mockResolvedValue({});
  vi.mocked(sendAlert).mockClear();
  vi.mocked(runBillingEffects).mockClear();
});

describe('a refund made outside Ebda (webhook)', () => {
  it('full refund of the charge behind the current plan: booked, charge refunded, plan revoked, P1', async () => {
    const db = rig();
    const out = await applyWebhookEvent('stub', refundHook());
    expect(out).toMatchObject({ outcome: 'processed', detail: 'out_of_band_reversal' });
    expect(refunds(db)).toEqual([{ a: 1000, r: 'txn-rf-1', c: CHARGE, s: 'succeeded' }]);
    expect(chargeStatus(db)).toBe('refunded');
    expect(sub(db)).toEqual({ p: 'free', s: 'canceled' });
    expect(effectKinds()).toContain('downgraded');
    expect(alerts()).toContainEqual(
      expect.objectContaining({ level: 'p1', title: expect.stringContaining('outside Ebda') })
    );
  });

  it('a replay of the same delivery books nothing twice', async () => {
    const db = rig();
    await applyWebhookEvent('stub', refundHook());
    expect(await applyWebhookEvent('stub', refundHook())).toMatchObject({ duplicate: true });
    expect(refunds(db)).toHaveLength(1);
  });

  it('never refuses an external money fact: an amount above the charge is recorded, clamped, paged', async () => {
    const db = rig();
    await applyWebhookEvent('stub', refundHook({ amountMinor: 1500 }));
    expect(refunds(db)).toEqual([expect.objectContaining({ a: 1000 })]);
    const raw = JSON.parse(
      (db.prepare(`SELECT raw FROM billing_events WHERE type = 'refund'`).get() as { raw: string })
        .raw
    );
    expect(raw).toMatchObject({ outOfBand: true, reportedAmountMinor: 1500, excessMinor: 500 });
    expect(alerts().some(a => a.body.includes('500 piastres MORE'))).toBe(true);
  });

  it('a partial refund changes no plan (a person decides from the P1)', async () => {
    const db = rig();
    await applyWebhookEvent('stub', refundHook({ amountMinor: 300 }));
    expect(refunds(db)).toEqual([expect.objectContaining({ a: 300 })]);
    expect(chargeStatus(db)).toBe('succeeded');
    expect(sub(db)).toEqual({ p: 'growth', s: 'active' });
    expect(alerts().some(a => a.body.includes('Partial'))).toBe(true);
  });

  it('a refund of an OLD charge (not the one behind the current plan) revokes nothing', async () => {
    const db = rig();
    await applyWebhookEvent(
      'stub',
      refundHook({ merchantOrderId: OLD, providerRef: 'txn-rf-old', eventId: 'txn-rf-old:SUCCESS' })
    );
    expect(chargeStatus(db, OLD)).toBe('refunded');
    expect(sub(db)).toEqual({ p: 'growth', s: 'active' });
  });

  it('a refund that matches no charge is not dropped silently: P1', async () => {
    const db = rig();
    await applyWebhookEvent(
      'stub',
      refundHook({
        merchantOrderId: '99999999-9999-4999-8999-999999999999',
        providerRef: 'txn-x',
        eventId: 'txn-x:SUCCESS',
      })
    );
    expect(refunds(db)).toEqual([]);
    expect(alerts()).toContainEqual(
      expect.objectContaining({
        level: 'p1',
        title: expect.stringContaining('matches no Ebda Store charge'),
      })
    );
  });
});

describe('daily reversal reconcile (chargebacks no webhook reports)', () => {
  it('books a chargeback found on the gateway record once, and revokes the plan', async () => {
    const db = rig();
    const stub = new StubBillingProvider();
    stub.outOfBandReversals.set('txn-pay', {
      reversals: [{ ref: 'txn-cb-1', operation: 'chargeback', amountMinor: 1000 }],
      unknownOperations: [],
    });
    expect(await reconcileGatewayReversals(new Date(), stub)).toMatchObject({ booked: 1 });
    expect(refunds(db)).toEqual([{ a: 1000, r: 'txn-cb-1', c: CHARGE, s: 'succeeded' }]);
    expect(sub(db)).toEqual({ p: 'free', s: 'canceled' });
    expect(alerts().some(a => a.title.includes('chargeback'))).toBe(true);
    // tomorrow's run finds the same reversal: nothing more (charge is refunded, and the ref is booked)
    expect(await reconcileGatewayReversals(new Date(), stub)).toMatchObject({ booked: 0 });
    expect(refunds(db)).toHaveLength(1);
  });

  it('a webhook-booked refund is not booked again by the reconcile (same gateway id)', async () => {
    const db = rig();
    await applyWebhookEvent('stub', refundHook({ amountMinor: 300 }));
    const stub = new StubBillingProvider();
    stub.outOfBandReversals.set('txn-pay', {
      reversals: [{ ref: 'txn-rf-1', operation: 'refund', amountMinor: 300 }],
      unknownOperations: [],
    });
    expect(await reconcileGatewayReversals(new Date(), stub)).toMatchObject({ booked: 0 });
    expect(refunds(db)).toHaveLength(1);
  });

  it('an operation the code does not know pages a person (never read as "nothing happened")', async () => {
    rig();
    const stub = new StubBillingProvider();
    stub.outOfBandReversals.set('txn-pay', { reversals: [], unknownOperations: ['retrieval'] });
    await reconcileGatewayReversals(new Date(), stub);
    expect(alerts().some(a => a.body.includes('retrieval'))).toBe(true);
  });
});

describe('an Ebda-started refund is never booked a second time as out-of-band (one identity: the gateway ref)', () => {
  const ebdaRefund = (db: DatabaseSync, over: { status: string; ref: string | null }) =>
    db
      .prepare(
        `INSERT INTO billing_events (id, store_id, type, plan_code, amount_minor, provider, provider_ref, idempotency_key, status, related_event_id, created_at) VALUES ('55555555-5555-4555-8555-555555555555', ?, 'refund', 'growth', 1000, 'stub', ?, ?, ?, ?, ?)`
      )
      .run(STORE, over.ref, `refund:${CHARGE}:1`, over.status, CHARGE, Date.now() - 60_000);

  it('race: the webhook beats the refund API response -> it attaches to the pending Ebda row, no second booking, plan untouched', async () => {
    const db = rig();
    ebdaRefund(db, { status: 'pending', ref: null });
    const out = await applyWebhookEvent('stub', refundHook());
    expect(out).toMatchObject({ outcome: 'processed', detail: 'attached_to_ebda_refund' });
    expect(refunds(db)).toEqual([{ a: 1000, r: 'txn-rf-1', c: CHARGE, s: 'succeeded' }]);
    expect(sub(db)).toEqual({ p: 'growth', s: 'active' }); // an Ebda refund is a super-admin decision, no auto-revoke
  });

  it('race with a different amount: not booked, the gateway is asked to redeliver (retryable 503)', async () => {
    const db = rig();
    ebdaRefund(db, { status: 'pending', ref: null });
    await expect(applyWebhookEvent('stub', refundHook({ amountMinor: 400 }))).rejects.toMatchObject(
      {
        statusCode: 503,
        code: 'REFUND_NOT_YET_RECORDED',
      }
    );
    expect(refunds(db)).toHaveLength(1);
  });

  it('a succeeded Ebda refund + its webhook (another delivery) -> no second booking, plan untouched', async () => {
    const db = rig();
    ebdaRefund(db, { status: 'succeeded', ref: 'txn-rf-1' });
    expect(await applyWebhookEvent('stub', refundHook())).toMatchObject({
      outcome: 'ignored',
      detail: 'refund_already_booked',
    });
    expect(refunds(db)).toHaveLength(1);
    expect(sub(db)).toEqual({ p: 'growth', s: 'active' });
  });

  it('a succeeded Ebda refund with no gateway ref cannot be told apart -> nothing booked, P1', async () => {
    const db = rig();
    ebdaRefund(db, { status: 'succeeded', ref: null });
    expect(await applyWebhookEvent('stub', refundHook())).toMatchObject({
      detail: 'refund_ambiguous',
    });
    expect(refunds(db)).toHaveLength(1);
    expect(sub(db)).toEqual({ p: 'growth', s: 'active' });
    expect(alerts().some(a => a.title.includes('may duplicate'))).toBe(true);
  });

  it('reconcile: an Ebda refund the gateway lists is not booked again', async () => {
    const db = rig();
    ebdaRefund(db, { status: 'succeeded', ref: 'txn-rf-1' });
    const stub = new StubBillingProvider();
    stub.outOfBandReversals.set('txn-pay', {
      reversals: [{ ref: 'txn-rf-1', operation: 'refund', amountMinor: 1000 }],
      unknownOperations: [],
    });
    expect(await reconcileGatewayReversals(new Date(), stub)).toMatchObject({ booked: 0 });
    expect(refunds(db)).toHaveLength(1);
    expect(sub(db)).toEqual({ p: 'growth', s: 'active' });
  });
});
