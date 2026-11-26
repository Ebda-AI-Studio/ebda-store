/**
 * Signup funnel (Ruling EBDA-FUNNEL-1..14) against a real Postgres container:
 * plan choice + card on file (nothing charged) OR InstaPay, the 14-day Growth
 * trial, the go-live gate, the trial-end job (charge / dunning / InstaPay
 * overdue + suspension), reminders, super-admin manual payments, the store
 * allowance after a downgrade, and the POST /stores gap.
 *
 * Mutation proofs (run by hand, recorded in the PR body):
 *   M1 renewSubscription: ignore a lost claim (`if (!eventId) return ...`) ->
 *      "trial-end job run twice charges once" goes red (2 provider calls).
 *   M2 applyWebhookEvent: drop the card-event/row-type match -> "a card.saved
 *      delivery cannot settle a paid checkout" goes red (plan activated, no money).
 *   M3 recordManualPayment: make the idempotency key unique per call -> "same
 *      reference twice = one ledger row" goes red.
 *   M4 restoreFromBilling: drop `billingSuspendedReason: reason` from the where ->
 *      "a super-admin suspension is never lifted by billing" goes red.
 *   M5 suspendForBilling: drop `status: 'active'` from the where -> "an inactive
 *      (never live) store is not suspended" goes red.
 *   M6 settleInTx: drop the token-less card_setup guard -> "card.saved without a
 *      token saves nothing" goes red.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  prisma,
  withRlsBypass,
  createPrismaClient,
  runWithRequestDb,
  runInStoreScope,
} from '@ebda/database';
import { exhaustFoundingSlots } from '../helpers/exhaust-founding-slots';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import {
  StubBillingProvider,
  STUB_WEBHOOK_SECRET,
  setBillingProviderForTests,
} from '@api/services/billing';
import {
  applyWebhookEvent,
  getSubscriptionBillingState,
  handleBillingWebhook,
  renewSubscription,
  runBillingCycle,
  selectTrialPlan,
  startCardSetup,
  startCheckout,
  changePlan,
} from '@api/services/billing/subscription-billing.service';
import { runCompMigration } from '@api/services/billing/comp-migration';
import {
  chooseInstapay,
  enforceStoreAllowance,
  reconcileStoreAccess,
  recordManualPayment,
  restoreFromBilling,
  suspendForBilling,
} from '@api/services/billing/account.service';
import { sendDueReminder } from '@api/services/billing/reminders.service';
import { assertStoreMayGoLive } from '@api/services/billing/go-live-gate';
import { addDays } from '@api/services/billing/period';
import { ProvisioningService } from '@api/services/provisioning.service';
import { OnboardingService } from '@api/services/onboarding.service';
import { StoreService } from '@api/services/store.service';
import { planService } from '@api/services/plan.service';
import { EmailService } from '@api/services/email.service';
import { socketService } from '@api/services/socket.service';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import adminRoutes from '@api/routes/admin.routes';
import { hasDb } from '../helpers/bundle-fixtures';
import {
  freshReference,
  mockPrivateStorage,
  resetModel,
  submitTestSubscriptionReceipt,
} from '../helpers/instapay-receipt-fixtures';

// Card paths are exercised explicitly; the product default is InstaPay-only.
process.env.BILLING_TRIAL_CARD_MODE = 'card_on_file';
const run = crypto.randomUUID().slice(0, 8);
const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
/** Run as the production role (`ebda_app`, NOBYPASSRLS): strict RLS applies. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });
const stub = new StubBillingProvider();
const emails: string[] = [];
const DAY = 86_400_000;

let emailSpy: ReturnType<typeof vi.spyOn>;

const sub = (storeId: string) =>
  withRlsBypass(tx => tx.storeSubscription.findUniqueOrThrow({ where: { storeId } }));
const ledger = (storeId: string) =>
  withRlsBypass(tx =>
    tx.billingEvent.findMany({ where: { storeId }, orderBy: { createdAt: 'asc' } })
  );
const storeRow = (id: string) => prisma.store.findUniqueOrThrow({ where: { id } });
const planPrice = async (code: string, interval: 'monthly' | 'yearly') => {
  const p = await prisma.plan.findUniqueOrThrow({ where: { code } });
  return interval === 'yearly' ? p.priceYearlyMinor! : p.priceMonthlyMinor!;
};

/** A self-serve store on the signup trial, as onboarding creates it. */
async function trialStore(
  tag: string,
  choice: { planCode: string; interval: 'monthly' | 'yearly' } = {
    planCode: 'growth',
    interval: 'monthly',
  },
  ownerEmail?: string
) {
  const email = ownerEmail ?? `funnel-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}@test.local`;
  if (!ownerEmail) emails.push(email);
  const r = await ProvisioningService.provisionStore({
    storeName: `F ${tag}`,
    storeSlug: `fn-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}`,
    plan: 'professional',
    growthTrial: true,
    trialChoice: choice,
    status: 'inactive',
    ownerEmail: email,
    ownerName: 'Funnel Owner',
  });
  return { storeId: r.store.id, ownerId: r.owner.id, email };
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

beforeAll(async () => {
  if (!hasDb) return;
  await withRlsBypass(tx => exhaustFoundingSlots(sql => tx.$executeRawUnsafe(sql)));
  setBillingProviderForTests(stub);
  process.env.EBDA_INSTAPAY_HANDLE = 'ebda@instapay';
});

beforeEach(() => {
  stub.reset();
  emailSpy = vi.spyOn(EmailService, 'sendSubscriptionBillingNotice').mockResolvedValue(undefined);
  vi.spyOn(EmailService, 'sendWelcome').mockResolvedValue(undefined as never);
  vi.spyOn(socketService, 'notifyStore').mockImplementation(() => undefined);
  // The InstaPay receipt screenshot goes to the private bucket: in-memory here.
  mockPrivateStorage();
});

afterAll(async () => {
  if (!hasDb) return;
  setBillingProviderForTests(null);
  resetModel();
  delete process.env.EBDA_INSTAPAY_HANDLE;
  await withRlsBypass(async tx => {
    const users = await tx.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const ids = users.map(u => u.id);
    await tx.store.deleteMany({ where: { ownerId: { in: ids } } });
    await tx.user.deleteMany({ where: { id: { in: ids } } });
  });
});

describe.skipIf(!hasDb)('signup funnel', () => {
  describe('card on file (nothing charged) -> 14-day Growth trial -> day 15 charge', () => {
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
      const live = await OnboardingService.goLive(storeId);
      expect(live.status).toBe('active');

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
      await withRlsBypass(tx =>
        tx.storeSubscription.update({
          where: { storeId },
          data: { status: 'canceled', planCode: 'free' },
        })
      );
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
      // #627: a SUCCESSFUL charge on a card-setup row is money we cannot place: held for a person, still not booked
      expect(r2).toMatchObject({ outcome: 'held', detail: 'kind_mismatch' });
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
      await withRlsBypass(tx =>
        tx.storeSubscription.update({
          where: { storeId },
          data: { trialEndsAt: new Date(Date.now() - DAY) },
        })
      );
      await expect(assertStoreMayGoLive(storeId)).rejects.toMatchObject({ code: 'TRIAL_EXPIRED' });
      await planService.assignPlan(storeId, { planCode: 'comped' });
      await expect(assertStoreMayGoLive(storeId)).resolves.toMatchObject({ reason: 'granted' });
    });
  });

  describe('InstaPay: no card, reminders, overdue -> suspension -> manual payment restores', () => {
    it('runs the whole InstaPay path and every step is idempotent', async () => {
      const { storeId, ownerId } = await trialStore('insta', {
        planCode: 'growth',
        interval: 'monthly',
      });
      const chosen = await chooseInstapay(storeId);
      expect(chosen.paymentReference).toMatch(/^EBD-[A-Z0-9]{8}$/);
      expect((await chooseInstapay(storeId)).paymentReference).toBe(chosen.paymentReference);
      await expect(assertStoreMayGoLive(storeId)).resolves.toMatchObject({
        reason: 'trial_instapay',
      });
      await OnboardingService.goLive(storeId);

      let s = await sub(storeId);
      const due = s.trialEndsAt!;
      // Reminders: d7 once even if the job runs twice; d3 later; nothing past the due day.
      expect(await sendDueReminder(s.id, addDays(due, -7))).toMatchObject({
        sent: true,
        kind: 'd7',
      });
      expect(await sendDueReminder(s.id, addDays(due, -7))).toMatchObject({
        sent: false,
        reason: 'already_sent',
      });
      expect(await sendDueReminder(s.id, addDays(due, -3))).toMatchObject({
        sent: true,
        kind: 'd3',
      });
      expect(await sendDueReminder(s.id, new Date(due.getTime() + 2 * DAY))).toMatchObject({
        sent: false,
      });
      expect(emailSpy).toHaveBeenCalledWith(
        storeId,
        expect.objectContaining({
          kind: 'payment_due',
          method: 'instapay',
          instapayHandle: 'ebda@instapay',
          paymentReference: chosen.paymentReference,
        }),
        expect.anything()
      );

      // The merchant's receipt (screenshot + checked fields) alone activates nothing.
      const ipRef = freshReference();
      const { claim } = await submitTestSubscriptionReceipt(storeId, { reference: ipRef });
      expect(claim.status).toBe('pending');
      await expect(
        submitTestSubscriptionReceipt(storeId, { reference: ipRef })
      ).rejects.toMatchObject({
        code: 'DUPLICATE_REFERENCE',
      });
      expect((await sub(storeId)).status).toBe('trialing');

      // Due day: past_due, suspension scheduled at due + 3 days; no provider call.
      const only = { subscriptionIds: [s.id] };
      await runBillingCycle(new Date(due.getTime() + 60_000), stub, only);
      await runBillingCycle(new Date(due.getTime() + 120_000), stub, only);
      s = await sub(storeId);
      expect(s.status).toBe('past_due');
      expect(s.nextRetryAt!.getTime()).toBe(addDays(due, 3).getTime());
      expect(stub.chargeCalls).toHaveLength(0);
      expect((await storeRow(storeId)).status).toBe('active');

      // Grace over: suspended once (double run changes nothing more).
      const graceOver = new Date(addDays(due, 3).getTime() + 60_000);
      const c1 = await runBillingCycle(graceOver, stub, only);
      const c2 = await runBillingCycle(graceOver, stub, only);
      expect(c1.suspended).toBe(1);
      expect(c2.suspended).toBe(0);
      expect(await storeRow(storeId)).toMatchObject({
        status: 'suspended',
        billingSuspendedReason: 'unpaid',
      });
      // #836: the lapse also ends the paid plan (it used to stay past_due on Growth forever).
      expect(await sub(storeId)).toMatchObject({ status: 'canceled', planCode: 'free' });
      expect((await storeRow(storeId)).plan).toBe('free');
      expect(emailSpy).toHaveBeenCalledWith(
        storeId,
        expect.objectContaining({ kind: 'store_suspended' }),
        expect.anything()
      );

      // Super-admin confirms the claim: one ledger row, store back at once.
      const periodStart = new Date();
      const periodEnd = addDays(periodStart, 30);
      const input = {
        storeId,
        planCode: 'growth',
        interval: 'monthly' as const,
        amountMinor: await planPrice('growth', 'monthly'),
        method: 'instapay' as const,
        reference: ipRef,
        paidAt: new Date(),
        periodStart,
        periodEnd,
        actorId: ownerId,
        claimId: claim.id,
      };
      const rec = await recordManualPayment(input);
      expect(rec.duplicate).toBe(false);
      const rec2 = await recordManualPayment({
        ...input,
        reference: ` ${ipRef.slice(0, 4)} ${ipRef.slice(4)} `,
      });
      expect(rec2).toEqual({ duplicate: true, billingEventId: rec.billingEventId });
      expect((await ledger(storeId)).filter(r => r.type === 'manual_payment')).toHaveLength(1);
      expect(await storeRow(storeId)).toMatchObject({
        status: 'active',
        billingSuspendedReason: null,
      });
      s = await sub(storeId);
      expect(s).toMatchObject({
        status: 'active',
        planCode: 'growth',
        billingMethod: 'instapay',
        dunningAttempts: 0,
      });
      expect(s.currentPeriodEnd!.getTime()).toBe(periodEnd.getTime());
      const claims = await withRlsBypass(tx =>
        tx.manualPaymentClaim.findMany({ where: { storeId } })
      );
      expect(claims[0]).toMatchObject({ status: 'confirmed', billingEventId: rec.billingEventId });

      // When that period ends it follows the normal manual path again (no card).
      await runBillingCycle(new Date(periodEnd.getTime() + 60_000), stub, only);
      expect((await sub(storeId)).status).toBe('past_due');
      expect(stub.chargeCalls).toHaveLength(0);
    });

    it('a manual payment on a store with a card on file renews by card when the period ends', async () => {
      const { storeId, ownerId } = await trialStore('manualcard', {
        planCode: 'basic',
        interval: 'monthly',
      });
      await saveCard(storeId);
      const periodStart = new Date();
      const periodEnd = addDays(periodStart, 30);
      await recordManualPayment({
        storeId,
        planCode: 'basic',
        interval: 'monthly',
        amountMinor: 149000,
        method: 'bank',
        reference: `BANK-${run}`,
        paidAt: new Date(),
        periodStart,
        periodEnd,
        actorId: ownerId,
      });
      expect((await sub(storeId)).billingMethod).toBe('card');
      const s = await sub(storeId);
      await renewSubscription(s.id, new Date(periodEnd.getTime() + 60_000), stub);
      expect(stub.chargeCalls).toHaveLength(1);
      expect(stub.chargeCalls[0].amountMinor).toBe(await planPrice('basic', 'monthly'));
    });

    it('only a super_admin may record a manual payment (HTTP)', async () => {
      const { storeId, ownerId } = await trialStore('httpauth');
      const app = express();
      app.use(express.json());
      app.use('/api/v1/admin', adminRoutes);
      app.use(errorHandler);
      const token = jwt.sign(
        { userId: ownerId, email: 'x@test.local', role: 'store_admin', tv: 0 },
        config.jwtSecret,
        { expiresIn: '10m', issuer: 'ebda-api', audience: 'ebda-app' }
      );
      const res = await request(app)
        .post(`/api/v1/admin/stores/${storeId}/manual-payment`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          planCode: 'growth',
          interval: 'monthly',
          amountMinor: 349000,
          method: 'instapay',
          reference: `HACK-${run}`,
          paidAt: new Date().toISOString(),
          periodStart: new Date().toISOString(),
          periodEnd: addDays(new Date(), 30).toISOString(),
        });
      expect(res.status).toBe(403);
      expect((await ledger(storeId)).filter(r => r.type === 'manual_payment')).toHaveLength(0);
    });
  });

  describe('store allowance: downgrade/lapse suspends extra stores oldest-first-kept', () => {
    it('Business -> Growth suspends stores 2..n (read-only), back to Business restores them', async () => {
      const first = await trialStore('own1');
      await chooseInstapay(first.storeId);
      await recordManualPayment({
        storeId: first.storeId,
        planCode: 'business',
        interval: 'monthly',
        amountMinor: 999000,
        method: 'instapay',
        reference: `BIZ-${run}`,
        paidAt: new Date(),
        periodStart: new Date(),
        periodEnd: addDays(new Date(), 30),
        actorId: first.ownerId,
      });
      await OnboardingService.goLive(first.storeId);
      const extra: string[] = [];
      for (const n of [2, 3]) {
        const r = await ProvisioningService.provisionStore({
          storeName: `F own${n}`,
          storeSlug: `fn-own${n}-${run}`,
          plan: 'enterprise',
          status: 'inactive',
          ownerEmail: first.email,
          ownerName: 'Funnel Owner',
        });
        extra.push(r.store.id);
        await OnboardingService.goLive(r.store.id); // rides the oldest store's Business plan
      }
      for (const id of extra) expect((await storeRow(id)).status).toBe('active');

      await planService.assignPlan(first.storeId, { planCode: 'growth' });
      expect((await storeRow(first.storeId)).status).toBe('active');
      for (const id of extra) {
        expect(await storeRow(id)).toMatchObject({
          status: 'suspended',
          billingSuspendedReason: 'over_store_limit',
        });
      }
      // A store beyond the allowance cannot go live again either.
      await expect(assertStoreMayGoLive(extra[0])).rejects.toMatchObject({
        code: 'STORE_LIMIT_REACHED',
      });
      // Idempotent: enforcing again changes nothing.
      expect(await enforceStoreAllowance(first.ownerId)).toEqual({ suspended: [], restored: [] });

      await planService.assignPlan(first.storeId, { planCode: 'business' });
      for (const id of extra) {
        expect(await storeRow(id)).toMatchObject({
          status: 'active',
          billingSuspendedReason: null,
        });
      }
    });

    it('a super-admin suspension is never lifted by billing', async () => {
      const { storeId } = await trialStore('opsusp');
      await chooseInstapay(storeId);
      await OnboardingService.goLive(storeId);
      await StoreService.setStatus(storeId, 'suspended'); // operator, reason NULL
      expect(await restoreFromBilling(storeId, 'unpaid')).toBe(false);
      expect(await restoreFromBilling(storeId, 'over_store_limit')).toBe(false);
      await reconcileStoreAccess(storeId);
      expect(await storeRow(storeId)).toMatchObject({
        status: 'suspended',
        billingSuspendedReason: null,
      });
    });

    it('an inactive (never live) store is not suspended by billing', async () => {
      const { storeId } = await trialStore('inactive');
      expect(await suspendForBilling(storeId, 'unpaid')).toBe(false);
      expect(await storeRow(storeId)).toMatchObject({
        status: 'inactive',
        billingSuspendedReason: null,
      });
    });
  });

  describe('parent / child store billing (R-EBDA-PRICING-6, EBDA-FUNNEL-18)', () => {
    async function businessFamily(tag: string) {
      const first = await trialStore(tag);
      await chooseInstapay(first.storeId);
      await recordManualPayment({
        storeId: first.storeId,
        planCode: 'business',
        interval: 'monthly',
        amountMinor: 999000,
        method: 'instapay',
        reference: `PC-${tag}-${run}`,
        paidAt: new Date(),
        periodStart: new Date(),
        periodEnd: addDays(new Date(), 30),
        actorId: first.ownerId,
      });
      await OnboardingService.goLive(first.storeId);
      const r = await ProvisioningService.provisionStore({
        storeName: `F ${tag} child`,
        storeSlug: `fn-${tag}c-${run}`,
        plan: 'enterprise',
        status: 'inactive',
        ownerEmail: first.email,
        ownerName: 'Funnel Owner',
      });
      await OnboardingService.goLive(r.store.id); // rides the parent's Business plan
      return { parent: first, childId: r.store.id };
    }

    it('a child inside the allowance is never asked to pay: every money-in path refuses it', async () => {
      const { parent, childId } = await businessFamily('pcpay');
      const refused = {
        code: 'PAY_ON_PARENT_STORE',
        details: { parentStoreId: parent.storeId, included: true },
      };
      await expect(chooseInstapay(childId)).rejects.toMatchObject(refused);
      await expect(
        changePlan({ storeId: childId, planCode: 'growth', provider: stub })
      ).rejects.toMatchObject(refused);
      await expect(
        selectTrialPlan({ storeId: childId, planCode: 'basic', interval: 'monthly' })
      ).rejects.toMatchObject(refused);
      await expect(
        startCheckout({ storeId: childId, planCode: 'growth', provider: stub })
      ).rejects.toMatchObject(refused);
      await expect(startCardSetup({ storeId: childId, provider: stub })).rejects.toMatchObject(
        refused
      );
      await expect(
        recordManualPayment({
          storeId: childId,
          planCode: 'business',
          interval: 'monthly',
          amountMinor: 999000,
          method: 'instapay',
          reference: `PC-child-${run}`,
          paidAt: new Date(),
          periodStart: new Date(),
          periodEnd: addDays(new Date(), 30),
          actorId: parent.ownerId,
        })
      ).rejects.toMatchObject(refused);
      expect((await ledger(childId)).filter(r => r.type !== 'plan_change')).toHaveLength(0);
      // The parent itself is still payable.
      await expect(chooseInstapay(parent.storeId)).resolves.toBeDefined();
    });

    it('the renewal cycle never charges a child, even a due one (fail closed, idempotent)', async () => {
      const { childId } = await businessFamily('pcrenew');
      await withRlsBypass(tx =>
        tx.storeSubscription.update({
          where: { storeId: childId },
          data: {
            status: 'active',
            billingMethod: 'instapay',
            currentPeriodStart: addDays(new Date(), -31),
            currentPeriodEnd: addDays(new Date(), -1),
          },
        })
      );
      const s = await sub(childId);
      for (let i = 0; i < 2; i++) {
        expect(await renewSubscription(s.id, new Date(), stub)).toEqual({
          action: 'skipped',
          reason: 'child_store',
        });
      }
      expect(await sub(childId)).toMatchObject({ status: 'active' });
      expect(stub.chargeCalls.filter(c => c.amountMinor === 999000)).toHaveLength(0);
      expect((await ledger(childId)).filter(r => r.type === 'renewal')).toHaveLength(0);
    });

    it('a child gets no payment reminder, and its stale row is healed to the parent plan', async () => {
      const { parent, childId } = await businessFamily('pcremind');
      await withRlsBypass(tx =>
        tx.storeSubscription.update({
          where: { storeId: childId },
          data: {
            planCode: 'basic',
            status: 'trialing',
            trialEndsAt: addDays(new Date(), 2),
            billingMethod: 'instapay',
          },
        })
      );
      const s = await sub(childId);
      expect(await sendDueReminder(s.id, new Date())).toEqual({
        sent: false,
        reason: 'child_store',
      });
      await reconcileStoreAccess(parent.storeId);
      expect(await sub(childId)).toMatchObject({
        planCode: 'business',
        status: 'active',
        billingMethod: null,
        trialEndsAt: null,
        currentPeriodEnd: null,
      });
      // Running it again changes nothing (idempotent).
      await reconcileStoreAccess(parent.storeId);
      expect((await sub(childId)).planCode).toBe('business');
    });

    it('the parent going unpaid suspends its children; its payment restores them', async () => {
      const { parent, childId } = await businessFamily('pcunpaid');
      expect(await suspendForBilling(parent.storeId, 'unpaid')).toBe(true);
      expect(await storeRow(childId)).toMatchObject({
        status: 'suspended',
        billingSuspendedReason: 'unpaid',
      });
      await recordManualPayment({
        storeId: parent.storeId,
        planCode: 'business',
        interval: 'monthly',
        amountMinor: 999000,
        method: 'instapay',
        reference: `PC-unpaid2-${run}`,
        paidAt: new Date(),
        periodStart: new Date(),
        periodEnd: addDays(new Date(), 30),
        actorId: parent.ownerId,
      });
      expect(await storeRow(parent.storeId)).toMatchObject({ status: 'active' });
      expect(await storeRow(childId)).toMatchObject({
        status: 'active',
        billingSuspendedReason: null,
      });
    });

    it('a parent that lapses to canceled takes its children off the paid plan; its payment puts them back (#836)', async () => {
      const { parent, childId } = await businessFamily('pclapsefree');
      expect((await sub(childId)).planCode).toBe('business');
      // the end state of a lapse (InstaPay grace over / card dunning): parent canceled on free
      await withRlsBypass(tx =>
        tx.storeSubscription.update({
          where: { storeId: parent.storeId },
          data: { planCode: 'free', status: 'canceled' },
        })
      );
      await reconcileStoreAccess(parent.storeId);
      expect(await sub(childId)).toMatchObject({ planCode: 'free', status: 'canceled' });
      await recordManualPayment({
        storeId: parent.storeId,
        planCode: 'business',
        interval: 'monthly',
        amountMinor: 999000,
        method: 'instapay',
        reference: `PC-lapsefree2-${run}`,
        paidAt: new Date(),
        periodStart: new Date(),
        periodEnd: addDays(new Date(), 30),
        actorId: parent.ownerId,
      });
      expect(await sub(childId)).toMatchObject({ planCode: 'business', status: 'active' });
    });

    it('the billing parent cannot be hard-deleted while the owner has other stores', async () => {
      const { parent } = await businessFamily('pcdelete');
      await expect(StoreService.delete(parent.storeId)).rejects.toMatchObject({
        code: 'STORE_IS_BILLING_PARENT',
      });
    });

    it('when the parent lapses to a one-store plan, the child is suspended and pays nothing', async () => {
      const { parent, childId } = await businessFamily('pclapse');
      await planService.assignPlan(parent.storeId, { planCode: 'growth' });
      expect(await storeRow(childId)).toMatchObject({
        status: 'suspended',
        billingSuspendedReason: 'over_store_limit',
      });
      await expect(chooseInstapay(childId)).rejects.toMatchObject({
        code: 'PAY_ON_PARENT_STORE',
        details: { included: false },
      });
    });
  });

  describe('Amelia comp migration (EBDA-FUNNEL-19)', () => {
    it('dry run writes nothing; apply moves comped to Growth by InstaPay once; a second run is a no-op', async () => {
      const { storeId } = await trialStore('comp');
      await planService.assignPlan(storeId, { planCode: 'comped' });
      const coveredUntil = addDays(new Date(), 30);
      const before = await sub(storeId);
      expect(before).toMatchObject({ planCode: 'comped', status: 'comped' });

      const dry = await runCompMigration({ storeId, coveredUntil }, { apply: false });
      expect(dry).toMatchObject({ applied: false, plan: { action: 'migrate' } });
      expect(dry.listPriceMinor).toBe(await planPrice('growth', 'monthly'));
      expect(await sub(storeId)).toMatchObject({ planCode: 'comped', status: 'comped' });

      const done = await runCompMigration({ storeId, coveredUntil }, { apply: true });
      expect(done.applied).toBe(true);
      const after = await sub(storeId);
      expect(after).toMatchObject({
        planCode: 'growth',
        status: 'active',
        billingMethod: 'instapay',
      });
      expect(after.currentPeriodEnd?.getTime()).toBe(coveredUntil.getTime());
      expect(after.paymentReference).toMatch(/^EBD-/);
      expect((await storeRow(storeId)).plan).toBe('professional');
      expect((await ledger(storeId)).filter(r => r.type === 'manual_payment')).toHaveLength(0);

      const again = await runCompMigration({ storeId, coveredUntil }, { apply: true });
      expect(again).toMatchObject({ applied: false, plan: { action: 'noop' } });
      expect((await sub(storeId)).paymentReference).toBe(after.paymentReference);
    });

    it('refuses a comped CHILD store (it would sit unbilled and keep getting reminders)', async () => {
      const first = await trialStore('compchild');
      const r = await ProvisioningService.provisionStore({
        storeName: 'F compchild2',
        storeSlug: `fn-compchild2-${run}`,
        plan: 'enterprise',
        status: 'inactive',
        ownerEmail: first.email,
        ownerName: 'Funnel Owner',
      });
      await withRlsBypass(tx =>
        tx.storeSubscription.update({
          where: { storeId: r.store.id },
          data: { planCode: 'comped', status: 'comped' },
        })
      );
      const res = await runCompMigration(
        { storeId: r.store.id, coveredUntil: addDays(new Date(), 30) },
        { apply: true }
      );
      expect(res).toMatchObject({
        applied: false,
        plan: { action: 'refuse', reason: 'child_store' },
      });
    });

    it('refuses a store that is not comped (never resets a paying store)', async () => {
      const { storeId } = await trialStore('compno');
      const r = await runCompMigration(
        { storeId, coveredUntil: addDays(new Date(), 30) },
        { apply: true }
      );
      expect(r).toMatchObject({ applied: false, plan: { action: 'refuse', reason: 'not_comped' } });
      expect((await sub(storeId)).status).toBe('trialing');
    });
  });

  describe('under ebda_app (strict RLS, the production role)', () => {
    it('card setup, InstaPay claim, reminder, overdue, suspension and manual payment all work with no bypass', async () => {
      const a = await trialStore('rlscard', { planCode: 'basic', interval: 'monthly' });
      await asApp(async () => {
        const { billingEventId } = await startCardSetup({ storeId: a.storeId, provider: stub });
        const r = await deliver({
          id: `evt_${billingEventId}_rls`,
          type: 'card.saved',
          merchantOrderId: billingEventId,
          chargeId: null,
          amountMinor: 0,
          token: 'tok_rls',
          last4: '4242',
        });
        expect(r.outcome).toBe('processed');
        // The go-live gate and the billing-state read run in the store's scope
        // in production (router.param tenantContext), as goLive does below.
        await runInStoreScope(a.storeId, async () => {
          await expect(assertStoreMayGoLive(a.storeId)).resolves.toMatchObject({ ok: true });
          expect((await getSubscriptionBillingState(a.storeId)).card).toMatchObject({
            last4: '4242',
          });
        });
      });

      const b = await trialStore('rlsinsta');
      await asApp(async () => {
        await chooseInstapay(b.storeId);
        await submitTestSubscriptionReceipt(b.storeId);
        // As the route runs it: in the store's scope (router.param tenantContext).
        await runInStoreScope(b.storeId, () => OnboardingService.goLive(b.storeId));
      });
      const s = await sub(b.storeId);
      const due = s.trialEndsAt!;
      await asApp(async () => {
        expect(await sendDueReminder(s.id, addDays(due, -1))).toMatchObject({
          sent: true,
          kind: 'd1',
        });
        await runBillingCycle(new Date(due.getTime() + 60_000), stub, { subscriptionIds: [s.id] });
        const c = await runBillingCycle(new Date(addDays(due, 3).getTime() + 60_000), stub, {
          subscriptionIds: [s.id],
        });
        expect(c.suspended).toBe(1);
      });
      expect((await storeRow(b.storeId)).billingSuspendedReason).toBe('unpaid');
      await asApp(() =>
        recordManualPayment({
          storeId: b.storeId,
          planCode: 'growth',
          interval: 'monthly',
          amountMinor: 349000,
          method: 'instapay',
          reference: `RLS${run}`,
          paidAt: new Date(),
          periodStart: new Date(),
          periodEnd: addDays(new Date(), 30),
          actorId: b.ownerId,
        })
      );
      expect(await storeRow(b.storeId)).toMatchObject({
        status: 'active',
        billingSuspendedReason: null,
      });
      // The same reference cannot be recorded against another store (hidden by RLS).
      await expect(
        asApp(() =>
          recordManualPayment({
            storeId: a.storeId,
            planCode: 'growth',
            interval: 'monthly',
            amountMinor: 349000,
            method: 'instapay',
            reference: `RLS${run}`,
            paidAt: new Date(),
            periodStart: new Date(),
            periodEnd: addDays(new Date(), 30),
            actorId: a.ownerId,
          })
        )
      ).rejects.toMatchObject({ code: 'REFERENCE_USED_ELSEWHERE' });
    });
  });

  describe('InstaPay-only default (BILLING_TRIAL_CARD_MODE unset)', () => {
    it('refuses card setup and card checkout; the InstaPay path still goes live', async () => {
      const prev = process.env.BILLING_TRIAL_CARD_MODE;
      delete process.env.BILLING_TRIAL_CARD_MODE;
      try {
        const { storeId } = await trialStore('instaonly');
        await expect(startCardSetup({ storeId, provider: stub })).rejects.toMatchObject({
          code: 'CARD_SETUP_UNAVAILABLE',
        });
        await expect(
          startCheckout({ storeId, planCode: 'growth', provider: stub })
        ).rejects.toMatchObject({ code: 'CARD_PAYMENTS_DISABLED' });
        expect((await getSubscriptionBillingState(storeId)).trialCardMode).toBe('pay_at_trial_end');
        await chooseInstapay(storeId);
        await expect(assertStoreMayGoLive(storeId)).resolves.toMatchObject({
          reason: 'trial_instapay',
        });
        expect(stub.cardSetupCalls).toHaveLength(0);
        expect(stub.checkoutCalls).toHaveLength(0);
      } finally {
        process.env.BILLING_TRIAL_CARD_MODE = prev;
      }
    });
  });

  describe('POST /stores gap', () => {
    it('a merchant-created first store is inactive on the Growth trial, never Basic-active', async () => {
      const email = `funnel-poststores-${run}@test.local`;
      emails.push(email);
      const owner = await withRlsBypass(tx =>
        tx.user.create({
          data: {
            email,
            passwordHash: 'x',
            firstName: 'P',
            lastName: 'S',
            role: 'store_admin',
            emailVerified: true,
          },
        })
      );
      // A random suffix can fuzzy-match the protected brand list (leetspeak), so
      // draw a fresh one until the slug is legal.
      let store: Awaited<ReturnType<typeof StoreService.create>> | null = null;
      for (let i = 0; i < 5 && !store; i++) {
        store = await StoreService.create(owner.id, {
          name: `Funnel Shop ${crypto.randomUUID().slice(0, 6)}`,
        }).catch(err => {
          if ((err as { code?: string }).code === 'SLUG_PROTECTED') return null;
          throw err;
        });
      }
      if (!store) throw new Error('no legal slug drawn');
      expect(store.status).toBe('inactive');
      expect(await sub(store.id)).toMatchObject({
        planCode: 'growth',
        status: 'trialing',
        pendingPlanCode: 'growth',
      });
      await expect(assertStoreMayGoLive(store.id)).rejects.toMatchObject({
        code: 'PAYMENT_METHOD_REQUIRED',
      });
    });
  });
});
