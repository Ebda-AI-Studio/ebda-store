/**
 * Signup funnel, card-on-file half (Ruling EBDA-FUNNEL-1..14), on the PLATFORM D1 (ported from tests/integration/signup-funnel.test.ts,
 * which ran against a live relational database): card saved with nothing charged -> 14-day Growth trial -> go-live gate -> trial-end
 * charge / dunning, replay and kind-mismatch guards. Same rig as tests/unit/subscription-billing-d1.test.ts (real platform
 * migrations on node:sqlite as D1, cutover markers set). Subscriptions are created as onboarding does (a free row, then
 * `startSignupTrial`), not through provisioning, which is a store-create concern covered by workers-test/merchant-signup.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// The store's contact row (name, settings, owner e-mail) is not billing data: it is read from the directory row of the D1 `stores`
// table plus a fixed owner, so the billing models under test (plan, subscription, ledger, webhook inbox) all run on the D1.
const dir = vi.hoisted(() => ({
  row: (_id: string): Record<string, unknown> | undefined => undefined,
}));
const scope = (db: object) =>
  new Proxy(db, {
    get(t, p) {
      if (p !== 'store') return (t as Record<string | symbol, unknown>)[p];
      const one = async (a: { where: { id: string } }) => {
        const r = dir.row(a.where.id);
        return r
          ? {
              id: r.id,
              name: r.name,
              status: r.status,
              settings: {},
              billingSuspendedReason: null,
              billingSuspendedAt: null,
              owner: { email: `owner-${String(r.id)}@test.local`, firstName: 'Bill' },
            }
          : null;
      };
      return { findUnique: one, findUniqueOrThrow: one };
    },
  });
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // No tenant transaction exists on the platform D1: a scope is just the routed client, as in production after the cutover.
  return {
    ...real,
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(scope(real.prisma)),
    withUser: (_id: string, fn: (tx: unknown) => unknown) => fn(scope(real.prisma)),
    runInTenantContext: (_id: unknown, fn: () => unknown) => fn(),
    currentStoreId: () => undefined,
  };
});
const storeWrites = vi.hoisted(() => ({
  apply: (_id: string, _d: Record<string, unknown>): void => undefined,
}));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeUpdate: async (
    _db: unknown,
    a: { where: { id: string }; data: Record<string, unknown> }
  ) => {
    storeWrites.apply(a.where.id, a.data);
    return {};
  },
}));
import { prisma } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import {
  StubBillingProvider,
  STUB_WEBHOOK_SECRET,
  setBillingProviderForTests,
} from '../../apps/api/src/services/billing';
import {
  applyWebhookEvent,
  getSubscriptionBillingState,
  handleBillingWebhook,
  renewSubscription,
  runBillingCycle,
  selectTrialPlan,
  startCardSetup,
  startCheckout,
} from '../../apps/api/src/services/billing/subscription-billing.service';
import { startSignupTrial } from '../../apps/api/src/services/billing/trial';
import { assertStoreMayGoLive } from '../../apps/api/src/services/billing/go-live-gate';
import { addDays } from '../../apps/api/src/services/billing/period';
import { EmailService } from '../../apps/api/src/services/email.service';
import { socketService } from '../../apps/api/src/services/socket.service';

// Card paths are exercised explicitly; the product default is InstaPay-only.
process.env.BILLING_TRIAL_CARD_MODE = 'card_on_file';

const stub = new StubBillingProvider();
const created = { stores: [] as string[] };
const DAY = 86_400_000;
const T0 = new Date('2026-11-03T04:00:00.000Z');

const MIG = fs
  .readdirSync(new URL('../../packages/cf-schema/migrations/platform/', import.meta.url))
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');
let raw: DatabaseSync;
function installD1() {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(MIG);
  const stmt = (sql: string, v: unknown[]) => {
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql))
      return { results: raw.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } };
    return {
      results: [],
      meta: { changes: Number(raw.prepare(sql).run(...(v as never[])).changes) },
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
      raw.exec('BEGIN');
      try {
        const out = list.map(x => x.__run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  for (const family of ['billing', 'access', 'platform', 'payments'])
    raw
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES (?, ?, '{}')`)
      .run(`m-${family}`, cutoverKey(family as never));
  // plans are platform data (imported in production): the locked catalog, with its real prices
  for (const [i, p] of DEFAULT_PLAN_SEEDS.entries())
    raw
      .prepare(
        `INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, price_monthly_minor, price_yearly_minor, feature_tier, limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `plan-${p.code}`,
        p.code,
        p.nameEn,
        p.nameAr,
        i,
        p.isPublic ? 1 : 0,
        p.priceMonthlyMinor,
        p.priceYearlyMinor,
        p.featureTier,
        JSON.stringify(p.limits)
      );
  // FOUNDING-1: the first 20 paying stores get a free month, which moves a period end; fill the 20 slots with inert rows so the
  // exact period ends below do not depend on that global counter (the same filler the relational suite used).
  for (let g = 1; g <= 20; g++)
    raw
      .prepare(
        `INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key) VALUES (?, 'founding', ?, 1, 'applied', ?)`
      )
      .run(`filler-${g}`, `test-filler-${g}`, `founding:test-filler-${g}`);
  dir.row = id => raw.prepare('SELECT * FROM stores WHERE id = ?').get(id) as never;
  storeWrites.apply = (id, data) => {
    if (typeof data.plan === 'string')
      raw.prepare('UPDATE stores SET plan = ? WHERE id = ?').run(data.plan, id);
  };
  setCfBindings({ PLATFORM_DB: d1 } as never);
}

async function makeStore() {
  const id = crypto.randomUUID().slice(0, 10);
  const storeId = crypto.randomUUID();
  raw
    .prepare(`INSERT INTO stores (id, name, slug, owner_id, status) VALUES (?, ?, ?, ?, 'active')`)
    .run(storeId, `bill-${id}`, `bill-${id}`, crypto.randomUUID());
  created.stores.push(storeId);
  return storeId;
}

const sub = (storeId: string) => prisma.storeSubscription.findUniqueOrThrow({ where: { storeId } });
const ledger = (storeId: string) =>
  prisma.billingEvent.findMany({ where: { storeId }, orderBy: { createdAt: 'asc' } });
const storeRow = async (id: string) =>
  raw.prepare('SELECT plan FROM stores WHERE id = ?').get(id) as { plan: string };
const planPrice = async (code: string, interval: 'monthly' | 'yearly') => {
  const p = await prisma.plan.findUniqueOrThrow({ where: { code } });
  return interval === 'yearly' ? p.priceYearlyMinor! : p.priceMonthlyMinor!;
};

/** A self-serve store on the signup trial, as onboarding creates it (free row, then the Growth trial with the chosen plan). */
async function trialStore(
  _tag: string,
  choice: { planCode: string; interval: 'monthly' | 'yearly' } = {
    planCode: 'growth',
    interval: 'monthly',
  }
) {
  const storeId = await makeStore();
  raw.prepare(`UPDATE stores SET status = 'inactive' WHERE id = ?`).run(storeId);
  await prisma.storeSubscription.create({
    data: { storeId, planCode: 'free', status: 'active' },
  });
  await startSignupTrial(prisma, storeId, choice);
  return { storeId };
}

