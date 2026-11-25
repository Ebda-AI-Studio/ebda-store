/**
 * Plan entitlements — resolve what a store is allowed to do (SP5 task 1).
 *
 * Read-only and dependency-light on purpose: `FeatureService` imports this to
 * layer the plan's automation flags into the feature map, so it must NOT import
 * `feature.service` (or anything that does). Writes and the enforcement guard
 * live in `plan.service.ts` / `plan-limit.service.ts`.
 *
 * Resolution order:
 *   1. `store_subscriptions` row -> `plans` row. A `canceled` subscription falls
 *      back to the free plan's limits (the store keeps its data, loses the paid
 *      ceiling), and so does a LAPSED InstaPay row (`past_due` whose grace ended,
 *      `isLapsedManualSubscription`, #836). `trialing`/`active`/`past_due` (in its
 *      grace) /`comped` use the plan's own limits.
 *   2. No subscription row (a store created before the migration, or by a path
 *      that has not been taught to create one) -> Ebda Store's legacy `Store.plan` enum
 *      mapped onto a plan code. The migration backfills every existing store, so
 *      this is the safety net, not the normal path.
 *   3. A plan row that is missing or whose `limits` JSON fails the zod schema
 *      falls back to the seed numbers for that code (logged at error level) —
 *      an unreadable limits blob must never make a store unlimited by accident
 *      (unknown code -> the FREE seed) nor lock it out.
 *
 * Reads go through `withStore(storeId, ...)`: `store_subscriptions` is under
 * strict RLS, so the lookup runs in the store's own scope (it joins the request
 * transaction when the caller already has one) — the same posture as
 * FeatureService. The `plans` catalog has no tenant and is read as is.
 */

import { withStore, type Prisma } from '@ebda/database';
import { platformDb } from '../lib/platform-db';
import {
  DEFAULT_PLAN_SEEDS,
  planIncludesMerchantMcp,
  FALLBACK_PLAN_CODE,
  STORE_PLAN_TO_PLAN_CODE,
  planLimitsSchema,
  type PlanLimits,
  type StorePlan,
  type SubscriptionStatus,
} from '@ebda/shared';
import logger from '../lib/logger';
import { readStorePlan } from '../lib/store-plan';

type Tx = Prisma.TransactionClient;

export interface Entitlements {
  storeId: string;
  /** The plan whose limits apply (after the canceled -> free fallback). */
  planCode: string;
  /** The plan the subscription row names (differs from planCode only when canceled). */
  subscribedPlanCode: string;
  status: SubscriptionStatus | 'none';
  limits: PlanLimits;
  /**
   * The feature-baseline tier of the EFFECTIVE plan (`planCode`): what FeatureService's PLAN_BASELINE layer reads.
   * A canceled subscription resolves to the free plan's tier here, whatever `stores.plan` still says (#835).
   */
  featureTier: StorePlan;
  planNameEn: string;
  planNameAr: string;
  /** True when no subscription row exists and the legacy enum decided the plan. */
  derivedFromLegacyPlan: boolean;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  /** First time the subscription went past_due (null unless status is past_due). */
  pastDueSince: Date | null;
  cancelAtPeriodEnd: boolean;
  ordersOverLimitMonth: Date | null;
  /** card | instapay | null (not chosen). */
  billingMethod: string | null;
  /** A card the trial-end/renewal job can charge is on file. */
  hasSavedCard: boolean;
}

/**
 * An InstaPay subscription whose grace is over: `past_due` with the retry (= suspension date) already cleared. The
 * billing cycle downgrades such a row to free / `canceled` (#836); until it runs (or for a row an earlier build left
 * behind) it is entitled to the free plan, never to the plan it stopped paying for. A card row is never in this state
 * (its dunning keeps a `nextRetryAt` until the downgrade).
 */
function isLapsedManualSubscription(
  sub:
    | { status: string; billingMethod?: string | null; nextRetryAt?: Date | null }
    | null
    | undefined
): boolean {
  return (
    !!sub &&
    sub.status === 'past_due' &&
    sub.billingMethod === 'instapay' &&
    sub.nextRetryAt == null
  );
}

