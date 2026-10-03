/**
 * Merchant Billing (SP5 task 1): the store's plan, subscription state and usage
 * against its limits. Read-only for the merchant; super-admin can also assign
 * a plan from this page via `PUT /admin/stores/:id/subscription`.
 *
 * Mounted at /stores/:storeId/billing. Task 3 adds the upgrade/checkout calls.
 */

import { Router, Request, Response, NextFunction } from 'express';
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
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