/** Plays a signed stub delivery through the real verify + dedupe + settle path. */
async function deliver(payload: Parameters<typeof StubBillingProvider.signedWebhook>[0]) {
  const { rawBody, headers } = StubBillingProvider.signedWebhook(payload, STUB_WEBHOOK_SECRET);
  return handleBillingWebhook('stub', rawBody, headers);
}

async function saveCard(storeId: string, token = `tok_ok_${crypto.randomUUID().slice(0, 6)}`) {
  const { billingEventId } = await startCardSetup({ storeId, provider: stub });
  const res = await deliver({
    id: `evt_${billingEventId}_saved`,
    type: 'card.saved',
    merchantOrderId: billingEventId,
    chargeId: null,
    amountMinor: 0,
    token,
    last4: '4242',
    brand: 'visa',
  });
  return { billingEventId, res };
}

let emailSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  installD1();
  resetCutoverCache();
  registerPlatformRouter();
  setBillingProviderForTests(stub);
});
beforeEach(() => {
  stub.reset();
  emailSpy = vi.spyOn(EmailService, 'sendSubscriptionBillingNotice').mockResolvedValue(undefined);
  vi.spyOn(socketService, 'notifyStore').mockImplementation(() => undefined);
});
afterAll(() => {
  setBillingProviderForTests(null);
  clearCfBindings();
});