/**
 * The plan a subscription is ENTITLED to: the free fallback for a `canceled` row or a lapsed manual one, else what it subscribed to
 * (or the plan derived from `stores.plan` when there is no row). ONE function for `getEntitlements` and the row-based batched path
 * (`automationFlagsFromRows`), so a lapsed InstaPay store cannot keep paid flags in a batched sweep while the per-store read
 * already downgrades it (security review of #723).
 */
function effectivePlanCode(
  legacyPlan: keyof typeof STORE_PLAN_TO_PLAN_CODE,
  sub:
    | {
        planCode: string;
        status: string;
        billingMethod?: string | null;
        nextRetryAt?: Date | null;
      }
    | null
    | undefined
): { subscribedPlanCode: string; effectiveCode: string } {
  const subscribedPlanCode = sub?.planCode ?? STORE_PLAN_TO_PLAN_CODE[legacyPlan];
  const effectiveCode =
    sub?.status === 'canceled' || isLapsedManualSubscription(sub)
      ? FALLBACK_PLAN_CODE
      : subscribedPlanCode;
  return { subscribedPlanCode, effectiveCode };
}

function seedFor(code: string) {
  return (
    DEFAULT_PLAN_SEEDS.find(p => p.code === code) ??
    DEFAULT_PLAN_SEEDS.find(p => p.code === FALLBACK_PLAN_CODE)!
  );
}

/** Parse a stored limits blob; fall back to the seed for `code` when it is corrupt. */
export function parseLimits(raw: unknown, code: string): PlanLimits {
  const parsed = planLimitsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.error(
    { planCode: code, issues: parsed.error.issues },
    '[plan-entitlements] plans.limits failed validation — using seed limits for this plan code'
  );
  return seedFor(code).limits;
}

async function loadPlan(tx: Tx, code: string) {
  return tx.plan.findUnique({ where: { code } });
}

export async function getEntitlements(
  storeId: string,
  tx?: Tx,
  /** The caller already read `stores.plan` (FeatureService does) — skips the second read. */
  known?: { legacyPlan: keyof typeof STORE_PLAN_TO_PLAN_CODE }
): Promise<Entitlements | null> {
  // N-18: a store created on D1 + its DO has no Postgres row. Its plan, subscription and plan row are read from the platform D1
  // (where `newSubscriptionRow` wrote them, in the store's own D1 batch); a store WITH a Postgres row is unchanged (Postgres stays authoritative for it
  // until N-10 moves every billing reader and writer together).
  const run = async (db: Tx): Promise<Entitlements | null> => {
    const store =
      known !== undefined ? { plan: known.legacyPlan } : await readStorePlan(db, storeId);
    let fromD1: Awaited<ReturnType<typeof platformDb>>;
    if (!store) {
      fromD1 = await platformDb();
      if (!fromD1) return null;
    }
    const d1Store = fromD1
      ? await fromD1.store.findUnique({
          where: { id: storeId },
          select: { plan: true, deletedAt: true },
        })
      : null;
    if (!store && (!d1Store || d1Store.deletedAt)) return null;
    const plan0 = (store ?? d1Store) as { plan: keyof typeof STORE_PLAN_TO_PLAN_CODE };
    let sub = fromD1
      ? await fromD1.storeSubscription.findUnique({ where: { storeId } })
      : await db.storeSubscription.findUnique({ where: { storeId } });
    // A caller that already read the plan (`known`) never saw the Postgres-row check above: a store with no Postgres row has no
    // Postgres subscription either, so look in D1 (a store WITH a Postgres row and no subscription stays derived from its plan).
    if (!sub && !fromD1 && known !== undefined) {
      const platform = await platformDb();
      if (platform) {
        sub = await platform.storeSubscription.findUnique({ where: { storeId } });
        if (sub) fromD1 = platform;
      }
    }
    const { subscribedPlanCode, effectiveCode } = effectivePlanCode(plan0.plan, sub);
    const status: SubscriptionStatus | 'none' = sub?.status ?? 'none';

    const plan = fromD1
      ? await fromD1.plan.findUnique({ where: { code: effectiveCode } })
      : await loadPlan(db, effectiveCode);
    const seed = seedFor(effectiveCode);
    return {
      storeId,
      planCode: plan?.code ?? seed.code,
      subscribedPlanCode,
      status,
      limits: plan ? parseLimits(plan.limits, effectiveCode) : seed.limits,
      featureTier: (plan?.featureTier ?? seed.featureTier) as StorePlan,
      planNameEn: plan?.nameEn ?? seed.nameEn,
      planNameAr: plan?.nameAr ?? seed.nameAr,
      derivedFromLegacyPlan: !sub,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      trialEndsAt: sub?.trialEndsAt ?? null,
      pastDueSince: sub?.pastDueSince ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      ordersOverLimitMonth: sub?.ordersOverLimitMonth ?? null,
      billingMethod: sub?.billingMethod ?? null,
      hasSavedCard: !!sub?.provider && !!sub?.providerPaymentMethodRef,
    };
  };
  return tx ? run(tx) : withStore(storeId, run);
}

