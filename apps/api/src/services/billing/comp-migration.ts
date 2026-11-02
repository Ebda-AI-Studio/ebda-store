/**
 * Amelia comp migration (Ruling EBDA-FUNNEL-15, EBDA-FUNNEL-19).
 *
 * Amelia Aurum was provisioned on the hidden admin-granted `comped` plan. She is a REGULAR
 * client, so her store moves onto Growth, paid by InstaPay. This module is the reviewed
 * mechanism; `scripts/ebda-amelia-comp-migration.mjs` is the operator wrapper. It is a
 * production DATA action, so it is DRY-RUN by default and never auto-applied.
 *
 * What the move does (one transaction, compare-and-set):
 *  - subscription: plan `growth`, status `active`, billing method `instapay`, interval,
 *    a period from `now` to `coveredUntil` (the date Ahmad states she is paid/safe until),
 *    and a payment reference so she can pay. NOTHING is charged and NO ledger row is written:
 *    the money she pays is recorded afterwards through super-admin -> Billing -> "Record
 *    manual payment & activate" (idempotent on the receipt reference). Record it with the
 *    explicit period: end = coveredUntil, otherwise the period starts AFTER coveredUntil
 *    (the row already has a future period end) and she would be credited an extra period.
 *  - legacy `stores.plan` follows the plan's feature tier (professional).
 * After `coveredUntil` she follows the normal InstaPay path (reminders, due day, grace,
 * suspension), so the date is a decision, not a default: it must be passed explicitly.
 *
 * Idempotent: a store already on Growth `active` is a no-op; the write only matches a row
 * still `comped` on a granted plan (CAS), so two concurrent runs apply once. Any other state
 * is REFUSED, never overwritten (a paid store must not be reset by a stale script).
 *
 * Money is integer piastres from the `plans` row; this module moves no money.
 */
import { prisma, withStore } from '@ebda/database';
import { isGrantedPlan, type BillingInterval } from './period';
import {
  isBillableStoreId,
  newPaymentReference,
  ownerStores,
  reconcileStoreAccess,
} from './account.service';
import { featureService } from '../feature.service';
import { bustStoreCaches } from '../store.service';
import { auditLog } from '../../middleware/security';
import logger from '../../lib/logger';
import { storeUpdate } from '../../lib/repo-factory';

export const COMP_MIGRATION_TARGET_PLAN = 'growth';

export interface CompMigrationInput {
  storeId: string;
  /** End of the period she is covered through; must be in the future. */
  coveredUntil: Date;
  interval?: BillingInterval;
  now?: Date;
}

export interface SubSnapshot {
  planCode: string;
  status: string;
}

export type CompMigrationPlan =
  | { action: 'noop'; reason: 'already_migrated' }
  | {
      action: 'refuse';
      reason: 'no_subscription' | 'not_comped' | 'bad_covered_until' | 'child_store';
    }
  | { action: 'migrate'; from: SubSnapshot; to: SubSnapshot & { billingMethod: 'instapay' } };

/** Pure decision: what would happen to this subscription. */
export function planCompMigration(
  sub: SubSnapshot | null,
  coveredUntil: Date,
  now: Date,
  /** Is this the owner's billing parent? A child is included in its parent's plan: not billable. */
  isBillingParent = true
): CompMigrationPlan {
  if (!sub) return { action: 'refuse', reason: 'no_subscription' };
  if (!isBillingParent) return { action: 'refuse', reason: 'child_store' };
  if (sub.planCode === COMP_MIGRATION_TARGET_PLAN && sub.status === 'active') {
    return { action: 'noop', reason: 'already_migrated' };
  }
  if (sub.status !== 'comped' || !isGrantedPlan(sub.planCode)) {
    return { action: 'refuse', reason: 'not_comped' };
  }
  if (Number.isNaN(coveredUntil.getTime()) || coveredUntil.getTime() <= now.getTime()) {
    return { action: 'refuse', reason: 'bad_covered_until' };
  }
  return {
    action: 'migrate',
    from: { planCode: sub.planCode, status: sub.status },
    to: { planCode: COMP_MIGRATION_TARGET_PLAN, status: 'active', billingMethod: 'instapay' },
  };
}

export interface CompMigrationResult {
  plan: CompMigrationPlan;
  applied: boolean;
  /** The Growth list price for the interval, integer piastres (display only; nothing charged). */
  listPriceMinor: number | null;
  /** Live stores the owner has vs what Growth allows (a shrink would suspend the extras). */
  ownerStores: number | null;
  growthMaxStores: number | null;
}

