import { beforeAll, describe, expect, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';
import {
  applyGrantsBatchD1,
  claimRestoreD1,
  commitManualPaymentD1,
  insertCappedGrant,
  revokeGrantsD1,
} from '../src/services/platform/billing-d1';

// M-082 (FOUNDING-1, free-month grants) on the REAL platform D1 schema: the D1 port of tests/integration/billing-grants.test.ts
// (Postgres-only). The invariants live in the D1 statements: the founding cap and the referrer cap are inside the INSERT, a replay
// is `ON CONFLICT DO NOTHING`, applying a grant moves the paid period by exactly one month ONCE, and revoke / restore are one-shot.
const e = env as unknown as { PLATFORM_DB: D1Database; TEST_PLATFORM_MIGRATIONS: unknown[] };
// the two caps and the period arithmetic (services/billing/grants.service.ts FOUNDING_SLOTS / REFERRER_MAX_GRANTS)
const FOUNDING_SLOTS = 20;
const REFERRER_MAX_GRANTS = 3;
const T0 = Date.UTC(2027, 0, 15, 12);
const T1 = Date.UTC(2027, 1, 15, 12);
let seq = 0;
const uid = (l: string) => `${l}-${++seq}`;

const grant = (over: Partial<Parameters<typeof insertCappedGrant>[0]> = {}) => ({
  id: crypto.randomUUID(),
  kind: 'founding',
  beneficiaryId: uid('store'),
  counterpartId: null,
  valueMinor: 349_000,
  key: uid('key'),
  sourceEventId: uid('ev'),
  sourceStoreId: uid('src'),
  ...over,
});
const count = async (where: string, ...p: unknown[]) =>
  (
    (await e.PLATFORM_DB.prepare(`SELECT COUNT(*) AS n FROM billing_grants WHERE ${where}`)
      .bind(...p)
      .first()) as { n: number }
  ).n;
// billing_grants is append-only (a trigger refuses DELETE), so tests never reset it: every id is unique per test and the global
// founding cap is expressed relative to the live founding rows already there (`base`).
const liveFounding = () => count(`kind = 'founding' AND status <> 'revoked'`);

describe('M-082 billing grants on D1', () => {
  beforeAll(async () => {
    setCfBindings(e as unknown as CfBindings);
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    // store_subscriptions has foreign keys to stores and plans
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
      )
        .bind(
          `plan-${p.code}`,
          p.code,
          p.nameEn,
          p.nameAr,
          p.featureTier,
          JSON.stringify(p.limits),
          p.priceMonthlyMinor,
          p.priceYearlyMinor
        )
        .run();
  });

  it('the founding cap holds under concurrency: 19 taken, 8 concurrent first payers, exactly one takes slot 20', async () => {
    const max = (await liveFounding()) + FOUNDING_SLOTS;
    for (let i = 0; i < FOUNDING_SLOTS - 1; i++)
      expect(await insertCappedGrant(grant(), { kind: 'founding', max })).toBe(true);
    const r = await Promise.all(
      Array.from({ length: 8 }, () => insertCappedGrant(grant(), { kind: 'founding', max }))
    );
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await liveFounding()).toBe(max);
  });

  it('a revoked founding grant frees its slot (the cap counts live grants only)', async () => {
    const ev = uid('ev-free-slot');
    const max = (await liveFounding()) + 2;
    expect(await insertCappedGrant(grant({ sourceEventId: ev }), { kind: 'founding', max })).toBe(
      true
    );
    expect(await insertCappedGrant(grant(), { kind: 'founding', max })).toBe(true);
    expect(await insertCappedGrant(grant(), { kind: 'founding', max })).toBe(false);
    expect(await revokeGrantsD1(ev, 'payment_refunded', new Date())).toHaveLength(1);
    expect(await insertCappedGrant(grant(), { kind: 'founding', max })).toBe(true);
  });

  it('a referrer is rewarded for at most 3 referrals even when 10 referred stores pay at once', async () => {
    const referrer = uid('ref-store');
    const r = await Promise.all(
      Array.from({ length: 10 }, () =>
        insertCappedGrant(grant({ kind: 'referral_referrer', beneficiaryId: referrer }), {
          kind: 'referral_referrer',
          beneficiaryId: referrer,
          max: REFERRER_MAX_GRANTS,
        })
      )
    );
    expect(r.filter(Boolean)).toHaveLength(REFERRER_MAX_GRANTS);
    expect(await count(`kind = 'referral_referrer' AND beneficiary_id = ?`, referrer)).toBe(
      REFERRER_MAX_GRANTS
    );
  });

  it('a replayed payment grants nothing: the same idempotency key inserts once, 12 concurrent replays included', async () => {
    const g = grant();
    const r = await Promise.all(
      Array.from({ length: 12 }, () =>
        insertCappedGrant({ ...g, id: crypto.randomUUID() }, { kind: 'founding', max: 1_000_000 })
      )
    );
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await count(`idempotency_key = ?`, g.key)).toBe(1);
  });

  async function storeWithPendingGrant(store: string) {
    await e.PLATFORM_DB.prepare(
      'INSERT INTO stores (id, name, slug, owner_id) VALUES (?1, ?1, ?1, ?2)'
    )
      .bind(store, 'owner-1')
      .run();
    await e.PLATFORM_DB.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status, current_period_start, current_period_end, updated_at) VALUES (?1, ?2, 'growth', 'active', ?3, ?4, 1)`
    )
      .bind(`sub-${store}`, store, Date.UTC(2026, 11, 15, 12), T0)
      .run();
    const g = grant({ beneficiaryId: store });
    await insertCappedGrant(g, { kind: 'founding', max: 1_000_000 });
    return g;
  }
  const periodEnd = async (store: string) =>
    (
      (await e.PLATFORM_DB.prepare(
        `SELECT current_period_end AS t FROM store_subscriptions WHERE store_id = ?`
      )
        .bind(store)
        .first()) as { t: number }
    ).t;
  const batch = (store: string, id: string, now = new Date()) =>
    applyGrantsBatchD1({
      storeId: store,
      status: 'active',
      currentPeriodEnd: new Date(T0),
      trialEndsAt: null,
      grants: [{ id, before: new Date(T0), after: new Date(T1) }],
      trialing: false,
      now,
    });

  it('applying a grant moves the paid period by exactly one month, ONCE, even when 6 sweeps race', async () => {
    const store = 'apply-once';
    const g = await storeWithPendingGrant(store);
    const r = await Promise.all(Array.from({ length: 6 }, () => batch(store, g.id)));
    expect(r.reduce((s, n) => s + n, 0)).toBe(1);
    expect(await periodEnd(store)).toBe(T1);
    expect(await count(`id = ? AND status = 'applied' AND period_end_after = ?`, g.id, T1)).toBe(1);
  });

  it('a stale apply (the subscription moved under it, e.g. a renewal) changes nothing and the grant stays pending', async () => {
    const store = 'apply-stale';
    const g = await storeWithPendingGrant(store);
    await e.PLATFORM_DB.prepare(
      `UPDATE store_subscriptions SET current_period_end = ?1 WHERE store_id = ?2`
    )
      .bind(T0 + 86_400_000, store)
      .run();
    expect(await batch(store, g.id)).toBe(0);
    expect(await periodEnd(store)).toBe(T0 + 86_400_000);
    expect(await count(`id = ? AND status = 'pending'`, g.id)).toBe(1);
  });

  it('revoking the grants of a refunded payment is one-shot, and restoring a revoked applied grant is claimed once', async () => {
    const store = 'revoke-restore';
    const g = await storeWithPendingGrant(store);
    expect(await batch(store, g.id)).toBe(1);
    const now = new Date();
    const first = await revokeGrantsD1(g.sourceEventId, 'payment_refunded', now);
    expect(first.map(r => r.id)).toEqual([g.id]);
    expect(await revokeGrantsD1(g.sourceEventId, 'payment_refunded', now)).toEqual([]);
    const claims = await Promise.all(Array.from({ length: 6 }, () => claimRestoreD1(g.id, now)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toEqual({ before: new Date(T0), after: new Date(T1) });
  });
});

// S3-M1 (support): the D1 half of "record a manual payment" that a refund / void later reverses. One atomic batch writes the ledger
// row and the subscription; a replay of the same key is 'duplicate' and writes nothing; a stale compare-and-set is 'conflict'.
describe('S3-M1 manual payment commit on D1', () => {
  const pay = (store: string, key: string, expected: Date | null, eventId = crypto.randomUUID()) =>
    commitManualPaymentD1({
      eventId,
      idempotencyKey: key,
      storeId: store,
      subscriptionId: null,
      planCode: 'growth',
      interval: 'monthly',
      periodStart: new Date(T0),
      periodEnd: new Date(T1),
      amountMinor: 100_000,
      providerRef: key,
      vatMinor: 0,
      vat: null,
      raw: { periodStart: new Date(T0).toISOString() },
      anchorDay: 15,
      billingMethod: 'instapay',
      expectedSubUpdatedAt: expected,
      now: new Date(),
    });
  const events = async (store: string) =>
    (
      (await e.PLATFORM_DB.prepare('SELECT COUNT(*) AS n FROM billing_events WHERE store_id = ?')
        .bind(store)
        .first()) as { n: number }
    ).n;
  it('a first payment is applied (ledger row + active subscription), its replay is a duplicate that writes nothing, a stale CAS is a conflict', async () => {
    const store = uid('pay-store');
    await e.PLATFORM_DB.prepare(
      'INSERT INTO stores (id, name, slug, owner_id) VALUES (?1, ?1, ?1, ?2)'
    )
      .bind(store, 'owner-1')
      .run();
    const outcome = await pay(store, `k-${store}`, null);
    expect(outcome).toBe('applied');
    expect(await events(store)).toBe(1);
    const sub = (await e.PLATFORM_DB.prepare(
      'SELECT status, current_period_end AS e, updated_at AS u FROM store_subscriptions WHERE store_id = ?'
    )
      .bind(store)
      .first()) as { status: string; e: number; u: number };
    expect(sub).toMatchObject({ status: 'active', e: T1 });
    expect(await pay(store, `k-${store}`, new Date(sub.u))).toBe('duplicate');
    expect(await events(store)).toBe(1);
    expect(await pay(store, `k2-${store}`, new Date(sub.u - 5))).toBe('conflict');
    expect(await events(store)).toBe(1);
    expect(await pay(store, `k3-${store}`, new Date(sub.u))).toBe('applied');
    expect(await events(store)).toBe(2);
  });
});
