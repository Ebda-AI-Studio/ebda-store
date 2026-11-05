/**
 * Plan administration + assignment (SP5 task 1). Reads for enforcement live in
 * `plan-entitlements.ts`; the guard lives in `plan-limit.service.ts`.
 */

import { expireInvitesBeyondSeats } from './staff-invite.service';
import { prisma, withStore } from '@ebda/database';
import {
  planLimitsSchema,
  type AssignSubscriptionInput,
  type SubscriptionStatus,
  type UpdatePlanInput,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';
import { bustStoreCaches } from './store.service';
import { parseLimits } from './plan-entitlements';
import { isGrantedPlan } from './billing/period';
import { reconcileStoreAccess } from './billing/account.service';
import logger from '../lib/logger';
import { planSubscriberCounts, storeIdsOnPlan } from '../lib/definer';
import { storeDb, storeUpdate } from '../lib/repo-factory';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlanDto {
  code: string;
  nameEn: string;
  nameAr: string;
  sort: number;
  isPublic: boolean;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  featureTier: string;
  limits: ReturnType<typeof parseLimits>;
  subscriberCount?: number;
}

function toDto(
  p: {
    code: string;
    nameEn: string;
    nameAr: string;
    sort: number;
    isPublic: boolean;
    priceMonthlyMinor: number | null;
    priceYearlyMinor: number | null;
    featureTier: string;
    limits: unknown;
  },
  subscriberCount?: number
): PlanDto {
  return {
    code: p.code,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    sort: p.sort,
    isPublic: p.isPublic,
    priceMonthlyMinor: p.priceMonthlyMinor,
    priceYearlyMinor: p.priceYearlyMinor,
    featureTier: p.featureTier,
    limits: parseLimits(p.limits, p.code),
    ...(subscriberCount !== undefined && { subscriberCount }),
  };
}

export const planService = {
  /** Every plan, cheapest first, with how many stores sit on each. */
  async listPlans(opts: { publicOnly?: boolean } = {}): Promise<PlanDto[]> {
    // `plans` is the global catalog (no tenant). The per-plan subscriber counts
    // span every store, so they come from a super_admin-only definer; the public
    // pricing/billing lists do not carry them.
    const plans = await prisma.plan.findMany({
      where: opts.publicOnly ? { isPublic: true } : undefined,
      orderBy: [{ sort: 'asc' }, { code: 'asc' }],
    });
    if (opts.publicOnly) return plans.map(p => toDto(p));
    const byCode = await planSubscriberCounts();
    return plans.map(p => toDto(p, byCode.get(p.code) ?? 0));
  },

  async getPlan(code: string): Promise<PlanDto> {
    const plan = await prisma.plan.findUnique({ where: { code } });
    if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'Plan not found');
    return toDto(plan);
  },

  /**
   * Replace a plan's editable fields. `limits` is re-validated here (the route
   * validates too) so a script or future caller cannot persist a blob the
   * engine would reject on read. Caches of every store on this plan are
   * dropped: the automation flags feed the feature map.
   */
  async updatePlan(code: string, input: UpdatePlanInput): Promise<PlanDto> {
    const limits = planLimitsSchema.parse(input.limits);
    const existing = await prisma.plan.findUnique({ where: { code } });
    if (!existing) throw new AppError(404, 'PLAN_NOT_FOUND', 'Plan not found');
    const updated = await prisma.plan.update({
      where: { code },
      data: {
        nameEn: input.nameEn,
        nameAr: input.nameAr,
        sort: input.sort,
        isPublic: input.isPublic,
        priceMonthlyMinor: input.priceMonthlyMinor,
        priceYearlyMinor: input.priceYearlyMinor,
        limits,
      },
    });
    const storeIds = await storeIdsOnPlan(code);
    const newSeats = limits.maxStaff;
    if (typeof newSeats === 'number') {
      // Sequential on purpose: one transaction at a time, so a popular plan cannot exhaust the connection pool.
      for (const storeId of storeIds) {
        await expireInvitesBeyondSeats(storeId).catch(err =>
          logger.warn({ err, storeId }, '[plan] could not expire over-limit staff invites')
        );
      }
    }
    await Promise.all(
      storeIds.map(storeId =>
        featureService
          .invalidateCache(storeId)
          .catch(err => logger.warn({ err, storeId }, '[plan] feature cache bust failed'))
      )
    );
    return toDto(updated);
  },

  /**
   * Put a store on a plan. Writes the subscription AND keeps the legacy
   * `stores.plan` enum on the plan's `featureTier` so FeatureService's
   * PLAN_BASELINE follows. Task 3 (billing) calls this on upgrade/downgrade;
   * super-admin calls it from the store's Billing page; the comp script too.
   */
  async assignPlan(
    storeId: string,
    input: AssignSubscriptionInput
  ): Promise<{ planCode: string; status: SubscriptionStatus }> {
    const plan = await prisma.plan.findUnique({ where: { code: input.planCode } });
    if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'Plan not found');
    // `comped` and `founding_free` are the admin-granted plans; always status comped.
    const status: SubscriptionStatus = isGrantedPlan(plan.code)
      ? 'comped'
      : (input.status ?? 'active');
    if (status === 'comped' && !isGrantedPlan(plan.code)) {
      throw new AppError(
        400,
        'INVALID_STATUS',
        'Only an admin-granted plan can have status comped'
      );
    }

    if (!UUID_RE.test(storeId)) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    // The subscription is written in the store's own scope (strict RLS).
    const store = await withStore(storeId, async tx => {
      const s = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { id: true, slug: true, domain: true },
      });
      if (!s) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
      await tx.storeSubscription.upsert({
        where: { storeId },
        create: { storeId, planCode: plan.code, status },
        update: {
          planCode: plan.code,
          status,
          ordersOverLimitMonth: null,
          ordersOverLimitNotifiedAt: null,
        },
      });
      await storeUpdate(tx, { where: { id: storeId }, data: { plan: plan.featureTier } });
      return s;
    });

    // Feature cache first, then the public caches (issue 2172's ordering).
    await featureService.invalidateCache(storeId);
    await bustStoreCaches(storeId, store.slug, store.domain);
    logger.info({ storeId, planCode: plan.code, status }, '[plan] store plan assigned');
    // A plan change can grow or shrink the owner's store allowance (Business ->
    // Growth suspends the extra stores; back to Business restores them).
    await reconcileStoreAccess(storeId);
    // Pending staff invitations that no longer fit the new plan's seats expire (Ruling ID-13).
    await expireInvitesBeyondSeats(storeId).catch(err =>
      logger.warn({ err, storeId }, '[plan] could not expire over-limit staff invites')
    );
    return { planCode: plan.code, status };
  },
};
