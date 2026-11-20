/**
 * InstaPay receipts — money batch A (Rulings EBDA-MONEYA-1..6), against a real
 * Postgres, the code under test bound to a REAL `ebda_app` login (strict RLS, no
 * bypass). Gemini is mocked with the RECORDED answers for two synthetic receipts
 * (tests/fixtures/instapay, no real PII); the private bucket is in-memory.
 *
 * Who approves (Ahmad, 2026-10-08):
 *   - a shopper's order payment: the STORE's owner / staff — never Ebda's super-admin;
 *   - a merchant's subscription payment: ONLY Ebda's super-admin — never the merchant.
 *
 * Mutation proofs (run by hand, recorded in the PR body):
 *   MA-1 duplicate reference: drop `referenceKey` from InstapayReceiptService.submit's
 *        update -> "the same transfer reference cannot pay twice, anywhere" goes red.
 *   MA-2 nothing activates without approval: make submitSubscriptionReceipt set the
 *        subscription active -> "the merchant's receipt activates nothing" goes red.
 *   MA-4 48h exemption: drop the `paymentConfirmationExpiresAt: null` freeze in
 *        submitReceipt AND the proofSubmitted() skip in expireOne -> "an order whose
 *        shopper sent proof is not auto-cancelled" goes red.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  createPrismaClient,
  runInTenantContext,
  runWithRequestDb,
  type AppPrismaClient,
} from '@ebda/database';
import { config } from '@api/config';
import { inngest } from '@api/lib/inngest/client';
import { OneSignalService } from '@api/services/onesignal.service';
import { EmailService } from '@api/services/email.service';
import { socketService } from '@api/services/socket.service';
import paymentRoutes from '@api/routes/payment.routes';
import orderRoutes from '@api/routes/order.routes';
import adminRoutes from '@api/routes/admin.routes';
import billingRoutes from '@api/routes/billing.routes';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { tenantContext, billingRouteContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';
import { InstapayService, runPostCommit } from '@api/services/payment-providers/instapay.service';
import { InstapayReceiptService } from '@api/services/payment-providers/instapay-receipt.service';
import {
  chooseInstapay,
  chooseInstapayPlan,
  recordManualPayment,
  recordManualRefund,
  rejectClaim,
} from '@api/services/billing/account.service';
import { ProvisioningService } from '@api/services/provisioning.service';
import {
  fieldsFrom,
  freshReference,
  mockPrivateStorage,
  resetModel,
  submitTestSubscriptionReceipt,
  uniqueImage,
  useRecordedModel,
} from '../helpers/instapay-receipt-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const BYPASS = `ipx-bypass-${run}`;
process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The synthetic "sent" receipt shows 1,234.50 EGP paid to demostore@instapay. */
const TOTAL = 123_450;
const HANDLE = 'demostore@instapay';

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const sign = (userId: string, role: string) =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

