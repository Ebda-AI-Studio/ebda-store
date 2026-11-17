/**
 * SP5 task 3 — EGP subscription billing against a real Postgres.
 *
 * Covers: null-price refusal, checkout -> webhook activation, idempotent
 * renewal (cron twice = one charge), the dunning schedule to downgrade,
 * webhook replay (one ledger row), out-of-order deliveries, comped never
 * charged, cancel/upgrade/downgrade, refunds, the append-only ledger and the
 * raw-body webhook endpoint.
 *
 * Mutation proofs (run by hand, recorded in the commit body):
 *   1. subscription-billing.service.ts `claimEvent`: drop `skipDuplicates`
 *      handling (always return the id) -> "cron run twice" and "a claimed key is
 *      never re-sent" fail (two provider calls / two ledger rows).
 *   2. kashier.provider.ts verifyWebhook: replace the `safeEqual` check with
 *      `true` -> tests/unit/billing-kashier-provider.test.ts bad/tampered cases
 *      fail AND the endpoint test below (401 on a forged delivery) fails.
 *   3. settleInTx: change the failed branch's `where: { status: 'pending' }` to
 *      `status: { in: ['pending','succeeded'] }` -> "a late failed webhook
 *      after succeeded" fails (store downgraded / row flipped).
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { prisma, withRlsBypass } from '@ebda/database';
import { exhaustFoundingSlots } from '../helpers/exhaust-founding-slots';
import { planLimitsSchema } from '@ebda/shared';
import {
  StubBillingProvider,
  setBillingProviderForTests,
} from '../../apps/api/src/services/billing';
import {
  applyWebhookEvent,
  cancelSubscription,
  changePlan,
  getSubscriptionBillingState,
  termBasisOf,
  findDueSubscriptionIds,
  listLedger,
  listStoreCharges,
  refundCharge,
  renewSubscription,
  runBillingCycle,
  sweepStuckCharges,
  startCheckout,
  handleBillingWebhook,
} from '../../apps/api/src/services/billing/subscription-billing.service';
import {
  KashierBillingProvider,
  kashierSignaturePayload,
} from '../../apps/api/src/services/billing/kashier.provider';
import { addDays, addInterval } from '../../apps/api/src/services/billing/period';
import { encryption } from '../../apps/api/src/services/encryption.service';
import { EmailService } from '../../apps/api/src/services/email.service';
import { socketService } from '../../apps/api/src/services/socket.service';
import { errorHandler } from '../../apps/api/src/middleware/error-handler';
import billingWebhookRoutes from '../../apps/api/src/routes/billing-webhook.routes';

// Card paths are exercised explicitly; the product default is InstaPay-only.
process.env.BILLING_TRIAL_CARD_MODE = 'card_on_file';
const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const uniq = crypto.randomUUID().slice(0, 8);
const PRO = `bpro-${uniq}`; // 49900 / 499000
const LITE = `blite-${uniq}`; // 19999
const NOPRICE = `bnone-${uniq}`;
const stub = new StubBillingProvider();
const created = { stores: [] as string[], users: [] as string[], plans: [PRO, LITE, NOPRICE] };

const limits = planLimitsSchema.parse({
  maxProducts: 100,
  maxStaff: 2,
  maxOrdersPerMonth: 500,
  maxStorageMb: 100,
  customDomain: true,
  platformFeeBps: 100,
  abandonedCartAutomation: false,
  whatsappAutomation: false,
  maxStores: 1,
  brandingRemoval: false,
  apiAccess: false,
  analyticsTier: 'basic',
  supportTier: 'email',
});

const T0 = new Date('2026-11-03T04:00:00.000Z');

async function makeStore() {
  const id = crypto.randomUUID().slice(0, 10);
  const user = await prisma.user.create({
    data: {
      email: `bill-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'Bill',
      lastName: 'Ing',
      role: 'store_admin',
    },
  });
  const store = await prisma.store.create({
    data: { name: `bill-${id}`, slug: `bill-${id}`, ownerId: user.id, status: 'active' },
  });
  created.users.push(user.id);
  created.stores.push(store.id);
  return store.id;
}

/** A store already subscribed (as if checkout had completed) with a saved card. */
async function subscribedStore(opts: {
  planCode?: string;
  periodEnd?: Date;
  status?: 'active' | 'past_due' | 'comped' | 'trialing';
  token?: string | null;
  interval?: 'monthly' | 'yearly';
  provider?: string | null;
  trialEndsAt?: Date | null;
}) {
  const storeId = await makeStore();
  const sub = await withRlsBypass(tx =>
    tx.storeSubscription.upsert({
      where: { storeId },
      create: {
        storeId,
        planCode: opts.planCode ?? PRO,
        status: opts.status ?? 'active',
        billingInterval: opts.interval ?? 'monthly',
        currentPeriodStart: addInterval(opts.periodEnd ?? T0, 'monthly'),
        currentPeriodEnd: opts.periodEnd ?? T0,
        trialEndsAt: opts.trialEndsAt ?? null,
        provider: opts.provider === undefined ? 'stub' : opts.provider,
        providerPaymentMethodRef:
          opts.token === null ? null : encryption.encrypt(opts.token ?? 'tok_good'),
      },
      update: {},
    })
  );
  return { storeId, subId: sub.id };
}

const getSub = (storeId: string) =>
  withRlsBypass(tx => tx.storeSubscription.findUniqueOrThrow({ where: { storeId } }));
const getSubOrNull = (storeId: string) =>
  withRlsBypass(tx => tx.storeSubscription.findUnique({ where: { storeId } }));
const ledger = (storeId: string) =>
  withRlsBypass(tx =>
    tx.billingEvent.findMany({ where: { storeId }, orderBy: { createdAt: 'asc' } })
  );
const storeTier = (storeId: string) =>
  withRlsBypass(tx =>
    tx.store.findUniqueOrThrow({ where: { id: storeId }, select: { plan: true } })
  );

/** One billing pass scoped to this store's subscription (the DB is shared across tests). */
async function cycleFor(now: Date, storeId: string) {
  const sub = await getSubOrNull(storeId);
  return runBillingCycle(now, stub, { subscriptionIds: sub ? [sub.id] : [] });
}

