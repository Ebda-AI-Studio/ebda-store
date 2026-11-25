/**
 * Merchant Billing (SP5 task 1): the store's plan, subscription state and usage
 * against its limits. Read-only for the merchant; super-admin can also assign
 * a plan from this page via `PUT /admin/stores/:id/subscription`.
 *
 * Mounted at /stores/:storeId/billing. Task 3 (EGP billing) adds: invoices,
 * checkout (hosted card page), checkout return status, change-plan, cancel and
 * resume. The mount (`billingRouteContext`) keeps GETs in the request
 * transaction and runs writes under a store scope, because they call the
 * payment gateway and must not hold the request transaction across it.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { STUB_WEBHOOK_SECRET, StubBillingProvider, getBillingProvider } from '../services/billing';
import {
  cancelSubscription,
  changePlan,
  getSubscriptionBillingState,
  handleBillingWebhook,
  listStoreCharges,
  resumeSubscription,
  selectTrialPlan,
  startCardSetup,
  startCheckout,
} from '../services/billing/subscription-billing.service';
import { SIGNUP_PLAN_CODES } from '../services/billing/trial';
import {
  assertPayableStore,
  chooseInstapay,
  chooseInstapayPlan,
  listStoreClaims,
  submitSubscriptionReceipt,
} from '../services/billing/account.service';
import multer from 'multer';
import { INSTAPAY_RECEIPT_MAX_BYTES, instapayReceiptFieldsSchema } from '@ebda/shared';
import {
  InstapayReceiptService,
  toReceiptView,
} from '../services/payment-providers/instapay-receipt.service';
import { uploadLimiter, dailyUploadLimiter } from '../middleware/security';
import { auditLog } from '../middleware/security';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { prisma, withStore } from '@ebda/database';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { getUsageSummary } from '../services/plan-limit.service';
import { planService } from '../services/plan.service';
import addonsRoutes from './addons.routes';

const router = Router({ mergeParams: true });

// Add-ons + AI packs (SELF-SERVICE A8/A9): the same card flow, its own router.
router.use('/addons', addonsRoutes);

router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const payOn = await assertPayableStore(storeId).then(
        () => null,
        (err: { code?: string; details?: { parentStoreId?: string; included?: boolean } }) =>
          err?.code === 'PAY_ON_PARENT_STORE' ? (err.details ?? null) : null
      );
      const [{ entitlements: e, usage }, availablePlans] = await Promise.all([
        getUsageSummary(storeId),
        planService.listPlans({ publicOnly: true }),
      ]);
      res.json({
        success: true,
        data: {
          plan: {
            code: e.planCode,
            nameEn: e.planNameEn,
            nameAr: e.planNameAr,
            subscribedPlanCode: e.subscribedPlanCode,
            /** The feature-baseline tier of the EFFECTIVE plan: what the super-admin feature matrix must compare against. */
            featureTier: e.featureTier,
          },
          subscription: {
            status: e.status,
            currentPeriodEnd: e.currentPeriodEnd,
            trialEndsAt: e.trialEndsAt,
            cancelAtPeriodEnd: e.cancelAtPeriodEnd,
          },
          limits: e.limits,
          usage,
          /** First day (YYYY-MM-01) of the month the store passed its order cap, else null. */
          ordersOverLimitMonth: e.ordersOverLimitMonth
            ? e.ordersOverLimitMonth.toISOString().slice(0, 10)
            : null,
          availablePlans,
          billing: await getSubscriptionBillingState(storeId),
          provider: (() => {
            try {
              return getBillingProvider().name;
            } catch {
              return null; // InstaPay-only: no card gateway configured
            }
          })(),
          /**
           * Set when this store is beyond the owner's store allowance: paying HERE buys
           * nothing (audit M4); the UI sends the merchant to the main store instead.
           */
          payOnStore: payOn?.parentStoreId ?? null,
          /** true = a child INCLUDED in the main store's plan; false = paused beyond the allowance. */
          payOnStoreIncluded: payOn ? payOn.included === true : false,
          /** `inactive` until the go-live gate passes (onboarding / this page). */
          storeStatus:
            (await prisma.store.findUnique({ where: { id: storeId }, select: { status: true } }))
              ?.status ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

const guard = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
];
// BE:S-2 (Ruling FP-3): every billing WRITE (and the checkout-return that applies a charge) moves money or a stored card/plan, so
// an impersonated support session is refused. Reads keep `guard`.
const writeGuard = [
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
];

const checkoutSchema = z.object({
  planCode: z.string().min(1).max(64),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
});