describe.skipIf(!hasDb)('InstaPay receipts (money batch A)', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const users: string[] = [];
  const storeIds: string[] = [];
  let seq = 0;
  let superAdmin: { id: string; jwt: string };

  async function mkUser(tag: string, role: string) {
    const u = await owner.user.create({
      data: {
        email: `ipx-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}@test.local`,
        passwordHash: 'x',
        firstName: 'Ip',
        lastName: tag,
        role: role as never,
        emailVerified: true,
      },
    });
    users.push(u.id);
    return u;
  }

  /** A live store taking InstaPay orders (paid to demostore@instapay). */
  async function mkStore(tag: string) {
    const user = await mkUser(tag, 'store_admin');
    const store = await owner.store.create({
      data: {
        name: `ipx-${tag}-${run}`,
        slug: `ipx-${tag}-${run}-${seq++}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    storeIds.push(store.id);
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const product = await owner.product.create({
      data: {
        storeId: store.id,
        name: 'Tee',
        slug: `tee-${tag}-${run}`,
        price: TOTAL,
        inventory: 50,
        status: 'active',
      },
    });
    await owner.paymentConfig.create({
      data: {
        storeId: store.id,
        provider: 'instapay',
        isEnabled: true,
        displayName: 'InstaPay',
        settings: { handle: HANDLE, phone: '01012345678', expiryHours: 48 },
      },
    });
    return {
      id: store.id,
      userId: user.id,
      jwt: sign(user.id, 'store_admin'),
      productId: product.id,
    };
  }

  type S = Awaited<ReturnType<typeof mkStore>>;

  /** A pending order put on the InstaPay hold exactly as POST /payments/create does. */
  async function heldOrder(s: S) {
    seq += 1;
    const o = await owner.order.create({
      data: {
        storeId: s.id,
        orderNumber: `IPX-${run}-${seq}`,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal: TOTAL,
        total: TOTAL,
        createdAt: new Date(Date.now() - 4 * DAY),
        shippingAddress: { firstName: 'Mona', lastName: 'Adel', email: 'mona@example.com' },
        billingAddress: {},
        items: {
          create: [
            { productId: s.productId, productName: 'Tee', quantity: 1, price: TOTAL, total: TOTAL },
          ],
        },
      },
    });
    const after: Array<{ name: string; task: () => Promise<unknown> }> = [];
    await asApp(() =>
      runInTenantContext(s.id, () =>
        InstapayService.initiate({
          storeId: s.id,
          order: {
            id: o.id,
            orderNumber: o.orderNumber,
            total: o.total,
            walletAmount: 0,
            currency: 'EGP',
            status: 'pending',
          },
          customer: { name: 'Mona', email: 'mona@example.com' },
          now: new Date(Date.now() - 4 * DAY),
          postCommit: (name, task) => after.push({ name, task }),
        })
      )
    );
    await asApp(() => runPostCommit(after));
    return o;
  }

  /** Shopper: upload the screenshot, the AI job reads it (recorded answer), submit. */
  async function shopperProof(s: S, orderId: string, over: Parameters<typeof fieldsFrom>[1] = {}) {
    useRecordedModel('receipt-sent');
    const up = await asApp(() =>
      InstapayService.uploadReceipt(s.id, orderId, uniqueImage('receipt-sent'))
    );
    expect(up.extractionStatus).toBe('pending');
    expect(await asApp(() => InstapayReceiptService.runExtraction(s.id, up.id))).toBe('done');
    const read = await asApp(() => InstapayService.getReceipt(s.id, orderId, up.id));
    expect(read.extracted?.reference).toBe('482193377105');
    return asApp(() =>
      InstapayService.submitReceipt({
        storeId: s.id,
        orderId,
        receiptId: up.id,
        // The transfer happened after the order (held 4 days ago): yesterday. The recorded
        // screenshot's own date (2026-10-05) fell before "now - 4 days" from 2026-10-10 on,
        // which added DATE_BEFORE_ORDER (a calendar time bomb, like the subscription helper avoids).
        fields: fieldsFrom('receipt-sent', {
          reference: freshReference(),
          transferDate: new Date(Date.now() - DAY).toISOString().slice(0, 10),
          ...over,
        }),
      })
    );
  }

  const orderRow = (id: string) => owner.order.findUniqueOrThrow({ where: { id } });
  const http = () => {
    const t = request(app);
    const wrap = (m: 'get' | 'post' | 'put') => (url: string) =>
      t[m](url).set('x-load-test-token', BYPASS);
    return { get: wrap('get'), post: wrap('post'), put: wrap('put') };
  };
  const bearer = (j: string) => ({ Authorization: `Bearer ${j}` });

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4, role: 'owner' });
    await redis.connect().catch(() => undefined);
    process.env.EBDA_INSTAPAY_HANDLE = 'ebdatest@instapay';
    app = express();
    app.use(express.json());
    app.use('/api/v1/payments', paymentRoutes);
    app.use('/api/v1/stores/:storeId/orders', tenantContext, orderRoutes);
    app.use('/api/v1/stores/:storeId/billing', billingRouteContext, billingRoutes);
    app.use('/api/v1/admin', adminRoutes);
    app.use(errorHandler);
    const sa = await mkUser('super', 'super_admin');
    superAdmin = { id: sa.id, jwt: sign(sa.id, 'super_admin') };
  });

  beforeEach(() => {
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
    vi.spyOn(EmailService, 'sendSubscriptionBillingNotice').mockResolvedValue(undefined);
    vi.spyOn(EmailService, 'sendWelcome').mockResolvedValue(undefined as never);
    vi.spyOn(socketService, 'notifyStore').mockImplementation(() => undefined);
    mockPrivateStorage();
  });

  afterAll(async () => {
    resetModel();
    delete process.env.EBDA_INSTAPAY_HANDLE;
    const ids = storeIds;
    const del = (p: Promise<unknown>) => p.catch(() => undefined);
    await del(owner.instapayReceipt.deleteMany({ where: { storeId: { in: ids } } }));
    await del(owner.paymentEvent.deleteMany({ where: { storeId: { in: ids } } }));
    await del(owner.orderEvent.deleteMany({ where: { storeId: { in: ids } } }));
    await del(owner.payment.deleteMany({ where: { order: { storeId: { in: ids } } } }));
    await del(owner.orderItem.deleteMany({ where: { order: { storeId: { in: ids } } } }));
    await del(owner.auditLog.deleteMany({ where: { storeId: { in: ids } } }));
    await del(owner.order.deleteMany({ where: { storeId: { in: ids } } }));
    await del(owner.store.deleteMany({ where: { id: { in: ids } } }));
    await del(owner.store.deleteMany({ where: { ownerId: { in: users } } }));
    await del(owner.user.deleteMany({ where: { id: { in: users } } }));
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
  });

  // ─────────────────────────── shopper -> store ───────────────────────────
  describe('a shopper pays a store order by InstaPay', () => {
    it('upload -> AI pre-fill -> submit: flags computed, NOTHING activates, merchant notified', async () => {
      const s = await mkStore('flow');
      const o = await heldOrder(s);
      const receipt = await shopperProof(s, o.id);
      expect(receipt.status).toBe('submitted');
      // Only the (test's) fresh reference differs from what the AI read.
      expect(receipt.flags).toEqual(['FIELDS_CORRECTED']);
      expect(receipt.expectedAmountMinor).toBe(TOTAL);
      const row = await orderRow(o.id);
      expect(row.status).toBe('awaiting_payment_confirmation');
      expect(row.paymentStatus).toBe('unpaid');
      expect(OneSignalService.notifyAdminsOfInstapay).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: o.id, kind: 'proof_submitted' })
      );
      const view = await asApp(() => InstapayService.getInstructions(s.id, o.id));
      expect(view.proof).toMatchObject({ status: 'submitted' });
      // The screenshot is only in the private bucket, as bytes for the reviewer.
      const img = await asApp(() =>
        InstapayReceiptService.readImage(s.id, receipt.id, { kind: 'order', orderId: o.id })
      );
      expect(img.mimeType).toBe('image/png');
    });

    it('an order whose shopper sent proof is not auto-cancelled at 48h, and the merchant can still confirm', async () => {
      const s = await mkStore('exempt');
      const o = await heldOrder(s); // its 48h window ended 2 days ago
      await shopperProof(s, o.id);
      const late = new Date(Date.now() + 10 * DAY);
      const sweep = await asApp(() => InstapayService.expireDue(s.id, late));
      expect(sweep.expired).toBe(0);
      expect(await asApp(() => InstapayService.expireOne(s.id, o.id, late))).toBe('skipped');
      expect((await orderRow(o.id)).status).toBe('awaiting_payment_confirmation');
      const out = await asApp(() =>
        InstapayService.confirm({ storeId: s.id, orderId: o.id, actorUserId: s.userId })
      );
      expect(out).toMatchObject({ changed: true, status: 'confirmed' });
      expect(
        await owner.instapayReceipt.findFirstOrThrow({ where: { orderId: o.id } })
      ).toMatchObject({
        status: 'approved',
        reviewedBy: s.userId,
      });
    });

    it('an order with NO proof still expires (the exemption is not a blanket)', async () => {
      const s = await mkStore('noproof');
      const o = await heldOrder(s);
      expect(await asApp(() => InstapayService.expireOne(s.id, o.id, new Date()))).toBe('expired');
      expect((await orderRow(o.id)).status).toBe('cancelled');
    });

    it('a reference sent before receipts existed (legacy) is exempt too', async () => {
      const s = await mkStore('legacy');
      const o = await heldOrder(s);
      const p = await owner.payment.findFirstOrThrow({ where: { orderId: o.id } });
      await owner.payment.update({
        where: { id: p.id },
        data: { metadata: { ...(p.metadata as object), customerReference: 'IPN 4821' } },
      });
      expect(await asApp(() => InstapayService.expireOne(s.id, o.id, new Date()))).toBe('skipped');
    });

    it('the same transfer reference cannot pay twice, anywhere (other store, subscription)', async () => {
      const a = await mkStore('dupa');
      const b = await mkStore('dupb');
      const ref = freshReference();
      await shopperProof(a, (await heldOrder(a)).id, { reference: ref });
      // Same reference with spaces, at ANOTHER store.
      await expect(
        shopperProof(b, (await heldOrder(b)).id, {
          reference: `${ref.slice(0, 6)} ${ref.slice(6)}`,
        })
      ).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE' });
      // ...and as a merchant's subscription payment.
      const t = await trialStore('dupsub');
      await asApp(() => chooseInstapay(t.storeId));
      await expect(
        asApp(() => submitTestSubscriptionReceipt(t.storeId, { reference: ref }))
      ).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE' });
    });

    it('the merchant rejects with a reason: the hold restarts, the reference is freed', async () => {
      const s = await mkStore('reject');
      const o = await heldOrder(s);
      const ref = freshReference();
      const r1 = await shopperProof(s, o.id, { reference: ref });
      await expect(
        asApp(() =>
          InstapayService.rejectReceipt({
            storeId: s.id,
            orderId: o.id,
            receiptId: r1.id,
            note: '',
            actorUserId: s.userId,
          })
        )
      ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      const out = await asApp(() =>
        InstapayService.rejectReceipt({
          storeId: s.id,
          orderId: o.id,
          receiptId: r1.id,
          note: 'Amount is lower than the order',
          actorUserId: s.userId,
        })
      );
      expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
      const row = await orderRow(o.id);
      expect(row.status).toBe('awaiting_payment_confirmation');
      expect(row.paymentConfirmationExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
      const view = await asApp(() => InstapayService.getInstructions(s.id, o.id));
      expect(view.proof).toMatchObject({
        status: 'rejected',
        reviewNote: 'Amount is lower than the order',
      });
      // The shopper sends the right one with the same transfer reference.
      const r2 = await shopperProof(s, o.id, { reference: ref });
      expect(r2.status).toBe('submitted');
    });

    it('flags (never blocks) a wrong amount and a wrong receiver; an AI failure falls back to manual entry', async () => {
      const s = await mkStore('flags');
      const o = await heldOrder(s);
      const r = await shopperProof(s, o.id, {
        amountMinor: 100_000,
        receiverHandle: 'someoneelse@instapay',
      });
      expect(r.flags).toEqual(
        expect.arrayContaining(['AMOUNT_MISMATCH', 'RECEIVER_MISMATCH', 'FIELDS_CORRECTED'])
      );

      const o2 = await heldOrder(s);
      vi.mocked(inngest.send).mockRejectedValueOnce(new Error('queue down'));
      const up = await asApp(() =>
        InstapayService.uploadReceipt(s.id, o2.id, uniqueImage('receipt-sent'))
      );
      expect(up.extractionStatus).toBe('failed');
      const sub = await asApp(() =>
        InstapayService.submitReceipt({
          storeId: s.id,
          orderId: o2.id,
          receiptId: up.id,
          fields: fieldsFrom('receipt-sent', { reference: freshReference() }),
        })
      );
      expect(sub.flags).toContain('AI_UNAVAILABLE');
    });

    it('refuses a non-image upload', async () => {
      const s = await mkStore('notimg');
      const o = await heldOrder(s);
      await expect(
        asApp(() => InstapayService.uploadReceipt(s.id, o.id, Buffer.from('%PDF-1.7 fake')))
      ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    });

    it('the merchant records an InstaPay refund: full -> order refunded; replay = no double', async () => {
      const s = await mkStore('refund');
      const o = await heldOrder(s);
      await shopperProof(s, o.id);
      await asApp(() =>
        InstapayService.confirm({ storeId: s.id, orderId: o.id, actorUserId: s.userId })
      );
      const input = {
        reference: freshReference(),
        refundDate: new Date().toISOString().slice(0, 10),
        refundTime: '00:01',
        recipientName: 'SYNTH TEST PAYER',
        amountMinor: 23_450,
      };
      const part = await asApp(() =>
        InstapayService.recordRefund({ storeId: s.id, orderId: o.id, input, actorUserId: s.userId })
      );
      expect(part).toMatchObject({
        duplicate: false,
        status: 'partially_refunded',
        refundedAmount: 23_450,
      });
      const again = await asApp(() =>
        InstapayService.recordRefund({ storeId: s.id, orderId: o.id, input, actorUserId: s.userId })
      );
      expect(again.duplicate).toBe(true);
      const rest = await asApp(() =>
        InstapayService.recordRefund({
          storeId: s.id,
          orderId: o.id,
          input: { ...input, reference: freshReference(), amountMinor: 100_000 },
          actorUserId: s.userId,
        })
      );
      expect(rest.status).toBe('refunded');
      const row = await orderRow(o.id);
      expect(row).toMatchObject({ status: 'refunded', paymentStatus: 'refunded' });
      const pay = await owner.payment.findFirstOrThrow({ where: { orderId: o.id } });
      expect(pay.refundedAmount).toBe(TOTAL);
    });
  });

  // ──────────────────────────── merchant -> Ebda ───────────────────────────
  const emailsOf = () =>
    vi.mocked(EmailService.sendSubscriptionBillingNotice).mock.calls.map(c => c[1].kind);

  async function trialStore(tag: string, ownerEmail?: string) {
    const email = ownerEmail ?? `ipx-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}@test.local`;
    const r = await ProvisioningService.provisionStore({
      storeName: `X ${tag}`,
      storeSlug: `ipx-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}`,
      plan: 'professional',
      growthTrial: true,
      trialChoice: { planCode: 'growth', interval: 'monthly' },
      status: 'inactive',
      ownerEmail: email,
      ownerName: 'Receipt Owner',
    });
    storeIds.push(r.store.id);
    if (!users.includes(r.owner.id)) users.push(r.owner.id);
    return { storeId: r.store.id, ownerId: r.owner.id, email };
  }
  const subOf = (storeId: string) =>
    owner.storeSubscription.findUniqueOrThrow({ where: { storeId } });

  describe('a merchant pays Ebda by InstaPay', () => {
    it("the merchant's receipt activates nothing; Ebda's approval does, from the trial end (no days burned)", async () => {
      const t = await trialStore('subflow');
      const details = await asApp(() =>
        chooseInstapayPlan({ storeId: t.storeId, planCode: 'basic', interval: 'yearly' })
      );
      expect(details).toMatchObject({ planCode: 'basic', interval: 'yearly' });
      const before = await subOf(t.storeId);
      const { claim, receipt } = await asApp(() =>
        submitTestSubscriptionReceipt(t.storeId, { amountMinor: details!.amountMinor! })
      );
      expect(receipt.flags).not.toContain('AMOUNT_MISMATCH');
      expect(receipt.expectedReceiver).toBe('ebdatest@instapay');
      const still = await subOf(t.storeId);
      expect(still).toMatchObject({ status: 'trialing', planCode: before.planCode });
      expect(still.currentPeriodEnd?.getTime() ?? null).toBe(
        before.currentPeriodEnd?.getTime() ?? null
      );

      const rec = await asApp(() =>
        recordManualPayment({
          storeId: t.storeId,
          planCode: claim.planCode,
          interval: 'yearly',
          amountMinor: claim.amountMinor,
          method: 'instapay',
          reference: receipt.fields.reference!,
          paidAt: new Date(),
          actorId: superAdmin.id,
          claimId: claim.id,
        })
      );
      expect(rec.periodStart!.getTime()).toBe(before.trialEndsAt!.getTime());
      const after = await subOf(t.storeId);
      expect(after).toMatchObject({
        status: 'active',
        planCode: 'basic',
        billingInterval: 'yearly',
      });
      expect(after.currentPeriodStart!.getTime()).toBe(before.trialEndsAt!.getTime());
      expect(
        await owner.instapayReceipt.findUniqueOrThrow({ where: { id: receipt.id } })
      ).toMatchObject({
        status: 'approved',
        reviewedBy: superAdmin.id,
      });
      expect(emailsOf()).toContain('payment_confirmed');
    });

    it('QA-123: an early downgrade receipt is ACCEPTED as a held claim (flagged), refused for approval until due, then the period starts at the current end', async () => {
      const t = await trialStore('subdown');
      const now = Date.now();
      const periodStart = new Date(now - 30 * 86_400_000);
      const periodEnd = new Date(now + 335 * 86_400_000);
      await owner.storeSubscription.update({
        where: { storeId: t.storeId },
        data: {
          status: 'active',
          planCode: 'growth',
          billingInterval: 'yearly',
          billingMethod: 'instapay',
          trialEndsAt: null,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });
      const details = await asApp(() =>
        chooseInstapayPlan({ storeId: t.storeId, planCode: 'basic', interval: 'monthly' })
      );
      // the merchant is shown nothing to pay yet
      expect(details).toMatchObject({
        notDue: true,
        handle: null,
        mobile: null,
        amountMinor: null,
        qrUrl: null,
      });
      // the money may already be sent: the receipt is accepted, never refused
      const basicPrice = (await owner.plan.findUniqueOrThrow({ where: { code: 'basic' } }))
        .priceMonthlyMinor!;
      const { claim, receipt } = await asApp(() =>
        submitTestSubscriptionReceipt(t.storeId, {
          amountMinor: basicPrice,
        })
      );
      expect(receipt.flags).toContain('PAYMENT_NOT_DUE');
      expect(claim.status).toBe('pending');
      const rec = (over: Date | null) =>
        asApp(() =>
          recordManualPayment({
            storeId: t.storeId,
            planCode: claim.planCode,
            interval: 'monthly',
            amountMinor: claim.amountMinor,
            method: 'instapay',
            reference: receipt.fields.reference!,
            paidAt: new Date(),
            actorId: superAdmin.id,
            claimId: claim.id,
            ...(over ? { now: over } : {}),
          })
        );
      // approval a year early is refused; the claim stays pending
      await expect(rec(null)).rejects.toMatchObject({ code: 'PAYMENT_NOT_DUE_YET' });
      expect(
        await owner.manualPaymentClaim.findUniqueOrThrow({ where: { id: claim.id } })
      ).toMatchObject({ status: 'pending' });
      // inside the 7-day window it is approved and the paid period starts at the CURRENT END (EBDA-MONEYA-6 unchanged)
      const res = await rec(new Date(periodEnd.getTime() - 3 * 86_400_000));
      expect(res.periodStart!.getTime()).toBe(periodEnd.getTime());
    });

    it('Ebda rejects with a reason: the merchant is told, the reference can be filed again', async () => {
      const t = await trialStore('subrej');
      await asApp(() => chooseInstapay(t.storeId));
      const ref = freshReference();
      const { claim, receipt } = await asApp(() =>
        submitTestSubscriptionReceipt(t.storeId, { reference: ref })
      );
      await asApp(() =>
        rejectClaim({
          storeId: t.storeId,
          claimId: claim.id,
          note: 'Wrong amount',
          actorId: superAdmin.id,
        })
      );
      expect(
        await owner.instapayReceipt.findUniqueOrThrow({ where: { id: receipt.id } })
      ).toMatchObject({
        status: 'rejected',
        reviewNote: 'Wrong amount',
        referenceKey: null,
      });
      expect(emailsOf()).toContain('payment_rejected');
      const again = await asApp(() => submitTestSubscriptionReceipt(t.storeId, { reference: ref }));
      expect(again.claim.status).toBe('pending');
    });

    it('void a payment recorded for the wrong store: period goes back, the reference is freed; refunds are idempotent', async () => {
      const wrong = await trialStore('voidwrong');
      const right = await trialStore('voidright');
      const ref = freshReference();
      const base = {
        planCode: 'growth',
        interval: 'monthly' as const,
        amountMinor: 349_000,
        method: 'instapay' as const,
        reference: ref,
        paidAt: new Date(),
        actorId: superAdmin.id,
      };
      const before = await subOf(wrong.storeId);
      const rec = await asApp(() => recordManualPayment({ ...base, storeId: wrong.storeId }));
      await expect(
        asApp(() => recordManualPayment({ ...base, storeId: right.storeId }))
      ).rejects.toMatchObject({ code: 'REFERENCE_USED_ELSEWHERE' });

      const voided = await asApp(() =>
        recordManualRefund({
          eventId: rec.billingEventId,
          kind: 'void',
          refundedAt: new Date(),
          note: 'Recorded on the wrong store',
          actorId: superAdmin.id,
        })
      );
      expect(voided.duplicate).toBe(false);
      const after = await subOf(wrong.storeId);
      expect(after.currentPeriodEnd!.getTime()).toBe(before.trialEndsAt!.getTime());
      const charge = await owner.billingEvent.findUniqueOrThrow({
        where: { id: rec.billingEventId },
      });
      expect(charge.status).toBe('refunded');
      // The right store can now get it, naming the voided payment (the ledger is append-only).
      expect(voided.voidedEventId).toBe(rec.billingEventId);
      const ok = await asApp(() =>
        recordManualPayment({
          ...base,
          storeId: right.storeId,
          replacesVoidedEventId: rec.billingEventId,
        })
      );
      await expect(
        asApp(() =>
          recordManualPayment({
            ...base,
            storeId: wrong.storeId,
            replacesVoidedEventId: ok.billingEventId,
          })
        )
      ).rejects.toMatchObject({ code: 'NOT_A_VOIDED_PAYMENT' });
      expect(ok.duplicate).toBe(false);

      // A real refund (money sent back) is idempotent on its reference.
      const refundRef = freshReference();
      const refund = (amountMinor: number) =>
        asApp(() =>
          recordManualRefund({
            eventId: ok.billingEventId,
            kind: 'refund',
            reference: refundRef,
            refundedAt: new Date(),
            recipientName: 'SYN*** T***',
            amountMinor,
            note: 'Merchant asked to cancel',
            actorId: superAdmin.id,
          })
        );
      const r1 = await refund(100_000);
      const r2 = await refund(100_000);
      expect(r2).toMatchObject({ duplicate: true, refundEventId: r1.refundEventId });
      const refunds = await owner.billingEvent.findMany({
        where: { relatedEventId: ok.billingEventId, type: 'refund' },
      });
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amountMinor).toBe(100_000);
    });

    it('a canceled store can choose a plan, pay by InstaPay and come back', async () => {
      const t = await trialStore('canceled');
      await owner.storeSubscription.update({
        where: { storeId: t.storeId },
        data: { status: 'canceled', planCode: 'free', trialEndsAt: null },
      });
      const details = await asApp(() =>
        chooseInstapayPlan({ storeId: t.storeId, planCode: 'growth', interval: 'monthly' })
      );
      expect(details!.amountMinor).toBeGreaterThan(0);
      expect((await subOf(t.storeId)).status).toBe('canceled');
      const { claim, receipt } = await asApp(() =>
        submitTestSubscriptionReceipt(t.storeId, { amountMinor: details!.amountMinor! })
      );
      await asApp(() =>
        recordManualPayment({
          storeId: t.storeId,
          planCode: claim.planCode,
          interval: 'monthly',
          amountMinor: claim.amountMinor,
          method: 'instapay',
          reference: receipt.fields.reference!,
          paidAt: new Date(),
          actorId: superAdmin.id,
          claimId: claim.id,
        })
      );
      expect(await subOf(t.storeId)).toMatchObject({ status: 'active', planCode: 'growth' });
    });

    it('paying for a store beyond the store allowance is refused with the store to pay on', async () => {
      const parent = await trialStore('parent');
      const child = await trialStore('child', parent.email);
      await owner.store.update({
        where: { id: child.storeId },
        data: {
          status: 'suspended',
          billingSuspendedReason: 'over_store_limit',
          billingSuspendedAt: new Date(),
        },
      });
      await expect(asApp(() => chooseInstapay(child.storeId))).rejects.toMatchObject({
        code: 'PAY_ON_PARENT_STORE',
        details: { parentStoreId: parent.storeId },
      });
    });
  });

  // ─────────────────────────── who may act (HTTP) ──────────────────────────
  describe('who approves: the store for orders, ONLY Ebda for subscriptions', () => {
    it("super-admin cannot approve, reject, refund or even list a store's order payment", async () => {
      const s = await mkStore('sa');
      const o = await heldOrder(s);
      const r = await shopperProof(s, o.id);
      const base = `/api/v1/stores/${s.id}/orders/${o.id}`;
      for (const res of [
        await asApp(async () =>
          http().post(`${base}/confirm-instapay`).set(bearer(superAdmin.jwt))
        ),
        await asApp(async () =>
          http()
            .post(`${base}/instapay-receipts/${r.id}/reject`)
            .set(bearer(superAdmin.jwt))
            .send({ note: 'nope nope' })
        ),
        await asApp(async () =>
          http().get(`${base}/instapay-receipts`).set(bearer(superAdmin.jwt))
        ),
        await asApp(async () =>
          http().get(`${base}/instapay-receipts/${r.id}/image`).set(bearer(superAdmin.jwt))
        ),
        await asApp(async () =>
          http().post(`${base}/instapay-refund`).set(bearer(superAdmin.jwt)).send({
            reference: '123456789012',
            refundDate: '2026-10-01',
            recipientName: 'x',
            amountMinor: 1,
          })
        ),
        // Sibling money routes hold the same line (security review: gate parity).
        await asApp(async () => http().post(`${base}/mark-paid`).set(bearer(superAdmin.jwt))),
        await asApp(async () =>
          http()
            .post(`/api/v1/stores/${s.id}/orders/bulk-mark-paid`)
            .set(bearer(superAdmin.jwt))
            .send({ orderIds: [o.id] })
        ),
        await asApp(async () =>
          http().post(`${base}/refund-via-provider`).set(bearer(superAdmin.jwt)).send({})
        ),
        await asApp(async () =>
          http().put(`${base}/status`).set(bearer(superAdmin.jwt)).send({ status: 'confirmed' })
        ),
      ]) {
        expect(res.status).toBe(403);
      }
      expect((await orderRow(o.id)).status).toBe('awaiting_payment_confirmation');
      // The store owner can.
      const own = await asApp(async () =>
        http().get(`${base}/instapay-receipts`).set(bearer(s.jwt))
      );
      expect(own.status).toBe(200);
      expect(own.body.data.receipts[0]).toMatchObject({ id: r.id, status: 'submitted' });
      const ok = await asApp(async () =>
        http().post(`${base}/confirm-instapay`).set(bearer(s.jwt))
      );
      expect(ok.status).toBe(200);
    });

    it("merchant A cannot act on merchant B's payments", async () => {
      const a = await mkStore('ma');
      const b = await mkStore('mb');
      const o = await heldOrder(b);
      const r = await shopperProof(b, o.id);
      const base = `/api/v1/stores/${b.id}/orders/${o.id}`;
      for (const res of [
        await asApp(async () => http().post(`${base}/confirm-instapay`).set(bearer(a.jwt))),
        await asApp(async () =>
          http()
            .post(`${base}/instapay-receipts/${r.id}/reject`)
            .set(bearer(a.jwt))
            .send({ note: 'not mine' })
        ),
        await asApp(async () =>
          http().get(`${base}/instapay-receipts/${r.id}/image`).set(bearer(a.jwt))
        ),
      ]) {
        expect(res.status).toBe(403);
      }
      // A's own store cannot reach B's receipt either (store-scoped read).
      const cross = await asApp(async () =>
        http()
          .get(`/api/v1/stores/${a.id}/orders/${o.id}/instapay-receipts/${r.id}/image`)
          .set(bearer(a.jwt))
      );
      expect(cross.status).toBe(404);
      // ...nor B's subscription receipts.
      const t = await trialStore('mbsub');
      await asApp(() => chooseInstapay(t.storeId));
      const sub = await asApp(() => submitTestSubscriptionReceipt(t.storeId));
      const peek = await asApp(async () =>
        http()
          .get(`/api/v1/stores/${t.storeId}/billing/receipts/${sub.receipt.id}`)
          .set(bearer(a.jwt))
      );
      expect(peek.status).toBe(403);
      expect((await orderRow(o.id)).status).toBe('awaiting_payment_confirmation');
    });

    it('a merchant cannot act on subscription payments (its own included)', async () => {
      const t = await trialStore('selfapprove');
      await asApp(() => chooseInstapay(t.storeId));
      const { claim, receipt } = await asApp(() => submitTestSubscriptionReceipt(t.storeId));
      const m = sign(t.ownerId, 'store_admin');
      const attempts = [
        await asApp(async () =>
          http().post(`/api/v1/admin/stores/${t.storeId}/manual-payment`).set(bearer(m)).send({
            planCode: 'growth',
            interval: 'monthly',
            amountMinor: 349_000,
            method: 'instapay',
            reference: receipt.fields.reference,
            paidAt: new Date().toISOString(),
            claimId: claim.id,
          })
        ),
        await asApp(async () =>
          http()
            .post(`/api/v1/admin/billing/claims/${claim.id}/reject`)
            .set(bearer(m))
            .send({ storeId: t.storeId, note: 'self' })
        ),
        await asApp(async () => http().get(`/api/v1/admin/billing/claims`).set(bearer(m))),
        await asApp(async () =>
          http()
            .get(`/api/v1/admin/billing/claims/${claim.id}/receipt?storeId=${t.storeId}`)
            .set(bearer(m))
        ),
      ];
      for (const res of attempts) expect(res.status).toBe(403);
      expect(await subOf(t.storeId)).toMatchObject({ status: 'trialing' });
      expect(
        await owner.manualPaymentClaim.findUniqueOrThrow({ where: { id: claim.id } })
      ).toMatchObject({
        status: 'pending',
      });
      // The old reference-only claim endpoint is gone.
      const old = await asApp(async () =>
        http()
          .post(`/api/v1/stores/${t.storeId}/billing/payment-claims`)
          .set(bearer(m))
          .send({ payerReference: '12345678' })
      );
      expect(old.status).toBe(410);
    });

    it('store staff may approve an order payment but not record a refund', async () => {
      const s = await mkStore('staff');
      const staff = await mkUser('staffer', 'staff');
      await owner.storeStaff.create({ data: { storeId: s.id, userId: staff.id } });
      const sj = sign(staff.id, 'staff');
      const o = await heldOrder(s);
      await shopperProof(s, o.id);
      const base = `/api/v1/stores/${s.id}/orders/${o.id}`;
      const refund = await asApp(async () =>
        http().post(`${base}/instapay-refund`).set(bearer(sj)).send({
          reference: '123456789012',
          refundDate: '2026-10-01',
          recipientName: 'x',
          amountMinor: 1,
        })
      );
      expect(refund.status).toBe(403);
      const ok = await asApp(async () => http().post(`${base}/confirm-instapay`).set(bearer(sj)));
      expect(ok.status).toBe(200);
    });
  });
});