async function ownerStoreInfo(storeId: string, growthLimits: unknown) {
  const owner = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { ownerId: true } })
  );
  const max = (growthLimits as { maxStores?: number | null } | undefined)?.maxStores;
  return {
    ownerStores: owner?.ownerId ? (await ownerStores(owner.ownerId)).length : null,
    growthMaxStores: typeof max === 'number' ? max : null,
  };
}

/** Decide (always) and write (only when `apply`). Safe to call repeatedly. */
export async function runCompMigration(
  input: CompMigrationInput,
  opts: { apply: boolean; actorId?: string }
): Promise<CompMigrationResult> {
  const now = input.now ?? new Date();
  const interval: BillingInterval = input.interval ?? 'monthly';
  const sub = await withStore(input.storeId, tx =>
    tx.storeSubscription.findUnique({
      where: { storeId: input.storeId },
      select: { planCode: true, status: true },
    })
  );
  const plan = planCompMigration(
    sub,
    input.coveredUntil,
    now,
    await isBillableStoreId(input.storeId)
  );
  const growth = await prisma.plan.findUnique({ where: { code: COMP_MIGRATION_TARGET_PLAN } });
  const listPriceMinor = growth
    ? interval === 'yearly'
      ? growth.priceYearlyMinor
      : growth.priceMonthlyMinor
    : null;
  const info = await ownerStoreInfo(input.storeId, growth?.limits);
  if (plan.action !== 'migrate' || !opts.apply) {
    return { plan, applied: false, listPriceMinor, ...info };
  }
  // Fail closed: do not move a store onto a plan that has no price (it would sit unbilled).
  if (!growth || listPriceMinor === null || listPriceMinor <= 0) {
    throw new Error('Growth plan is missing or unpriced; refusing to migrate');
  }

  const writeOnce = () =>
    withStore(input.storeId, async tx => {
      const s = await tx.store.findUnique({
        where: { id: input.storeId },
        select: { id: true, slug: true, domain: true },
      });
      if (!s) throw new Error('store not found');
      // CAS: only a row still comped on a granted plan is written.
      const hit = await tx.storeSubscription.updateMany({
        where: { storeId: input.storeId, status: 'comped', planCode: plan.from.planCode },
        data: {
          planCode: COMP_MIGRATION_TARGET_PLAN,
          status: 'active',
          billingMethod: 'instapay',
          billingInterval: interval,
          currentPeriodStart: now,
          currentPeriodEnd: input.coveredUntil,
          cancelAtPeriodEnd: false,
          // Comped-era leftovers must not survive: a stale pending plan would be quoted and
          // applied instead of Growth (instapayDetails reads `pendingPlanCode ?? planCode`).
          pendingPlanCode: null,
          trialEndsAt: null,
          nextRetryAt: null,
          dunningAttempts: 0,
          paymentReference: newPaymentReference(),
          ordersOverLimitMonth: null,
          ordersOverLimitNotifiedAt: null,
        },
      });
      if (hit.count !== 1) return null; // someone else migrated it first: a no-op, not an error
      await storeUpdate(tx, { where: { id: input.storeId }, data: { plan: growth.featureTier } });
      return s;
    });
  // A payment-reference unique collision (P2002) rolls the whole attempt back, so retrying with a
  // fresh reference is safe and idempotent (the CAS still guards the row).
  let store: Awaited<ReturnType<typeof writeOnce>> = null;
  for (let attempt = 0; ; attempt++) {
    try {
      store = await writeOnce();
      break;
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002' || attempt >= 4) throw err;
    }
  }
  if (!store) {
    return {
      plan: { action: 'noop', reason: 'already_migrated' },
      applied: false,
      listPriceMinor,
      ...info,
    };
  }

  await featureService.invalidateCache(input.storeId);
  await bustStoreCaches(input.storeId, store.slug, store.domain);
  await reconcileStoreAccess(input.storeId);
  await auditLog({
    action: 'billing.comp_migration',
    userId: opts.actorId,
    storeId: input.storeId,
    resourceType: 'store_subscription',
    resourceId: input.storeId,
    details: {
      from: plan.from,
      to: plan.to,
      coveredUntil: input.coveredUntil.toISOString(),
      interval,
      listPriceMinor,
    },
  });
  logger.info({ storeId: input.storeId }, '[billing] comp migrated to growth');
  return { plan, applied: true, listPriceMinor, ...info };
}