/** GET /invoices — this store's charges (checkouts, renewals, upgrades, refunds). */
router.get('/invoices', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { charges: await listStoreCharges(req.params.storeId) } });
  } catch (err) {
    next(err);
  }
});

/** POST /checkout — hosted card page + first charge. Refuses a plan with no price. */
router.post('/checkout', ...writeGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = checkoutSchema.parse(req.body);
    const out = await startCheckout({ storeId: req.params.storeId, ...input });
    res.status(201).json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /checkout/return — the admin page forwards the gateway's redirect query
 * here. The browser's word is only a HINT; the answer reports the ledger row
 * (updated by the signed webhook), which is the source of truth.
 */
router.get(
  '/checkout/return',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hint = getBillingProvider().parseReturn(req.query as Record<string, unknown>);
      let status: string | null = null;
      let chargeId: string | null = null;
      if (hint.merchantOrderId && /^[0-9a-f-]{36}$/i.test(hint.merchantOrderId)) {
        const row = await withStore(req.params.storeId, tx =>
          tx.billingEvent.findFirst({
            where: { id: hint.merchantOrderId!, storeId: req.params.storeId },
            select: { status: true },
          })
        );
        status = row?.status ?? null;
        // The ledger row (this store's) the gateway returned for: the page prints THIS charge's receipt.
        chargeId = row ? hint.merchantOrderId : null;
      }
      res.json({ success: true, data: { hint: hint.outcome, status, chargeId } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /trial-plan — the plan (and interval) billed when the Growth trial ends
 * (signup funnel, Ruling EBDA-FUNNEL-3). Only while trialing.
 */
router.put(
  '/trial-plan',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = z
        .object({
          planCode: z.enum(SIGNUP_PLAN_CODES),
          interval: z.enum(['monthly', 'yearly']),
        })
        .strict()
        .parse(req.body);
      res.json({
        success: true,
        data: await selectTrialPlan({ storeId: req.params.storeId, ...input }),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /card-setup — hosted "save your card" page; NOTHING is charged. `from`
 * picks where the browser comes back (onboarding or this billing page); the
 * return URL is built here from config, never taken from the client.
 */
router.post(
  '/card-setup',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from } = z
        .object({ from: z.enum(['onboarding', 'billing']).default('onboarding') })
        .parse(req.body ?? {});
      const returnUrl =
        from === 'billing'
          ? `${config.adminUrl}/stores/${req.params.storeId}/billing?card=return`
          : `${config.adminUrl}/onboarding?card=return`;
      const out = await startCardSetup({ storeId: req.params.storeId, returnUrl });
      res.status(201).json({ success: true, data: out });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /payment-method — the merchant pays by InstaPay instead of a card (Ruling
 * EBDA-FUNNEL-9). Returns the unique payment reference to write on transfers.
 */
router.post(
  '/payment-method',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      z.object({ method: z.literal('instapay') })
        .strict()
        .parse(req.body);
      const out = await chooseInstapay(req.params.storeId);
      await auditLog({
        action: 'billing.method_chosen',
        userId: req.user!.userId,
        storeId: req.params.storeId,
        resourceType: 'store_subscription',
        resourceId: req.params.storeId,
        details: { method: 'instapay' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: out });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /payment-claims — this store's "I paid" submissions and their review status. */
router.get('/payment-claims', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { claims: await listStoreClaims(req.params.storeId) } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /payment-claims — RETIRED (money batch A): a reference alone is no longer
 * proof. The merchant uploads the InstaPay receipt screenshot (POST /receipts), then
 * submits the checked fields (POST /receipts/:id/submit). 410 tells an old client why.
 */
router.post('/payment-claims', ...writeGuard, (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'RECEIPT_REQUIRED',
      message: 'Upload the InstaPay receipt screenshot to report a payment',
    },
  });
});

/**
 * POST /instapay-plan — the plan + interval the next InstaPay payment buys (audit M3):
 * upgrade, downgrade, or pick a plan to come back from canceled. Nothing is charged
 * and the tier does not change until Ebda approves the payment.
 */
router.post(
  '/instapay-plan',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = z
        .object({ planCode: z.string().min(1).max(64), interval: z.enum(['monthly', 'yearly']) })
        .strict()
        .parse(req.body);
      const details = await chooseInstapayPlan({ storeId: req.params.storeId, ...input });
      await auditLog({
        action: 'billing.instapay_plan_chosen',
        userId: req.user!.userId,
        storeId: req.params.storeId,
        resourceType: 'store_subscription',
        resourceId: req.params.storeId,
        details: input,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: details });
    } catch (err) {
      next(err);
    }
  }
);

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INSTAPAY_RECEIPT_MAX_BYTES, files: 1 },
});

/**
 * POST /receipts — the merchant uploads the InstaPay receipt screenshot for the
 * subscription (multipart `file`). Stored in the PRIVATE bucket only; the AI read is
 * queued. Ebda's team (super-admin) reviews it — never the merchant.
 */
router.post(
  '/receipts',
  ...writeGuard,
  uploadLimiter,
  dailyUploadLimiter,
  receiptUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new AppError(400, 'NO_FILE', 'No file uploaded. Send field name: file');
      await assertPayableStore(req.params.storeId);
      const receipt = await InstapayReceiptService.upload({
        storeId: req.params.storeId,
        kind: 'subscription',
        file: req.file.buffer,
      });
      res.status(201).json({ success: true, data: { receipt } });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /receipts/:receiptId — poll the AI read (pre-filled fields + confidence). */
router.get(
  '/receipts/:receiptId',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const receiptId = z.string().uuid().parse(req.params.receiptId);
      const row = await InstapayReceiptService.get(req.params.storeId, receiptId, {
        kind: 'subscription',
      });
      res.json({ success: true, data: { receipt: toReceiptView(row) } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /receipts/:receiptId/submit — the merchant's checked fields. Creates the
 * claim Ebda reviews. NEVER activates anything; a duplicate transfer reference
 * anywhere is refused (409 DUPLICATE_REFERENCE).
 */
router.post(
  '/receipts/:receiptId/submit',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const receiptId = z.string().uuid().parse(req.params.receiptId);
      const fields = instapayReceiptFieldsSchema.parse(req.body);
      const out = await submitSubscriptionReceipt({
        storeId: req.params.storeId,
        receiptId,
        fields,
      });
      await auditLog({
        action: 'billing.payment_claimed',
        userId: req.user!.userId,
        storeId: req.params.storeId,
        resourceType: 'manual_payment_claim',
        resourceId: out.claim.id,
        details: {
          amountMinor: out.claim.amountMinor,
          planCode: out.claim.planCode,
          receiptId,
          flags: out.receipt.flags,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(201).json({
        success: true,
        data: { claim: { id: out.claim.id, status: out.claim.status }, receipt: out.receipt },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/change-plan',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { planCode } = z.object({ planCode: z.string().min(1).max(64) }).parse(req.body);
      res.json({
        success: true,
        data: await changePlan({ storeId: req.params.storeId, planCode }),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/cancel', ...writeGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await cancelSubscription({ storeId: req.params.storeId }) });
  } catch (err) {
    next(err);
  }
});

router.post('/resume', ...writeGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resumeSubscription({ storeId: req.params.storeId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /checkout/stub-confirm — LOCAL DEV ONLY (stub provider, never in
 * production): plays the gateway's signed webhook for a pending checkout so the
 * whole flow can be exercised without Kashier. Goes through the same
 * verify + dedupe + settle path as a real delivery.
 */
router.post(
  '/checkout/stub-confirm',
  ...writeGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.NODE_ENV === 'production' || getBillingProvider().name !== 'stub') {
        throw new AppError(404, 'NOT_FOUND', 'Not found');
      }
      const { merchantOrderId, outcome } = z
        .object({ merchantOrderId: z.string().uuid(), outcome: z.enum(['success', 'failure']) })
        .parse(req.body);
      const row = await withStore(req.params.storeId, tx =>
        tx.billingEvent.findFirst({
          where: { id: merchantOrderId, storeId: req.params.storeId, status: 'pending' },
        })
      );
      if (!row) throw new AppError(404, 'NOT_FOUND', 'No pending checkout');
      const ok = outcome === 'success';
      const setup = row.type === 'card_setup';
      const { rawBody, headers } = StubBillingProvider.signedWebhook(
        {
          id: `stub_evt_${row.id}_${ok ? 'paid' : 'declined'}`,
          type: setup
            ? ok
              ? 'card.saved'
              : 'card.failed'
            : ok
              ? 'charge.succeeded'
              : 'charge.failed',
          merchantOrderId: row.id,
          chargeId: `stub_ch_${row.id.slice(0, 12)}`,
          amountMinor: row.amountMinor,
          currency: 'EGP',
          token: ok ? `tok_stub_${row.storeId.slice(0, 8)}` : undefined,
          last4: ok && setup ? '4242' : undefined,
          brand: ok && setup ? 'visa' : undefined,
          failureReason: ok ? undefined : 'stub: card declined',
        },
        STUB_WEBHOOK_SECRET
      );
      res.json({ success: true, data: await handleBillingWebhook('stub', rawBody, headers) });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