let emailSpy: ReturnType<typeof vi.spyOn>;
let bellSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  if (!hasDb) return;
  setBillingProviderForTests(stub);
  await exhaustFoundingSlots(sql => prisma.$executeRawUnsafe(sql));
  await prisma.plan.createMany({
    data: [
      {
        code: PRO,
        nameEn: 'BPro',
        nameAr: 'احترافي',
        sort: 900,
        isPublic: false,
        featureTier: 'professional',
        limits,
        priceMonthlyMinor: 49900,
        priceYearlyMinor: 499000,
      },
      {
        code: LITE,
        nameEn: 'BLite',
        nameAr: 'خفيف',
        sort: 901,
        isPublic: false,
        featureTier: 'starter',
        limits,
        priceMonthlyMinor: 19999,
        priceYearlyMinor: 199990,
      },
      {
        code: NOPRICE,
        nameEn: 'BNone',
        nameAr: 'بلا سعر',
        sort: 902,
        isPublic: false,
        featureTier: 'starter',
        limits,
      },
    ],
  });
});

beforeEach(() => {
  stub.reset();
  emailSpy = vi.spyOn(EmailService, 'sendSubscriptionBillingNotice').mockResolvedValue(undefined);
  bellSpy = vi.spyOn(socketService, 'notifyStore').mockImplementation(() => undefined);
});

afterAll(async () => {
  if (!hasDb) return;
  setBillingProviderForTests(null);
  await withRlsBypass(async tx => {
    // billing_events rows go with their store (FK cascade); a direct delete is refused by design.
    await tx.storeSubscription.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.store.deleteMany({ where: { id: { in: created.stores } } });
    await tx.user.deleteMany({ where: { id: { in: created.users } } });
    await tx.billingWebhookEvent.deleteMany({ where: { provider: 'stub' } });
    await tx.plan.deleteMany({ where: { code: { in: created.plans } } });
  });
});

function stubEvent(
  row: { id: string; amountMinor: number },
  kind: 'charge.succeeded' | 'charge.failed',
  extra: { id?: string; token?: string; amountMinor?: number } = {}
) {
  return StubBillingProvider.signedWebhook({
    id: extra.id ?? `evt_${row.id}_${kind}`,
    type: kind,
    merchantOrderId: row.id,
    chargeId: `ch_${row.id.slice(0, 8)}`,
    amountMinor: extra.amountMinor ?? row.amountMinor,
    currency: 'EGP',
    token: extra.token,
    failureReason: kind === 'charge.failed' ? 'declined' : undefined,
  });
}

async function deliver(
  row: { id: string; amountMinor: number },
  kind: 'charge.succeeded' | 'charge.failed',
  extra: { id?: string; token?: string; amountMinor?: number } = {},
  now = T0
) {
  const { rawBody, headers } = stubEvent(row, kind, extra);
  const ev = stub.verifyWebhook(rawBody, headers);
  return applyWebhookEvent('stub', ev, now);
}

describe.skipIf(!hasDb)('plan prices', () => {
  it('refuses to check out a plan whose price is null (clear error, no ledger row)', async () => {
    const storeId = await makeStore();
    const err = await startCheckout({ storeId, planCode: NOPRICE, provider: stub }).catch(e => e);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('PLAN_PRICE_NOT_SET');
    expect(err.message).toMatch(/price/i);
    expect(await ledger(storeId)).toHaveLength(0);
    expect(stub.checkoutCalls).toHaveLength(0);
  });

  it('the locked catalog is priced: Growth checks out at EGP 3,490/month and 31,410/year', async () => {
    const storeId = await makeStore();
    const m = await startCheckout({ storeId, planCode: 'growth', provider: stub });
    expect(m.redirectUrl).toBeTruthy();
    expect(stub.checkoutCalls.at(-1)).toMatchObject({ amountMinor: 349000, currency: 'EGP' });
    const y = await startCheckout({
      storeId,
      planCode: 'growth',
      interval: 'yearly',
      provider: stub,
    });
    expect(y.redirectUrl).toBeTruthy();
    expect(stub.checkoutCalls.at(-1)).toMatchObject({ amountMinor: 3141000, currency: 'EGP' });
  });

  it('hidden legacy plans stay unpurchasable (no price) so existing rows cannot be bought into', async () => {
    const storeId = await makeStore();
    const err = await startCheckout({ storeId, planCode: 'pro', provider: stub }).catch(e => e);
    expect(err.code).toBe('PLAN_PRICE_NOT_SET');
  });

  it('the yearly price is checked separately and free/comped are not purchasable', async () => {
    const storeId = await makeStore();
    await prisma.plan.update({ where: { code: NOPRICE }, data: { priceMonthlyMinor: 1000 } });
    const yearly = await startCheckout({
      storeId,
      planCode: NOPRICE,
      interval: 'yearly',
      provider: stub,
    }).catch(e => e);
    expect(yearly.code).toBe('PLAN_PRICE_NOT_SET');
    await prisma.plan.update({ where: { code: NOPRICE }, data: { priceMonthlyMinor: null } });
    for (const code of ['free', 'comped', 'founding_free']) {
      const e = await startCheckout({ storeId, planCode: code, provider: stub }).catch(x => x);
      expect(e.code).toBe('PLAN_NOT_PURCHASABLE');
    }
  });
});

describe.skipIf(!hasDb)('checkout -> webhook activates the plan', () => {
  it('creates a pending ledger row, redirects, and the signed webhook makes it active', async () => {
    const storeId = await makeStore();
    const out = await startCheckout({ storeId, planCode: PRO, provider: stub });
    expect(out.redirectUrl).toContain(out.billingEventId);
    expect(stub.checkoutCalls[0]).toMatchObject({ amountMinor: 49900, currency: 'EGP' });

    let rows = await ledger(storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'checkout', status: 'pending', amountMinor: 49900 });
    expect((await getSubOrNull(storeId))?.status).not.toBe('active'); // redirect alone never activates

    const res = await deliver(rows[0], 'charge.succeeded', { token: 'tok_live_123' }, T0);
    expect(res).toMatchObject({ duplicate: false, outcome: 'processed' });

    const sub = await getSub(storeId);
    expect(sub).toMatchObject({ planCode: PRO, status: 'active', provider: 'stub' });
    expect(sub.currentPeriodStart!.toISOString()).toBe(T0.toISOString());
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addInterval(T0, 'monthly').toISOString());
    // the card token is stored encrypted, never in plaintext or in the ledger
    expect(sub.providerPaymentMethodRef).not.toContain('tok_live_123');
    expect(encryption.decrypt(sub.providerPaymentMethodRef!)).toBe('tok_live_123');
    rows = await ledger(storeId);
    expect(JSON.stringify(rows[0].raw)).not.toContain('tok_live_123');
    expect(rows[0].status).toBe('succeeded');
    expect((await storeTier(storeId)).plan).toBe('professional');
  });

  it('a provider failure while creating the checkout marks the row failed and surfaces 502', async () => {
    const storeId = await makeStore();
    const broken = new StubBillingProvider();
    broken.createCheckoutForSubscription = async () => {
      throw new Error('boom');
    };
    const err = await startCheckout({ storeId, planCode: PRO, provider: broken }).catch(e => e);
    expect(err.statusCode).toBe(502);
    expect((await ledger(storeId))[0].status).toBe('failed');
  });

  it('refuses to bill a comped store', async () => {
    const { storeId } = await subscribedStore({
      planCode: 'comped',
      status: 'comped',
      token: null,
      provider: null,
    });
    const err = await startCheckout({ storeId, planCode: PRO, provider: stub }).catch(e => e);
    expect(err.code).toBe('STORE_COMPED');
  });
});