describe('signup funnel on the platform D1: card on file (nothing charged) -> 14-day Growth trial -> day 15 charge', () => {
  it('happy path: Basic yearly chosen, trial on Growth, card saved free, charged Basic yearly at trial end', async () => {
    const { storeId } = await trialStore('happy', { planCode: 'basic', interval: 'yearly' });
    let s = await sub(storeId);
    expect(s).toMatchObject({
      planCode: 'growth',
      status: 'trialing',
      pendingPlanCode: 'basic',
      billingInterval: 'yearly',
    });

    // Go-live refused before a card (server gate).
    await expect(assertStoreMayGoLive(storeId)).rejects.toMatchObject({
      statusCode: 402,
      code: 'PAYMENT_METHOD_REQUIRED',
    });

    const before = Date.now();
    const { billingEventId, res } = await saveCard(storeId);
    expect(res.outcome).toBe('processed');
    expect(stub.chargeCalls).toHaveLength(0); // NOTHING charged
    const setupRow = (await ledger(storeId)).find(r => r.id === billingEventId)!;
    expect(setupRow).toMatchObject({ type: 'card_setup', amountMinor: 0, status: 'succeeded' });
    expect(JSON.stringify(setupRow.raw)).not.toContain('tok_ok_'); // token never persisted raw

    s = await sub(storeId);
    expect(s).toMatchObject({
      billingMethod: 'card',
      provider: 'stub',
      paymentMethodLast4: '4242',
      paymentMethodBrand: 'visa',
    });
    expect(s.providerPaymentMethodRef).toBeTruthy();
    // Trial clock restarts at the first card (EBDA-FUNNEL-4).
    expect(s.trialEndsAt!.getTime()).toBeGreaterThanOrEqual(before + 14 * DAY - 5_000);

    const state = await getSubscriptionBillingState(storeId);
    expect(state.card).toMatchObject({ last4: '4242', brand: 'visa' });
    expect(state.nextCharge).toMatchObject({
      planCode: 'basic',
      amountMinor: await planPrice('basic', 'yearly'),
    });

    await expect(assertStoreMayGoLive(storeId)).resolves.toMatchObject({
      ok: true,
      reason: 'trial_with_card',
    });

    const trialEnd = s.trialEndsAt!;
    const r = await renewSubscription(s.id, new Date(trialEnd.getTime() + 3_600_000), stub);
    expect(r).toMatchObject({ action: 'charged', status: 'succeeded' });
    expect(stub.chargeCalls).toHaveLength(1);
    expect(stub.chargeCalls[0].amountMinor).toBe(await planPrice('basic', 'yearly'));
    s = await sub(storeId);
    expect(s).toMatchObject({
      planCode: 'basic',
      status: 'active',
      billingInterval: 'yearly',
      pendingPlanCode: null,
    });
    expect(s.currentPeriodEnd!.getUTCFullYear()).toBe(trialEnd.getUTCFullYear() + 1);
    expect((await storeRow(storeId)).plan).toBe('starter'); // Basic's feature tier
  });

  it('trial-end job run twice (and concurrently) charges once', async () => {
    const { storeId } = await trialStore('twice', { planCode: 'growth', interval: 'monthly' });
    await saveCard(storeId);
    const s = await sub(storeId);
    const at = new Date(s.trialEndsAt!.getTime() + 60_000);
    const only = { subscriptionIds: [s.id] };
    await Promise.all([runBillingCycle(at, stub, only), runBillingCycle(at, stub, only)]);
    await runBillingCycle(at, stub, only);
    // Count every request, replays included: Kashier has no idempotency header,
    // so a re-sent key would be a second real charge.
    expect(stub.chargeRequests).toHaveLength(1);
    expect(stub.chargeCalls).toHaveLength(1);
    expect((await ledger(storeId)).filter(r => r.type === 'renewal')).toHaveLength(1);
    expect((await sub(storeId)).status).toBe('active');
  });

  it('a declined card at trial end goes into the existing dunning schedule', async () => {
    const { storeId } = await trialStore('decline', {
      planCode: 'business',
      interval: 'monthly',
    });
    await saveCard(storeId, 'tok_decline_card');
    const s = await sub(storeId);
    const trialEnd = s.trialEndsAt!;
    const r = await renewSubscription(s.id, new Date(trialEnd.getTime() + 60_000), stub);
    expect(r).toMatchObject({ action: 'charged', status: 'failed' });
    const after = await sub(storeId);
    expect(after).toMatchObject({
      status: 'past_due',
      dunningAttempts: 1,
      pendingPlanCode: 'business',
    });
    expect(after.nextRetryAt!.getTime()).toBe(addDays(trialEnd, 3).getTime());
    expect(emailSpy).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({
        kind: 'payment_failed',
        amountMinor: await planPrice('business', 'monthly'),
      }),
      expect.anything()
    );
    // Day 3 retry is a NEW key; the day-0 key is never re-sent.
    await renewSubscription(s.id, addDays(trialEnd, 3), stub);
    expect(stub.chargeCalls.map(c => c.idempotencyKey)).toEqual([
      expect.stringContaining(':trial-end:'),
      expect.stringContaining(':retry1'),
    ]);
  });

  it('a card.saved replay is a no-op (card + trial dates unchanged)', async () => {
    const { storeId } = await trialStore('replay');
    const { billingEventId } = await saveCard(storeId);
    const first = await sub(storeId);
    const again = await deliver({
      id: `evt_${billingEventId}_saved`,
      type: 'card.saved',
      merchantOrderId: billingEventId,
      chargeId: null,
      amountMinor: 0,
      token: 'tok_other',
      last4: '1111',
    });
    expect(again.duplicate).toBe(true);
    const second = await sub(storeId);
    expect(second.providerPaymentMethodRef).toBe(first.providerPaymentMethodRef);
    expect(second.paymentMethodLast4).toBe('4242');
    expect(second.trialEndsAt!.getTime()).toBe(first.trialEndsAt!.getTime());
  });

  it('a card.saved delivery cannot settle a paid checkout, nor a charge settle a card setup', async () => {
    const { storeId } = await trialStore('mismatch');
    await prisma.storeSubscription.update({
      where: { storeId },
      data: { status: 'canceled', planCode: 'free' },
    });
    const { billingEventId: checkoutId } = await startCheckout({
      storeId,
      planCode: 'business',
      provider: stub,
    });
    const r1 = await deliver({
      id: `evt_${checkoutId}_card`,
      type: 'card.saved',
      merchantOrderId: checkoutId,
      chargeId: null,
      amountMinor: null,
      token: 'tok_x',
    });
    expect(r1).toMatchObject({ outcome: 'ignored', detail: 'kind_mismatch' });
    expect((await sub(storeId)).status).toBe('canceled'); // NOT activated without money
    expect((await ledger(storeId)).find(r => r.id === checkoutId)!.status).toBe('pending');

    const { storeId: s2 } = await trialStore('mismatch2');
    const { billingEventId: setupId } = await startCardSetup({ storeId: s2, provider: stub });
    const r2 = await deliver({
      id: `evt_${setupId}_charge`,
      type: 'charge.succeeded',
      merchantOrderId: setupId,
      chargeId: 'ch_1',
      amountMinor: 0,
      token: 'tok_y',
    });
    expect(r2).toMatchObject({ outcome: 'ignored', detail: 'kind_mismatch' });
    expect((await sub(s2)).providerPaymentMethodRef).toBeNull();
  });

  it('card.saved without a token saves nothing and the store still cannot go live', async () => {
    const { storeId } = await trialStore('notoken');
    const { billingEventId } = await startCardSetup({ storeId, provider: stub });
    await applyWebhookEvent('stub', {
      eventId: `evt_${billingEventId}_nt`,
      kind: 'card.saved',
      merchantOrderId: billingEventId,
      providerRef: null,
      amountMinor: 0,
      currency: 'EGP',
      occurredAt: new Date(),
      raw: {},
    });
    expect((await ledger(storeId)).find(r => r.id === billingEventId)).toMatchObject({
      status: 'failed',
      failureReason: 'card_setup_without_token',
    });
    expect((await sub(storeId)).providerPaymentMethodRef).toBeNull();
    await expect(assertStoreMayGoLive(storeId)).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_REQUIRED',
    });
  });

  it('the chosen plan can change during the trial (public priced plans only)', async () => {
    const { storeId } = await trialStore('change');
    await selectTrialPlan({ storeId, planCode: 'business', interval: 'yearly' });
    expect(await sub(storeId)).toMatchObject({
      pendingPlanCode: 'business',
      billingInterval: 'yearly',
    });
    await expect(
      selectTrialPlan({ storeId, planCode: 'comped', interval: 'monthly' })
    ).rejects.toMatchObject({
      code: 'PLAN_NOT_PURCHASABLE',
    });
  });

  it('an expired trial cannot go live; a comped store can', async () => {
    const { storeId } = await trialStore('expired');
    await saveCard(storeId);
    await prisma.storeSubscription.update({
      where: { storeId },
      data: { trialEndsAt: new Date(Date.now() - DAY) },
    });
    await expect(assertStoreMayGoLive(storeId)).rejects.toMatchObject({ code: 'TRIAL_EXPIRED' });
    await prisma.storeSubscription.update({
      where: { storeId },
      data: { planCode: 'comped', status: 'comped' },
    });
    await expect(assertStoreMayGoLive(storeId)).resolves.toMatchObject({ reason: 'granted' });
  });
});
