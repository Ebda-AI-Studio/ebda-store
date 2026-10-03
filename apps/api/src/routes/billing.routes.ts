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
import { z } from 'zod';
import { STUB_WEBHOOK_SECRET, StubBillingProvider, getBillingProvider } from '../services/billing';
import {
  cancelSubscription,
  changePlan,
  getSubscriptionBillingState,
  handleBillingWebhook,
  listStoreCharges,
  resumeSubscription,
  startCheckout,
} from '../services/billing/subscription-billing.service';
import { AppError } from '../middleware/error-handler';
import { withRlsBypass } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { getUsageSummary } from '../services/plan-limit.service';
import { planService } from '../services/plan.service';

const router = Router({ mergeParams: true });

router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
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
          provider: getBillingProvider().name,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

const guard = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];

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
router.post('/checkout', ...guard, async (req: Request, res: Response, next: NextFunction) => {
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
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hint = getBillingProvider().parseReturn(req.query as Record<string, unknown>);
      let status: string | null = null;
      if (hint.merchantOrderId && /^[0-9a-f-]{36}$/i.test(hint.merchantOrderId)) {
        const row = await withRlsBypass(tx =>
          tx.billingEvent.findFirst({
            where: { id: hint.merchantOrderId!, storeId: req.params.storeId },
            select: { status: true },
          })
        );
        status = row?.status ?? null;
      }
      res.json({ success: true, data: { hint: hint.outcome, status } });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/change-plan', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { planCode } = z.object({ planCode: z.string().min(1).max(64) }).parse(req.body);
    res.json({
      success: true,
      data: await changePlan({ storeId: req.params.storeId, planCode }),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/cancel', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await cancelSubscription({ storeId: req.params.storeId }) });
  } catch (err) {
    next(err);
  }
});

router.post('/resume', ...guard, async (req: Request, res: Response, next: NextFunction) => {
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
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.NODE_ENV === 'production' || getBillingProvider().name !== 'stub') {
        throw new AppError(404, 'NOT_FOUND', 'Not found');
      }
      const { merchantOrderId, outcome } = z
        .object({ merchantOrderId: z.string().uuid(), outcome: z.enum(['success', 'failure']) })
        .parse(req.body);
      const row = await withRlsBypass(tx =>
        tx.billingEvent.findFirst({
          where: { id: merchantOrderId, storeId: req.params.storeId, status: 'pending' },
        })
      );
      if (!row) throw new AppError(404, 'NOT_FOUND', 'No pending checkout');
      const ok = outcome === 'success';
      const { rawBody, headers } = StubBillingProvider.signedWebhook(
        {
          id: `stub_evt_${row.id}_${ok ? 'paid' : 'declined'}`,
          type: ok ? 'charge.succeeded' : 'charge.failed',
          merchantOrderId: row.id,
          chargeId: `stub_ch_${row.id.slice(0, 12)}`,
          amountMinor: row.amountMinor,
          currency: 'EGP',
          token: ok ? `tok_stub_${row.storeId.slice(0, 8)}` : undefined,
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