describe.skipIf(!hasDb)('webhooks: replay and out-of-order', () => {
  it('a replayed delivery leaves exactly one ledger row, one inbox row and one effect', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: stub });
    const row = { id: billingEventId, amountMinor: 49900 };
    const first = await deliver(row, 'charge.succeeded', { id: 'evt-replay-1', token: 'tok_a' });
    const second = await deliver(row, 'charge.succeeded', { id: 'evt-replay-1', token: 'tok_b' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await ledger(storeId)).toHaveLength(1);
    expect(
      await withRlsBypass(tx =>
        tx.billingWebhookEvent.count({ where: { provider: 'stub', eventId: 'evt-replay-1' } })
      )
    ).toBe(1);
    // the replay did not swap in the second token
    const sub = await getSub(storeId);
    expect(encryption.decrypt(sub.providerPaymentMethodRef!)).toBe('tok_a');
  });

  it('a late "failed" after "succeeded" for the same charge does not downgrade or flip the row', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: stub });
    const row = { id: billingEventId, amountMinor: 49900 };
    await deliver(row, 'charge.succeeded', { token: 'tok_ok' });
    const late = await deliver(row, 'charge.failed');
    expect(late.outcome).toBe('processed');
    const sub = await getSub(storeId);
    expect(sub).toMatchObject({ planCode: PRO, status: 'active' });
    expect((await ledger(storeId))[0].status).toBe('succeeded');
    expect((await storeTier(storeId)).plan).toBe('professional');
  });

  it('a late "failed" for a RENEWAL that already succeeded does not start dunning', async () => {
    const { storeId, subId } = await subscribedStore({});
    stub.pendingNextCharges(1); // gateway answers "pending"; the webhook settles it
    const r = await renewSubscription(subId, T0, stub);
    expect(r).toMatchObject({ action: 'charged', status: 'pending' });
    const row = (await ledger(storeId))[0];
    await deliver(row, 'charge.succeeded', {}, T0);
    await deliver(row, 'charge.failed', {}, T0);
    const sub = await getSub(storeId);
    expect(sub.status).toBe('active');
    expect(sub.dunningAttempts).toBe(0);
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addInterval(T0, 'monthly').toISOString());
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it('"succeeded" arriving after "failed" still settles (the money moved)', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: stub });
    const row = { id: billingEventId, amountMinor: 49900 };
    await deliver(row, 'charge.failed');
    expect((await ledger(storeId))[0].status).toBe('failed');
    await deliver(row, 'charge.succeeded', { token: 'tok_late' });
    expect((await ledger(storeId))[0].status).toBe('succeeded');
    expect((await getSub(storeId)).status).toBe('active');
  });

  it('ignores an event whose amount does not match the ledger row', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: stub });
    const res = await deliver({ id: billingEventId, amountMinor: 49900 }, 'charge.succeeded', {
      amountMinor: 100,
      token: 'tok_x',
    });
    expect(res).toMatchObject({ outcome: 'ignored', detail: 'amount_mismatch' });
    expect((await ledger(storeId))[0].status).toBe('pending');
  });

  it('acknowledges but ignores an event for an unknown order', async () => {
    const res = await deliver({ id: crypto.randomUUID(), amountMinor: 100 }, 'charge.succeeded');
    expect(res).toMatchObject({ outcome: 'ignored', detail: 'unknown_order' });
  });
});

