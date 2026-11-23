/**
 * Signup funnel, store-write half (Ruling EBDA-FUNNEL-1..19), ported from tests/integration/signup-funnel.test.ts: InstaPay (no card),
 * manual payment on a card renewal, the HTTP super_admin gate, the store allowance (suspend / restore, over-limit), parent / child
 * billing and the Amelia comp migration. The billing models (subscription, ledger, claims, receipts, reminders) run on the PLATFORM D1
 * (real migrations on node:sqlite); the Store row is written exactly as production does for a Durable Object store: the D1 `stores`
 * directory row first, then the store's own StoreDO profile/config (one node:sqlite DO schema per store, tests/helpers/multi-store-do.ts).
 * Stores are created directly (a D1 directory row + a DO profile), as the card-half port does: provisioning is a store-create
 * concern covered by workers-test/merchant-signup.
 *
 * POST /stores gap (first store inactive on the Growth trial) is covered by tests/unit/store-service-do-native.test.ts ("a merchant first
 * store: inactive, Professional, on the Growth trial, in D1 + the DO") and the go-live card gate by signup-funnel-card-d1.test.ts.
 * The same-reference-on-another-store refusal of the RLS case is platform-manual-payment-d1.test.ts ("a reference store B already holds").
 *
 * Mutations (each turns the named test red, run by hand): account.service restoreFromBilling drop `billingSuspendedReason: reason` ->
 * "a super-admin suspension is never lifted"; suspendForBilling drop `status: 'active'` -> "an inactive (never live) store is not suspended";
 * suspendForBilling skip suspendCoveredChildren -> "the parent going unpaid suspends its children"; admin.routes manual-payment drop
 * `requireRole('super_admin')` -> "only a super_admin may record a manual payment (HTTP)".
 *
 * The "ebda_app strict RLS" case of the original has no production equivalent (the Worker has no Postgres role or RLS) and is
 * deleted: the same flows are exercised end to end without a bypass everywhere in this file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

process.env.ENCRYPTION_KEY = '0'.repeat(64);
// Card paths are exercised explicitly; the product default is InstaPay-only.
process.env.BILLING_TRIAL_CARD_MODE = 'card_on_file';

const h = vi.hoisted(() => ({
  withStoreRepo: (_id: string, fn: () => unknown): unknown => fn(),
  currentStoreId: (): string | undefined => undefined,
  doStub: (_id: string): unknown => ({}),
  accounts: new Map<string, { role: string; email: string }>(),
}));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // No tenant transaction exists on D1 or a DO: a scope is the store's repo scope with the routed client, as after the cutover.
  return {
    ...real,
    withStore: (id: string, fn: (tx: unknown) => unknown) =>
      h.withStoreRepo(id, () => fn(real.prisma)),
    withUser: (_u: string, fn: (tx: unknown) => unknown) => fn(real.prisma),
    runInTenantContext: (_i: unknown, fn: () => unknown) => fn(),
    runInStoreScope: (id: string, fn: () => unknown) => h.withStoreRepo(id, fn),
    currentStoreId: () => h.currentStoreId(),
  };
});
vi.mock('@api/lib/store-backend', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeDo: (id: string) => h.doStub(id),
}));
vi.mock('@api/lib/identity-client', async importOriginal => ({
  ...(await importOriginal<object>()),
  getAccountState: async (id: string) => {
    const a = h.accounts.get(id);
    return a
      ? { id, role: a.role, status: 'active', email: a.email, firstName: 'T', lastName: 'U' }
      : null;
  },
  getAccountsBrief: async (ids: string[]) =>
    ids.flatMap(id => (h.accounts.has(id) ? [{ id, email: h.accounts.get(id)!.email }] : [])),
}));
vi.mock('@api/middleware/auth', async importOriginal => ({
  ...(await importOriginal<object>()),
  // identity comes from a header; authorize / rejectImpersonated stay real
  authenticate: (req: any, res: any, n: () => void) => {
    const id = String(req.headers['x-test-user']);
    const a = h.accounts.get(id);
    if (!a) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    req.user = { userId: id, email: a.email, role: a.role };
    n();
  },
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/security', async importOriginal => ({
  ...(await importOriginal<object>()),
  auditLog: async () => undefined,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => undefined) }));

import { prisma } from '@ebda/database';
import {
  StubBillingProvider,
  STUB_WEBHOOK_SECRET,
  setBillingProviderForTests,
} from '../../apps/api/src/services/billing';
import {
  changePlan,
  renewSubscription,
  runBillingCycle,
  selectTrialPlan,
  startCardSetup,
  startCheckout,
  handleBillingWebhook,
  getSubscriptionBillingState,
} from '../../apps/api/src/services/billing/subscription-billing.service';
import { startSignupTrial } from '../../apps/api/src/services/billing/trial';
import {
  chooseInstapay,
  enforceStoreAllowance,
  reconcileStoreAccess,
  recordManualPayment,
  restoreFromBilling,
  suspendForBilling,
} from '../../apps/api/src/services/billing/account.service';
import { runCompMigration } from '../../apps/api/src/services/billing/comp-migration';
import { sendDueReminder } from '../../apps/api/src/services/billing/reminders.service';
import { assertStoreMayGoLive } from '../../apps/api/src/services/billing/go-live-gate';
import { addDays } from '../../apps/api/src/services/billing/period';
import { OnboardingService } from '../../apps/api/src/services/onboarding.service';
import { planService } from '../../apps/api/src/services/plan.service';
import { StoreService } from '../../apps/api/src/services/store.service';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../apps/api/src/middleware/error-handler';
import adminRoutes from '../../apps/api/src/routes/admin.routes';
import { EmailService } from '../../apps/api/src/services/email.service';
import { socketService } from '../../apps/api/src/services/socket.service';
import {
  freshReference,
  mockPrivateStorage,
  resetModel,
  submitTestSubscriptionReceipt,
} from '../helpers/instapay-receipt-fixtures';
import { DoStores } from '../helpers/multi-store-do';
import {
  installPlatformD1,
  seedBillingCatalog,
  uninstallPlatformD1,
} from '../helpers/platform-d1-rig';
import { insertSqlite } from '../../packages/repo/test/diff-harness';

const worlds = new DoStores();
h.withStoreRepo = (id, fn) => worlds.withStoreRepo(id, fn);
h.currentStoreId = () => worlds.currentStoreId();
h.doStub = id => worlds.doStub(id);
let raw: DatabaseSync;
const stub = new StubBillingProvider();
const run = crypto.randomUUID().slice(0, 8);
let emailSpy: ReturnType<typeof vi.spyOn>;

const sub = (storeId: string) => prisma.storeSubscription.findUniqueOrThrow({ where: { storeId } });
const ledger = (storeId: string) =>
  prisma.billingEvent.findMany({ where: { storeId }, orderBy: { createdAt: 'asc' } });
/** The directory row (D1 `stores`): what billing decides on and what the access gate reads. */
const storeRow = (id: string) => {
  const r = raw
    .prepare('SELECT status, plan, billing_suspended_reason FROM stores WHERE id = ?')
    .get(id) as { status: string; plan: string; billing_suspended_reason: string | null };
  return { status: r.status, plan: r.plan, billingSuspendedReason: r.billing_suspended_reason };
};
const planPrice = async (code: string, interval: 'monthly' | 'yearly') => {
  const p = await prisma.plan.findUniqueOrThrow({ where: { code } });
  return interval === 'yearly' ? p.priceYearlyMinor! : p.priceMonthlyMinor!;
};