/**
 * `getAutomationFlags` from rows a batched read already holds (one `store_subscriptions` row or none, the `plans` row of the
 * effective code or none) - the same resolution as `getEntitlements`, no query. Used by FeatureService's batched prefetch.
 */
export function automationFlagsFromRows(
  legacyPlan: keyof typeof STORE_PLAN_TO_PLAN_CODE,
  sub:
    | {
        planCode: string;
        status: string;
        billingMethod?: string | null;
        nextRetryAt?: Date | null;
      }
    | null
    | undefined,
  planRows: ReadonlyMap<string, { code: string; limits: unknown; featureTier?: string }>
) {
  const { effectiveCode } = effectivePlanCode(legacyPlan, sub);
  const plan = planRows.get(effectiveCode);
  const seed = seedFor(effectiveCode);
  const limits = plan ? parseLimits(plan.limits, effectiveCode) : seed.limits;
  return {
    effectiveCode,
    flags: {
      abandonedCartAutomation: limits.abandonedCartAutomation,
      whatsappAutomation: limits.whatsappAutomation,
      brandingRemoval: limits.brandingRemoval,
      apiAccess: limits.apiAccess,
      wholesalePricing: limits.wholesalePricing,
      mcpAccess: planIncludesMerchantMcp(plan?.code ?? seed.code, limits),
      // Same as getEntitlements: the baseline tier follows the effective plan, never stores.plan (#835/#850).
      featureTier: (plan?.featureTier ?? seed.featureTier) as StorePlan,
    },
  };
}

/**
 * The plan flags FeatureService layers over PLAN_BASELINE (and under a
 * StoreFeature override): the two automation flags, plus `brandingRemoval`
 * (-> `remove_branding`) and the merchant-MCP entitlement `mcpAccess` (-> `merchant_mcp` + `merchant_mcp_write`; Growth + Business, NOT `apiAccess`). `null` = no plan
 * decision (unknown store).
 */
export async function getAutomationFlags(
  storeId: string,
  tx?: Tx,
  known?: { legacyPlan: keyof typeof STORE_PLAN_TO_PLAN_CODE }
): Promise<
  | (Pick<
      PlanLimits,
      | 'abandonedCartAutomation'
      | 'whatsappAutomation'
      | 'brandingRemoval'
      | 'apiAccess'
      | 'wholesalePricing'
    > & { mcpAccess: boolean; featureTier: StorePlan })
  | null
> {
  const e = await getEntitlements(storeId, tx, known);
  if (!e) return null;
  return {
    abandonedCartAutomation: e.limits.abandonedCartAutomation,
    whatsappAutomation: e.limits.whatsappAutomation,
    brandingRemoval: e.limits.brandingRemoval,
    apiAccess: e.limits.apiAccess,
    wholesalePricing: e.limits.wholesalePricing,
    // Merchant MCP (keys + read + write tools): Growth + Business (Ahmad 2026-10-14),
    // decided on the EFFECTIVE plan (a canceled Growth store falls back to free => off).
    mcpAccess: planIncludesMerchantMcp(e.planCode, e.limits),
    // The tier PLAN_BASELINE is read for: the effective plan's, never the stale `stores.plan` column (#835).
    featureTier: e.featureTier,
  };
}

/**
 * Platform fee (basis points) for SP6's per-order fee. A getter only — nothing
 * computes or charges a fee yet. COD orders use `codPlatformFeeBps` (default 0).
 */
export async function getPlatformFeeBps(
  storeId: string,
  opts: { cod: boolean }
): Promise<number | null> {
  const e = await getEntitlements(storeId);
  if (!e) return null;
  return opts.cod ? e.limits.codPlatformFeeBps : e.limits.platformFeeBps;
}