describe.skipIf(!hasDb)('renewal is idempotent', () => {
  it('running the cycle twice charges once and renews the period once', async () => {
    const { storeId, subId } = await subscribedStore({});
    const a = await cycleFor(T0, storeId);
    const b = await cycleFor(T0, storeId);
    expect(a.charged).toBe(1);
    expect(
      stub.chargeCalls.filter(c => c.idempotencyKey === `sub:${subId}:${T0.toISOString()}`)
    ).toHaveLength(1);
    const rows = await ledger(storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'renewal',
      status: 'succeeded',
      amountMinor: 49900,
      idempotencyKey: `sub:${subId}:${T0.toISOString()}`,
    });
    expect(b.charged).toBe(0);
    const sub = await getSub(storeId);
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addInterval(T0, 'monthly').toISOString());
    expect(sub.status).toBe('active');
  });

  it('a claimed key is never re-sent: a still-pending charge blocks a second attempt', async () => {
    const { storeId, subId } = await subscribedStore({});
    stub.pendingNextCharges(1);
    expect(await renewSubscription(subId, T0, stub)).toMatchObject({ status: 'pending' });
    const again = await renewSubscription(subId, T0, stub);
    expect(again).toEqual({ action: 'skipped', reason: 'already_claimed' });
    expect(stub.chargeCalls).toHaveLength(1);
    expect(await ledger(storeId)).toHaveLength(1);
  });

  it('two concurrent runs produce one charge', async () => {
    const { storeId, subId } = await subscribedStore({});
    await Promise.all([renewSubscription(subId, T0, stub), renewSubscription(subId, T0, stub)]);
    expect(stub.chargeCalls).toHaveLength(1);
    expect(await ledger(storeId)).toHaveLength(1);
  });

  it('an unknown outcome (provider timeout) leaves the row pending and is NOT re-sent', async () => {
    const { storeId, subId } = await subscribedStore({});
    const flaky = new StubBillingProvider();
    flaky.chargeSavedCard = async () => {
      throw new (await import('../../apps/api/src/services/billing')).BillingProviderError(
        'timeout',
        false
      );
    };
    expect(await renewSubscription(subId, T0, flaky)).toMatchObject({ status: 'pending' });
    expect(await renewSubscription(subId, addDays(T0, 1), stub)).toEqual({
      action: 'skipped',
      reason: 'already_claimed',
    });
    expect(stub.chargeCalls).toHaveLength(0);
    const rows = await ledger(storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    const stuck = (await listLedger({ storeId }))[0];
    expect(stuck.stuck).toBe(false); // fresh; stuck flag appears after an hour
  });

  it('M-023: a charge the gateway really took but whose answer was lost is found by the sweep and settled once', async () => {
    const { storeId, subId } = await subscribedStore({});
    stub.timeoutNextCharges(1, true);
    expect(await renewSubscription(subId, T0, stub)).toMatchObject({ status: 'pending' });
    const later = new Date(Date.now() + 2 * 3_600_000);
    const out = await sweepStuckCharges(later, stub);
    expect(out.settled).toBeGreaterThanOrEqual(1);
    const rows = await ledger(storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect((await getSub(storeId)).currentPeriodEnd!.toISOString()).toBe(
      addInterval(T0, 'monthly').toISOString()
    );
    await sweepStuckCharges(later, stub); // idempotent
    expect(stub.chargeCalls).toHaveLength(1); // never re-sent
    expect((await getSub(storeId)).currentPeriodEnd!.toISOString()).toBe(
      addInterval(T0, 'monthly').toISOString()
    );
  });

  it('M-023: a lost DECLINE is read from the gateway and moves the subscription to past_due (dunning)', async () => {
    const { storeId, subId } = await subscribedStore({});
    stub.timeoutNextCharges(1, false);
    await renewSubscription(subId, T0, stub);
    await sweepStuckCharges(new Date(Date.now() + 2 * 3_600_000), stub);
    expect((await ledger(storeId))[0].status).toBe('failed');
    const sub = await getSub(storeId);
    expect(sub.status).toBe('past_due');
    expect(sub.nextRetryAt).not.toBeNull();
  });

  it('M-023: a provider that cannot be asked is NEVER given up on blindly: still pending after days, no retry, one P1 path', async () => {
    const { storeId, subId } = await subscribedStore({});
    const blind = new StubBillingProvider();
    blind.getChargeStatus = undefined;
    blind.timeoutNextCharges(1, true);
    await renewSubscription(subId, T0, blind);
    for (const days of [0.1, 4, 30]) {
      await sweepStuckCharges(new Date(Date.now() + days * 86_400_000), blind);
    }
    const rows = await ledger(storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending'); // a blind give-up would have sent dunning, and a new key, a second charge
    expect((await getSub(storeId)).status).toBe('active');
    expect(blind.chargeCalls).toHaveLength(1);
  });

  it('M-023: a claim the gateway has no record of (never sent) is failed and enters dunning', async () => {
    const { storeId, subId } = await subscribedStore({});
    // a claimed-but-never-sent renewal: the ledger row exists, the provider was never called
    await withRlsBypass(tx =>
      tx.billingEvent.create({
        data: {
          storeId,
          subscriptionId: subId,
          type: 'renewal',
          planCode: PRO,
          billingInterval: 'monthly',
          forPeriodEnd: T0,
          amountMinor: 49900,
          provider: 'stub',
          idempotencyKey: `sub:${subId}:${T0.toISOString()}`,
          status: 'pending',
        },
      })
    );
    await sweepStuckCharges(new Date(Date.now() + 2 * 3_600_000), stub);
    const rows = await ledger(storeId);
    expect(rows[0]).toMatchObject({ status: 'failed', failureReason: 'not_found_at_gateway' });
    expect((await getSub(storeId)).status).toBe('past_due');
  });

  it('M-023: one row that cannot be settled does not stop the rest of the sweep', async () => {
    const { storeId: a, subId: sa } = await subscribedStore({});
    const { storeId: b, subId: sb } = await subscribedStore({});
    const flaky = new StubBillingProvider();
    flaky.timeoutNextCharges(2, true);
    await renewSubscription(sa, T0, flaky);
    await renewSubscription(sb, T0, flaky);
    const real = flaky.getChargeStatus.bind(flaky);
    let first = true;
    flaky.getChargeStatus = async req => {
      if (first) {
        first = false;
        throw new Error('gateway down');
      }
      return real(req);
    };
    await sweepStuckCharges(new Date(Date.now() + 2 * 3_600_000), flaky);
    const statuses = [(await ledger(a))[0].status, (await ledger(b))[0].status].sort();
    expect(statuses).toEqual(['pending', 'succeeded']);
  });

  it('M-125: the billing day returns to the 31st after a short month', async () => {
    const jan31 = new Date('2027-01-31T04:00:00.000Z');
    const { storeId } = await subscribedStore({ periodEnd: jan31 });
    await cycleFor(jan31, storeId);
    expect((await getSub(storeId)).currentPeriodEnd!.toISOString()).toBe(
      '2027-02-28T04:00:00.000Z'
    );
    await cycleFor(new Date('2027-02-28T04:00:00.000Z'), storeId);
    const sub = await getSub(storeId);
    expect(sub.currentPeriodEnd!.toISOString()).toBe('2027-03-31T04:00:00.000Z');
    expect(sub.billingAnchorDay).toBe(31);
  });

  it('is not due before the period ends', async () => {
    const { subId } = await subscribedStore({});
    expect(await renewSubscription(subId, addDays(T0, -1), stub)).toEqual({
      action: 'skipped',
      reason: 'not_due',
    });
    expect(stub.chargeCalls).toHaveLength(0);
  });

  it('yearly subscriptions charge the yearly price and extend a year', async () => {
    const { storeId, subId } = await subscribedStore({ interval: 'yearly' });
    await renewSubscription(subId, T0, stub);
    expect(stub.chargeCalls[0].amountMinor).toBe(499000);
    expect((await getSub(storeId)).currentPeriodEnd!.toISOString()).toBe(
      addInterval(T0, 'yearly').toISOString()
    );
  });
});

describe.skipIf(!hasDb)('dunning: day 0, day 3, day 7, then downgrade', () => {
  it('follows the schedule and downgrades to free + canceled, keeping the data', async () => {
    const { storeId, subId } = await subscribedStore({});
    const only = { subscriptionIds: [subId] };
    // a product proves data is kept
    await prisma.product.create({
      data: { storeId, name: 'keep me', slug: `keep-${uniq}`, price: 1000 },
    });
    stub.declineAll = true;

    // day 0: fails -> past_due, retry in 3 days
    await cycleFor(T0, storeId);
    let sub = await getSub(storeId);
    expect(sub).toMatchObject({ status: 'past_due', dunningAttempts: 1, planCode: PRO });
    expect(sub.nextRetryAt!.toISOString()).toBe(addDays(T0, 3).toISOString());
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0][1]).toMatchObject({ kind: 'payment_failed', amountMinor: 49900 });
    expect(bellSpy).toHaveBeenCalledTimes(1);

    // day 2: nothing is due
    await cycleFor(addDays(T0, 2), storeId);
    expect(stub.chargeCalls).toHaveLength(1);

    // day 3: retry fails -> still past_due, next at day 7
    await cycleFor(addDays(T0, 3), storeId);
    sub = await getSub(storeId);
    expect(sub).toMatchObject({ status: 'past_due', dunningAttempts: 2 });
    expect(sub.nextRetryAt!.toISOString()).toBe(addDays(T0, 7).toISOString());
    expect(stub.chargeCalls).toHaveLength(2);

    // day 6: nothing
    await cycleFor(addDays(T0, 6), storeId);
    expect(stub.chargeCalls).toHaveLength(2);

    // day 7: final failure -> free + canceled
    await cycleFor(addDays(T0, 7), storeId);
    sub = await getSub(storeId);
    expect(sub).toMatchObject({
      planCode: 'free',
      status: 'canceled',
      providerPaymentMethodRef: null,
      provider: null,
      dunningAttempts: 0,
      nextRetryAt: null,
    });
    expect((await storeTier(storeId)).plan).toBe('free');
    expect(stub.chargeCalls).toHaveLength(3);
    expect(emailSpy.mock.calls.map(c => (c[1] as { kind: string }).kind)).toEqual([
      'payment_failed',
      'payment_failed',
      'downgraded',
    ]);
    expect(bellSpy).toHaveBeenCalledTimes(3);

    // data kept, three distinct ledger rows with the retry key shape
    expect(await prisma.product.count({ where: { storeId } })).toBe(1);
    const rows = await ledger(storeId);
    expect(rows.map(r => r.idempotencyKey)).toEqual([
      `sub:${subId}:${T0.toISOString()}`,
      `sub:${subId}:${T0.toISOString()}:retry1`,
      `sub:${subId}:${T0.toISOString()}:retry2`,
    ]);
    expect(rows.every(r => r.status === 'failed')).toBe(true);

    // a downgraded store is never charged again
    await cycleFor(addDays(T0, 60), storeId);
    expect(stub.chargeCalls).toHaveLength(3);
  });

  it('a successful retry returns the subscription to active and renews the period', async () => {
    const { storeId } = await subscribedStore({});
    stub.failNextCharges(1);
    await cycleFor(T0, storeId);
    expect((await getSub(storeId)).status).toBe('past_due');
    await cycleFor(addDays(T0, 3), storeId);
    const sub = await getSub(storeId);
    expect(sub).toMatchObject({ status: 'active', dunningAttempts: 0, nextRetryAt: null });
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addInterval(T0, 'monthly').toISOString());
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it('a missing card at renewal time downgrades without calling the gateway', async () => {
    const { storeId } = await subscribedStore({ token: null });
    await cycleFor(T0, storeId);
    expect((await getSub(storeId)).planCode).toBe('free');
    expect(stub.chargeCalls).toHaveLength(0);
  });
});