let storeSeq = 0;
/** A store for `ownerId`: a D1 directory row (older = lower `createdAt`) + a StoreDO with a profile and one enabled payment method. */
function mkStore(ownerId: string, tag: string, status = 'inactive'): string {
  storeSeq += 1;
  const id = crypto.randomUUID();
  const slug = `fn-${tag}-${run}-${storeSeq}`;
  raw
    .prepare(
      `INSERT INTO stores (id, name, slug, owner_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, `F ${tag}`, slug, ownerId, status, Date.now() - 1_000_000 + storeSeq * 1000);
  const w = worlds.add(id);
  w.seedProfile({ name: `F ${tag}`, slug, ownerId }, { status });
  insertSqlite(w.sqlite, 'PaymentConfig', [
    { id: crypto.randomUUID(), storeId: id, provider: 'cod', isEnabled: true },
  ]);
  return id;
}
function mkOwner(tag: string): { ownerId: string; email: string } {
  const ownerId = crypto.randomUUID();
  const email = `funnel-${tag}-${run}@test.local`;
  h.accounts.set(ownerId, { role: 'store_admin', email });
  return { ownerId, email };
}

/** A self-serve store on the signup trial, as onboarding creates it (free row, then the Growth trial with the chosen plan). */
async function trialStore(
  tag: string,
  choice: { planCode: string; interval: 'monthly' | 'yearly' } = {
    planCode: 'growth',
    interval: 'monthly',
  },
  owner = mkOwner(tag)
) {
  const storeId = mkStore(owner.ownerId, tag);
  await prisma.storeSubscription.create({ data: { storeId, planCode: 'free', status: 'active' } });
  await startSignupTrial(prisma, storeId, choice);
  return { storeId, ...owner };
}
/** An additional store of the same owner on the owner's (parent's) plan, inactive until it goes live. */
async function childStore(tag: string, owner: { ownerId: string }) {
  const storeId = mkStore(owner.ownerId, tag);
  await prisma.storeSubscription.create({ data: { storeId, planCode: 'free', status: 'active' } });
  return storeId;
}

beforeAll(() => {
  raw = installPlatformD1(['billing', 'access', 'platform', 'payments']);
  seedBillingCatalog(raw);
  setBillingProviderForTests(stub);
  process.env.EBDA_INSTAPAY_HANDLE = 'ebda@instapay';
});
beforeEach(() => {
  stub.reset();
  emailSpy = vi.spyOn(EmailService, 'sendSubscriptionBillingNotice').mockResolvedValue(undefined);
  vi.spyOn(EmailService, 'sendWelcome').mockResolvedValue(undefined as never);
  vi.spyOn(socketService, 'notifyStore').mockImplementation(() => undefined);
  mockPrivateStorage(); // the InstaPay receipt screenshot goes to an in-memory bucket
});
afterAll(() => {
  setBillingProviderForTests(null);
  resetModel();
  delete process.env.EBDA_INSTAPAY_HANDLE;
  uninstallPlatformD1();
});

const inStore = <T>(id: string, fn: () => Promise<T>) => worlds.withStoreRepo(id, fn);
const goLive = (id: string) => inStore(id, () => OnboardingService.goLive(id));
const DAY = 86_400_000;

async function saveCard(storeId: string, token = `tok_ok_${crypto.randomUUID().slice(0, 6)}`) {
  const { billingEventId } = await startCardSetup({ storeId, provider: stub });
  const { rawBody, headers } = StubBillingProvider.signedWebhook(
    {
      id: `evt_${billingEventId}_saved`,
      type: 'card.saved',
      merchantOrderId: billingEventId,
      chargeId: null,
      amountMinor: 0,
      token,
      last4: '4242',
      brand: 'visa',
    },
    STUB_WEBHOOK_SECRET
  );
  return handleBillingWebhook('stub', rawBody, headers);
}
const paid = (
  storeId: string,
  ownerId: string,
  ref: string,
  planCode = 'business',
  amount = 999000
) =>
  recordManualPayment({
    storeId,
    planCode,
    interval: 'monthly',
    amountMinor: amount,
    method: 'instapay',
    reference: ref,
    paidAt: new Date(),
    periodStart: new Date(),
    periodEnd: addDays(new Date(), 30),
    actorId: ownerId,
  });

describe('signup funnel: store writes (platform D1 + one StoreDO per store)', () => {
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
      await goLive(storeId);

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
      expect(storeRow(storeId).status).toBe('active');

      // Grace over: suspended once (double run changes nothing more).
      const graceOver = new Date(addDays(due, 3).getTime() + 60_000);
      const c1 = await runBillingCycle(graceOver, stub, only);
      const c2 = await runBillingCycle(graceOver, stub, only);
      expect(c1.suspended).toBe(1);
      expect(c2.suspended).toBe(0);
      expect(storeRow(storeId)).toMatchObject({
        status: 'suspended',
        billingSuspendedReason: 'unpaid',
      });
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
      expect(storeRow(storeId)).toMatchObject({
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
      const claims = await prisma.manualPaymentClaim.findMany({ where: { storeId } });
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
      const res = await request(app)
        .post(`/api/v1/admin/stores/${storeId}/manual-payment`)
        .set('x-test-user', ownerId)
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
    await goLive(first.storeId);
    const extra: string[] = [];
    for (const n of [2, 3]) {
      const childId = await childStore('child', first);
      extra.push(childId);
      await goLive(childId); // rides the oldest store's Business plan
    }
    for (const id of extra) expect(storeRow(id).status).toBe('active');

    await inStore(first.storeId, () =>
      planService.assignPlan(first.storeId, { planCode: 'growth' })
    );
    expect(storeRow(first.storeId).status).toBe('active');
    for (const id of extra) {
      expect(storeRow(id)).toMatchObject({
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

    await inStore(first.storeId, () =>
      planService.assignPlan(first.storeId, { planCode: 'business' })
    );
    for (const id of extra) {
      expect(storeRow(id)).toMatchObject({
        status: 'active',
        billingSuspendedReason: null,
      });
    }
  });

  it('a billing suspension is written to the D1 directory row AND to the store DO (the single writer, in order)', async () => {
    const { storeId } = await trialStore('both');
    await chooseInstapay(storeId);
    await goLive(storeId);
    expect(await suspendForBilling(storeId, 'unpaid')).toBe(true);
    expect(await suspendForBilling(storeId, 'unpaid')).toBe(false); // a second run changes nothing
    expect(storeRow(storeId)).toMatchObject({
      status: 'suspended',
      billingSuspendedReason: 'unpaid',
    });
    const doStatus = worlds.get(storeId).rows('SELECT status FROM store_profile')[0];
    expect(doStatus.status).toBe('suspended');
    expect(await restoreFromBilling(storeId, 'unpaid')).toBe(true);
    expect(storeRow(storeId)).toMatchObject({ status: 'active', billingSuspendedReason: null });
    expect(worlds.get(storeId).rows('SELECT status FROM store_profile')[0].status).toBe('active');
  });

  it('a super-admin suspension is never lifted by billing', async () => {
    const { storeId } = await trialStore('opsusp');
    await chooseInstapay(storeId);
    await goLive(storeId);
    await inStore(storeId, () => StoreService.setStatus(storeId, 'suspended')); // operator, reason NULL
    expect(await restoreFromBilling(storeId, 'unpaid')).toBe(false);
    expect(await restoreFromBilling(storeId, 'over_store_limit')).toBe(false);
    await reconcileStoreAccess(storeId);
    expect(storeRow(storeId)).toMatchObject({
      status: 'suspended',
      billingSuspendedReason: null,
    });
  });

  it('an inactive (never live) store is not suspended by billing', async () => {
    const { storeId } = await trialStore('inactive');
    expect(await suspendForBilling(storeId, 'unpaid')).toBe(false);
    expect(storeRow(storeId)).toMatchObject({
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
    await goLive(first.storeId);
    const childId = await childStore('child', first);
    await goLive(childId); // rides the parent's Business plan
    return { parent: first, childId };
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
    await prisma.storeSubscription.update({
      where: { storeId: childId },
      data: {
        status: 'active',
        billingMethod: 'instapay',
        currentPeriodStart: addDays(new Date(), -31),
        currentPeriodEnd: addDays(new Date(), -1),
      },
    });
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
    await prisma.storeSubscription.update({
      where: { storeId: childId },
      data: {
        planCode: 'basic',
        status: 'trialing',
        trialEndsAt: addDays(new Date(), 2),
        billingMethod: 'instapay',
      },
    });
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
    expect(storeRow(childId)).toMatchObject({
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
    expect(storeRow(parent.storeId)).toMatchObject({ status: 'active' });
    expect(storeRow(childId)).toMatchObject({
      status: 'active',
      billingSuspendedReason: null,
    });
  });

  it('the billing parent cannot be hard-deleted while the owner has other stores', async () => {
    const { parent } = await businessFamily('pcdelete');
    await expect(
      inStore(parent.storeId, () => StoreService.delete(parent.storeId))
    ).rejects.toMatchObject({
      code: 'STORE_IS_BILLING_PARENT',
    });
  });

  it('when the parent lapses to a one-store plan, the child is suspended and pays nothing', async () => {
    const { parent, childId } = await businessFamily('pclapse');
    await inStore(parent.storeId, () =>
      planService.assignPlan(parent.storeId, { planCode: 'growth' })
    );
    expect(storeRow(childId)).toMatchObject({
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
    await inStore(storeId, () => planService.assignPlan(storeId, { planCode: 'comped' }));
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
    expect(storeRow(storeId).plan).toBe('professional');
    expect((await ledger(storeId)).filter(r => r.type === 'manual_payment')).toHaveLength(0);

    const again = await runCompMigration({ storeId, coveredUntil }, { apply: true });
    expect(again).toMatchObject({ applied: false, plan: { action: 'noop' } });
    expect((await sub(storeId)).paymentReference).toBe(after.paymentReference);
  });

  it('refuses a comped CHILD store (it would sit unbilled and keep getting reminders)', async () => {
    const first = await trialStore('compchild');
    const childId = await childStore('child', first);
    await prisma.storeSubscription.update({
      where: { storeId: childId },
      data: { planCode: 'comped', status: 'comped' },
    });
    const res = await runCompMigration(
      { storeId: childId, coveredUntil: addDays(new Date(), 30) },
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