describe.skipIf(!hasDb)('comped is never charged', () => {
  it('skips a comped subscription even with a card on file and an expired period', async () => {
    const { storeId, subId } = await subscribedStore({
      planCode: 'comped',
      status: 'comped',
      periodEnd: addDays(T0, -30),
    });
    expect(await renewSubscription(subId, T0, stub)).toEqual({
      action: 'skipped',
      reason: 'comped',
    });
    expect(await findDueSubscriptionIds(T0)).not.toContain(subId);
    await cycleFor(T0, storeId);
    expect(stub.chargeCalls).toHaveLength(0);
    expect(await ledger(storeId)).toHaveLength(0);
  });

  it('a comped plan code is skipped even if its status was left active', async () => {
    const { subId } = await subscribedStore({ planCode: 'comped', status: 'active' });
    expect(await renewSubscription(subId, T0, stub)).toEqual({
      action: 'skipped',
      reason: 'comped',
    });
    expect(stub.chargeCalls).toHaveLength(0);
  });

  it('a plan assigned by an admin with no provider is not billed by the platform', async () => {
    const { subId } = await subscribedStore({ provider: null, token: null });
    const r = await renewSubscription(subId, T0, stub);
    expect(r).toEqual({ action: 'skipped', reason: 'not_billed_by_platform' });
    expect(stub.chargeCalls).toHaveLength(0);
  });
});

describe.skipIf(!hasDb)('trial end', () => {
  const FAR = addDays(T0, 100);

  it('trial not ended: untouched, no charge', async () => {
    const { storeId } = await subscribedStore({
      status: 'trialing',
      periodEnd: FAR,
      trialEndsAt: addDays(T0, 1),
    });
    await cycleFor(T0, storeId);
    expect(stub.chargeCalls).toHaveLength(0);
    expect(await getSub(storeId)).toMatchObject({ status: 'trialing', planCode: PRO });
  });

  it('trial ended with no card: downgraded to free + canceled, merchant notified', async () => {
    const { storeId } = await subscribedStore({
      status: 'trialing',
      periodEnd: FAR,
      trialEndsAt: T0,
      token: null,
      provider: null,
    });
    await cycleFor(T0, storeId);
    expect(await getSub(storeId)).toMatchObject({
      planCode: 'free',
      status: 'canceled',
      trialEndsAt: null,
    });
    expect((await storeTier(storeId)).plan).toBe('free');
    expect(stub.chargeCalls).toHaveLength(0);
    expect(emailSpy.mock.calls[0][1]).toMatchObject({ kind: 'downgraded' });
    expect(bellSpy).toHaveBeenCalledTimes(1);
  });

  it('trial ended with a card: exactly one charge even if the cron runs twice', async () => {
    const { storeId, subId } = await subscribedStore({
      status: 'trialing',
      periodEnd: FAR,
      trialEndsAt: T0,
    });
    await cycleFor(T0, storeId);
    await cycleFor(T0, storeId);
    expect(stub.chargeCalls).toHaveLength(1);
    expect(stub.chargeCalls[0].idempotencyKey).toBe(`sub:${subId}:trial-end:${T0.toISOString()}`);
    const sub = await getSub(storeId);
    expect(sub).toMatchObject({ status: 'active', planCode: PRO, trialEndsAt: null });
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addInterval(T0, 'monthly').toISOString());
    expect(await ledger(storeId)).toHaveLength(1);
  });

  it('a declined trial-end charge enters dunning', async () => {
    const { storeId } = await subscribedStore({
      status: 'trialing',
      periodEnd: FAR,
      trialEndsAt: T0,
    });
    stub.declineAll = true;
    await cycleFor(T0, storeId);
    const sub = await getSub(storeId);
    expect(sub).toMatchObject({ status: 'past_due', dunningAttempts: 1 });
    expect(sub.nextRetryAt!.toISOString()).toBe(addDays(T0, 3).toISOString());
  });

  it('a comped store is never touched by trial handling', async () => {
    const { storeId } = await subscribedStore({
      planCode: 'comped',
      status: 'comped',
      trialEndsAt: addDays(T0, -5),
    });
    await cycleFor(T0, storeId);
    expect(stub.chargeCalls).toHaveLength(0);
    expect(await getSub(storeId)).toMatchObject({ planCode: 'comped', status: 'comped' });
  });
});

describe.skipIf(!hasDb)('cancel, upgrade, downgrade', () => {
  it('cancel at period end keeps the plan until then, never charges, then moves to free', async () => {
    const { storeId, subId } = await subscribedStore({ periodEnd: addDays(T0, 10) });
    const out = await cancelSubscription({ storeId });
    expect(out.mode).toBe('at_period_end');
    expect(await getSub(storeId)).toMatchObject({
      cancelAtPeriodEnd: true,
      planCode: PRO,
      status: 'active',
    });
    await cycleFor(T0, storeId);
    expect((await getSub(storeId)).planCode).toBe(PRO);
    await cycleFor(addDays(T0, 10), storeId);
    expect(await getSub(storeId)).toMatchObject({ planCode: 'free', status: 'canceled' });
    expect(stub.chargeCalls).toHaveLength(0);
    expect(await renewSubscription(subId, addDays(T0, 11), stub)).toMatchObject({
      action: 'skipped',
    });
  });

  it('upgrade charges the full new price immediately and starts a fresh period (no proration)', async () => {
    const { storeId } = await subscribedStore({ planCode: LITE, periodEnd: addDays(T0, 20) });
    const out = await changePlan({ storeId, planCode: PRO, now: T0, provider: stub });
    expect(out).toMatchObject({ mode: 'upgraded', status: 'succeeded' });
    expect(stub.chargeCalls).toHaveLength(1);
    expect(stub.chargeCalls[0].amountMinor).toBe(49900); // full price, not the difference
    const sub = await getSub(storeId);
    expect(sub.planCode).toBe(PRO);
    expect(sub.currentPeriodStart!.toISOString()).toBe(T0.toISOString());
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addInterval(T0, 'monthly').toISOString());
    expect((await storeTier(storeId)).plan).toBe('professional');
    expect((await ledger(storeId))[0].type).toBe('upgrade');
  });

  it('a declined upgrade leaves the plan untouched and can be retried', async () => {
    const { storeId } = await subscribedStore({ planCode: LITE, periodEnd: addDays(T0, 20) });
    stub.failNextCharges(1);
    expect(await changePlan({ storeId, planCode: PRO, now: T0, provider: stub })).toMatchObject({
      status: 'failed',
    });
    expect((await getSub(storeId)).planCode).toBe(LITE);
    expect(await changePlan({ storeId, planCode: PRO, now: T0, provider: stub })).toMatchObject({
      status: 'succeeded',
    });
    expect((await ledger(storeId)).map(r => r.status)).toEqual(['failed', 'succeeded']);
  });

  it('downgrade is scheduled for the period end: no charge now, cheaper price at renewal', async () => {
    const { storeId, subId } = await subscribedStore({ planCode: PRO, periodEnd: T0 });
    const out = await changePlan({ storeId, planCode: LITE, now: addDays(T0, -5), provider: stub });
    expect(out).toMatchObject({ mode: 'scheduled', planCode: LITE });
    expect(stub.chargeCalls).toHaveLength(0);
    expect(await getSub(storeId)).toMatchObject({ planCode: PRO, pendingPlanCode: LITE });
    await renewSubscription(subId, T0, stub);
    expect(stub.chargeCalls[0].amountMinor).toBe(19999);
    expect(await getSub(storeId)).toMatchObject({ planCode: LITE, pendingPlanCode: null });
    expect((await storeTier(storeId)).plan).toBe('starter');
  });

  it('refuses to change a comped store or to a null-price plan', async () => {
    const comped = await subscribedStore({
      planCode: 'comped',
      status: 'comped',
      token: null,
      provider: null,
    });
    expect(
      (await changePlan({ storeId: comped.storeId, planCode: PRO, provider: stub }).catch(e => e))
        .code
    ).toBe('STORE_COMPED');
    const paid = await subscribedStore({});
    expect(
      (await changePlan({ storeId: paid.storeId, planCode: NOPRICE, provider: stub }).catch(e => e))
        .code
    ).toBe('PLAN_PRICE_NOT_SET');
  });
});

describe.skipIf(!hasDb)('B2: term basis and the renewal window', () => {
  it('a plan set with no payment is "assigned"; a succeeded plan payment this period makes it "paid"; comped is comped', async () => {
    const now = new Date();
    const { storeId, subId } = await subscribedStore({
      planCode: PRO,
      periodEnd: addDays(now, 360),
    });
    // the period started 5 days ago (the fixture's start is not meaningful here)
    await withRlsBypass(tx =>
      tx.storeSubscription.update({
        where: { storeId },
        data: { currentPeriodStart: addDays(now, -5) },
      })
    );
    const sub = await getSub(storeId);
    expect(await termBasisOf(storeId, sub)).toBe('assigned');
    // add-on purchases (21 of them, more than any page cap) and a row with no plan never count as paying for the term
    await withRlsBypass(tx =>
      tx.billingEvent.createMany({
        data: [
          ...Array.from({ length: 21 }, () => ({
            storeId,
            subscriptionId: subId,
            type: 'upgrade',
            planCode: 'addon:feature:loyalty',
            amountMinor: 9900,
            currency: 'EGP',
            provider: 'stub',
            idempotencyKey: `b2-addon-${crypto.randomUUID()}`,
            status: 'succeeded' as const,
          })),
          {
            storeId,
            subscriptionId: subId,
            type: 'checkout',
            planCode: null,
            amountMinor: 49900,
            currency: 'EGP',
            provider: 'stub',
            idempotencyKey: `b2-noplan-${crypto.randomUUID()}`,
            status: 'succeeded' as const,
          },
        ],
      })
    );
    expect(await termBasisOf(storeId, sub)).toBe('assigned');
    await withRlsBypass(tx =>
      tx.billingEvent.create({
        data: {
          storeId,
          subscriptionId: subId,
          type: 'manual_payment',
          planCode: PRO,
          amountMinor: 49900,
          currency: 'EGP',
          provider: 'manual',
          idempotencyKey: `b2-paid-${crypto.randomUUID()}`,
          status: 'succeeded',
        },
      })
    );
    expect(await termBasisOf(storeId, sub)).toBe('paid');
    const comped = await subscribedStore({ planCode: 'comped', status: 'comped', token: null });
    expect(await termBasisOf(comped.storeId, await getSub(comped.storeId))).toBe('comped');
  });

  it('inRenewalWindow is false a year before the due date and true within 7 days', async () => {
    const now = new Date();
    const far = await subscribedStore({ planCode: PRO, periodEnd: addDays(now, 360) });
    expect((await getSubscriptionBillingState(far.storeId)).inRenewalWindow).toBe(false);
    const near = await subscribedStore({ planCode: PRO, periodEnd: addDays(now, 3) });
    const st = await getSubscriptionBillingState(near.storeId);
    expect(st.inRenewalWindow).toBe(true);
    expect(st.termBasis).toBe('assigned');
  });
});

describe.skipIf(!hasDb)('refunds and the append-only ledger', () => {
  it('refunds part then the rest of a succeeded charge; over-refund is refused', async () => {
    const { storeId } = await subscribedStore({});
    await cycleFor(T0, storeId);
    const charge = (await ledger(storeId))[0];
    const first = await refundCharge({ eventId: charge.id, amountMinor: 10000, provider: stub });
    expect(first.status).toBe('succeeded');
    expect(stub.refundCalls[0]).toMatchObject({ amountMinor: 10000, chargeId: charge.providerRef });
    expect((await ledger(storeId)).find(r => r.id === charge.id)!.status).toBe('succeeded');
    const over = await refundCharge({
      eventId: charge.id,
      amountMinor: 99999,
      provider: stub,
    }).catch(e => e);
    expect(over.code).toBe('INVALID_REFUND_AMOUNT');
    await refundCharge({ eventId: charge.id, provider: stub }); // the remaining 39900
    expect(stub.refundCalls[1].amountMinor).toBe(39900);
    const rows = await ledger(storeId);
    expect(rows.find(r => r.id === charge.id)!.status).toBe('refunded');
    expect(rows.filter(r => r.type === 'refund')).toHaveLength(2);
    // each refund claimed its own idempotency key before the provider was called
    expect(rows.filter(r => r.type === 'refund').map(r => r.idempotencyKey)).toEqual([
      `refund:${charge.id}:1`,
      `refund:${charge.id}:2`,
    ]);
    expect(stub.refundCalls.map(c => c.idempotencyKey)).toEqual([
      `refund:${charge.id}:1`,
      `refund:${charge.id}:2`,
    ]);
    // fully refunded: nothing left to refund
    expect(
      (await refundCharge({ eventId: charge.id, amountMinor: 1, provider: stub }).catch(e => e))
        .code
    ).toBe('NOT_REFUNDABLE');
  });

  it('a rejected refund can be retried: the retry gets a NEW attempt key, not a blocked old one (M-062)', async () => {
    const { storeId } = await subscribedStore({});
    await cycleFor(T0, storeId);
    const charge = (await ledger(storeId))[0];
    stub.failNextRefunds(1);
    const rejected = await refundCharge({ eventId: charge.id, provider: stub });
    expect(rejected.status).toBe('failed');
    const retry = await refundCharge({ eventId: charge.id, provider: stub });
    expect(retry.status).toBe('succeeded');
    const refunds = (await ledger(storeId)).filter(r => r.type === 'refund');
    expect(refunds.map(r => [r.idempotencyKey, r.status])).toEqual([
      [`refund:${charge.id}:1`, 'failed'],
      [`refund:${charge.id}:2`, 'succeeded'],
    ]);
    // only the succeeded attempt holds money: the charge is fully refunded exactly once
    expect((await ledger(storeId)).find(r => r.id === charge.id)!.status).toBe('refunded');
    expect(
      (await refundCharge({ eventId: charge.id, amountMinor: 1, provider: stub }).catch(e => e))
        .code
    ).toBe('NOT_REFUNDABLE');
  });

  it('cannot refund a failed or pending charge', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: stub });
    const e = await refundCharge({ eventId: billingEventId, provider: stub }).catch(x => x);
    expect(e.code).toBe('NOT_REFUNDABLE');
  });

  it('refuses direct deletes and edits to money columns (DB trigger)', async () => {
    const { storeId } = await subscribedStore({});
    await cycleFor(T0, storeId);
    const row = (await ledger(storeId))[0];
    // The app role has no DELETE policy and the trigger refuses it too.
    await expect(
      withRlsBypass(tx => tx.billingEvent.delete({ where: { id: row.id } }))
    ).rejects.toThrow();
    expect((await ledger(storeId)).map(r => r.id)).toContain(row.id);
    await expect(
      withRlsBypass(tx =>
        tx.billingEvent.update({ where: { id: row.id }, data: { amountMinor: 1 } })
      )
    ).rejects.toThrow(/append-only/);
    await expect(
      withRlsBypass(tx =>
        tx.billingEvent.update({ where: { id: row.id }, data: { status: 'failed' } })
      )
    ).rejects.toThrow(/succeeded charge cannot become/);
  });

  it('exposes the ledger to super-admin and the charges list to the merchant', async () => {
    const { storeId } = await subscribedStore({});
    await cycleFor(T0, storeId);
    const admin = await listLedger({ storeId, status: 'succeeded' });
    expect(admin[0]).toMatchObject({ type: 'renewal', amountMinor: 49900, provider: 'stub' });
    expect(admin[0].idempotencyKey).toContain('sub:');
    const merchant = await listStoreCharges(storeId);
    expect(merchant).toHaveLength(1);
    expect(merchant[0]).not.toHaveProperty('idempotencyKey');
    expect(merchant[0]).not.toHaveProperty('raw');
  });
});

describe.skipIf(!hasDb)('POST /api/v1/webhooks/billing/:provider', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(
      '/api/v1/webhooks/billing',
      express.raw({ type: () => true, limit: '1mb' }),
      billingWebhookRoutes
    );
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  it('rejects a forged delivery (401), accepts a signed one, and treats a replay as a duplicate', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: stub });
    const { rawBody, headers } = stubEvent(
      { id: billingEventId, amountMinor: 49900 },
      'charge.succeeded',
      { token: 'tok_http' }
    );
    const post = (body: string, h: Record<string, string>, provider = 'stub') =>
      fetch(`${base}/api/v1/webhooks/billing/${provider}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...h },
        body,
      });

    const forged = await post(rawBody, { 'x-stub-signature': 'f'.repeat(64) });
    expect(forged.status).toBe(401);
    const tampered = await post(rawBody.replace('49900', '100'), headers);
    expect(tampered.status).toBe(401);
    expect((await getSubOrNull(storeId))?.status).not.toBe('active');

    const ok = await post(rawBody, headers);
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ duplicate: false, outcome: 'processed' });
    expect((await getSub(storeId)).status).toBe('active');

    const replay = await post(rawBody, headers);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.duplicate).toBe(true);
    expect(await ledger(storeId)).toHaveLength(1);

    expect((await post(rawBody, headers, 'nope')).status).toBe(404);
  });
});

// ── PROVIDERS-17: a Kashier billing delivery is applied only as Kashier's own record says.
// `event` (refund vs payment) is outside Kashier's signature: a relabelled genuine charge must
// still activate the plan, and nothing is applied (nor marked seen) while Kashier cannot answer.
describe.skipIf(!hasDb)('Kashier billing webhook: confirm before apply', () => {
  const KEY = 'billing-kashier-api-key';
  let detailsDown = false;
  const txnRecords = new Map<string, { order: string; operation: string; status: string }>();
  const kashierFetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (init?.method === 'POST' && u.pathname === '/v3/payment/sessions') {
      return reply(201, {
        _id: `ks_${crypto.randomUUID()}`,
        sessionUrl: 'https://pay.kashier.test/s',
      });
    }
    const m = u.pathname.match(/^\/v2\/aggregator\/transactions\/(.+)$/);
    if (m && (init?.method ?? 'GET') === 'GET') {
      if (detailsDown) return reply(503, { message: 'down' });
      const id = decodeURIComponent(m[1]);
      const rec = txnRecords.get(id);
      if (!rec) return reply(404, { message: 'not found' });
      return reply(200, {
        body: {
          transactionId: id,
          status: rec.status,
          trxType: rec.operation === 'pay' ? 'payment' : rec.operation,
          merchantOrderId: rec.order,
          currency: 'EGP',
          transactions: [{ operation: rec.operation, status: rec.status, transactionId: id }],
        },
        message: 'ok',
      });
    }
    return reply(404, { message: 'not found' });
  }) as unknown as typeof fetch;
  const kashier = new KashierBillingProvider({
    baseUrl: 'https://kashier.test',
    merchantId: 'MID-1-1',
    secretKey: 'billing-secret',
    apiKey: KEY,
    fetchImpl: kashierFetch,
  });

  const signedDelivery = (event: string, order: string, txn: string, amount: string) => {
    const data: Record<string, unknown> = {
      merchantOrderId: order,
      transactionId: txn,
      status: 'SUCCESS',
      amount,
      currency: 'EGP',
      signatureKeys: ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'],
    };
    const sig = crypto
      .createHmac('sha256', KEY)
      .update(kashierSignaturePayload(data, data.signatureKeys as string[]))
      .digest('hex');
    return { raw: JSON.stringify({ event, data }), headers: { 'x-kashier-signature': sig } };
  };

  // Kashier's card checkout is off until Kashier enables no-charge tokenization
  // (EBDA-FUNNEL-2); this suite opens it to reach the webhook path the route already serves.
  Object.assign(kashier, { capabilities: { cardSetupWithoutCharge: true } });
  beforeAll(() => setBillingProviderForTests(kashier));
  afterAll(async () => {
    setBillingProviderForTests(stub);
    await withRlsBypass(tx =>
      tx.billingWebhookEvent.deleteMany({ where: { provider: 'kashier' } })
    );
  });

  it('a genuine CHARGE delivery relabelled as a refund still activates the plan (the record is applied)', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: kashier });
    const txn = `TX-bill-${crypto.randomUUID().slice(0, 8)}`;
    txnRecords.set(txn, { order: billingEventId, operation: 'pay', status: 'SUCCESS' });
    const w = signedDelivery('refund', billingEventId, txn, '499.00');
    const res = await handleBillingWebhook('kashier', w.raw, w.headers);
    expect(res).toMatchObject({ duplicate: false, outcome: 'processed' });
    expect((await getSub(storeId)).status).toBe('active');
    const [row] = await ledger(storeId);
    expect(row.status).toBe('succeeded');
  });

  it('when Kashier cannot confirm, nothing is applied or marked seen; the redelivery applies it', async () => {
    const storeId = await makeStore();
    const { billingEventId } = await startCheckout({ storeId, planCode: PRO, provider: kashier });
    const txn = `TX-bill-${crypto.randomUUID().slice(0, 8)}`;
    txnRecords.set(txn, { order: billingEventId, operation: 'pay', status: 'SUCCESS' });
    const w = signedDelivery('pay', billingEventId, txn, '499.00');
    detailsDown = true;
    try {
      await expect(handleBillingWebhook('kashier', w.raw, w.headers)).rejects.toThrow();
    } finally {
      detailsDown = false;
    }
    expect((await getSubOrNull(storeId))?.status).not.toBe('active');
    expect(
      await withRlsBypass(tx =>
        tx.billingWebhookEvent.count({ where: { provider: 'kashier', eventId: `${txn}:SUCCESS` } })
      )
    ).toBe(0);
    const again = await handleBillingWebhook('kashier', w.raw, w.headers);
    expect(again).toMatchObject({ duplicate: false, outcome: 'processed' });
    expect((await getSub(storeId)).status).toBe('active');
  });
});
