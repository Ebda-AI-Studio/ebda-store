/**
 * Plan-limit enforcement (SP5 task 1) — ONE guard, used at every gated write.
 *
 *   await assertWithinLimit(storeId, 'maxProducts', { delta: rows.length });
 *
 * Throws `AppError(402, 'PLAN_LIMIT_REACHED')` carrying a bilingual message and
 * `details = { limitKey, limit, used, delta, planCode, messageKey, messageEn,
 * messageAr }`. Numeric limits: allowed when `used + delta <= limit`; `null` =
 * unlimited. Boolean limits (`customDomain`, automation) are capabilities:
 * allowed only when true.
 *
 * Gated writes (grep `assertWithinLimit`):
 *   maxProducts  ProductService.create; BulkService.importProducts (WHOLE batch
 *                counted before any row is written)
 *   maxStaff     POST /stores/:storeId/staff
 *   customDomain PUT /stores/:id/domain; StoreService.update/create with `domain`
 *   automation   not a throwing write: the flags are layered into the feature
 *                map by FeatureService (abandoned_cart / whatsapp), so
 *                `requireFeature(...)` / `isFeatureEnabled(...)` already honour them
 *   maxStores    StoreService.create (POST /stores) and OnboardingService.createStore,
 *                via `assertOwnerMayCreateStore`: the owner's best plan across their
 *                live stores must have room for one more (1 / 1 / 3)
 *   brandingRemoval / merchant MCP  not throwing writes: layered by FeatureService into
 *                `remove_branding` (storefront footer) and `merchant_mcp` (key
 *                issuance + the MCP runtime both `requireFeature`/feature-check it).
 *                MCP is Growth + Business (`planIncludesMerchantMcp`), not `apiAccess`.
 *   analyticsTier  `requireAnalyticsTier` on the insights routes (see below)
 *   maxOrdersPerMonth  blocks after a seven-day grace; see `assertOrderAllowed`.
 *   maxStorageMb  declared + shown, not enforced: R2 usage per store is not
 *                 tracked yet (follow-up).
 */

import { upgradePlanFor } from '@ebda/shared';
import { sortOwnerStores } from './billing/billing-parent';
import { prisma, withStore, withUser, type Prisma } from '@ebda/database';
import {
  PLAN_LIMIT_ERROR_CODE,
  isNumericLimitKey,
  planLimitMessage,
  planLimitMessageKey,
  regionMonthStart,
  regionYearMonth,
  type BooleanLimitKey,
  type GatedLimitKey,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { storeRepo } from '../lib/repo-factory';
import { getEntitlements, parseLimits, type Entitlements } from './plan-entitlements';
import { socketService } from './socket.service';
import { EmailService } from './email.service';
import { config } from '../config';
import { listOwnerStoresD1 } from '../lib/store-create-do';
import logger from '../lib/logger';

type Tx = Prisma.TransactionClient;

/** Current usage for a limit, or null when the platform does not track it yet. */
export async function countUsage(
  storeId: string,
  limitKey: GatedLimitKey,
  tx?: Tx
): Promise<number | null> {
  // The products and orders of a store on its Durable Object live there: the Postgres copy is sealed and stale, so counting it
  // would let a DO store sit under its cap for ever (Ruling CF-CAP-1). Staff, domain and billing rows are platform rows.
  if (limitKey === 'maxProducts' || limitKey === 'maxOrdersPerMonth') {
    const repo = await storeRepo(storeId);
    if (repo.backend === 'do') {
      if (limitKey === 'maxProducts')
        return repo.db.product.count({ where: { storeId, deletedAt: null } });
      const since = regionMonthStart(regionYearMonth(new Date()));
      return repo.db.order.count({
        where: { storeId, createdAt: { gte: since }, status: { not: 'cancelled' } },
      });
    }
  }
  const run = async (db: Tx): Promise<number | null> => {
    switch (limitKey) {
      case 'maxProducts':
        return db.product.count({ where: { storeId, deletedAt: null } });
      case 'maxStaff':
        return db.storeStaff.count({ where: { storeId } });
      case 'maxOrdersPerMonth': {
        const since = regionMonthStart(regionYearMonth(new Date()));
        return db.order.count({
          where: { storeId, createdAt: { gte: since }, status: { not: 'cancelled' } },
        });
      }
      case 'customDomain': {
        const s = await db.store.findUnique({ where: { id: storeId }, select: { domain: true } });
        return s?.domain ? 1 : 0;
      }
      case 'maxStorageMb':
        return null; // not tracked yet
      default:
        return null; // automation flags are capabilities, not counts
    }
  };
  return tx ? run(tx) : withStore(storeId, run);
}

/**
 * Gate a capability on a plan that is not (yet) attached to a store — a store
 * being created. Same error as `assertWithinLimit`.
 */
export async function assertPlanAllows(planCode: string, limitKey: BooleanLimitKey): Promise<void> {
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  const limits = plan ? parseLimits(plan.limits, planCode) : undefined;
  if (limits?.[limitKey] === true) return;
  throw limitError({ planCode } as Entitlements, limitKey, false, null, 1);
}

function limitError(
  e: Entitlements,
  limitKey: GatedLimitKey,
  limit: number | boolean,
  used: number | null,
  delta: number
): AppError {
  const messageEn = planLimitMessage(limitKey, limit, 'en');
  const messageAr = planLimitMessage(limitKey, limit, 'ar');
  return new AppError(402, PLAN_LIMIT_ERROR_CODE, messageEn, {
    limitKey,
    limit,
    used,
    delta,
    planCode: e.planCode,
    // Upsell target (Ruling EBDA-FUNNEL-14): the cheapest public plan that fits.
    upgradeTo: upgradePlanFor(limitKey, typeof limit === 'number' ? (used ?? 0) + delta : true),
    messageKey: planLimitMessageKey(limitKey),
    messageEn,
    messageAr,
  });
}

/**
 * Store count is per OWNER, not per store (each store has its own subscription,
 * so the owner's best plan decides). First store always allowed. Any live store
 * whose plan is unlimited (`maxStores: null`) allows more. A canceled
 * subscription resolves to the hidden free plan (1 store), so a lapsed Business
 * owner cannot keep adding stores.
 */
export async function assertOwnerMayCreateStore(ownerId: string): Promise<void> {
  // The OLDEST live store is the billing parent: its plan sets the allowance
  // (Ruling EBDA-FUNNEL-13; same rule as account.service ownerStoreAllowance).
  // An additional store's own subscription never grants more stores, so a
  // lapsed parent cannot be worked around through a child.
  // N-18: where the platform D1 is bound (every deployed Worker) the owner's stores are read from the D1 directory, which holds
  // every store (Postgres stores are mirrored there, a store created on its DO exists only there); Postgres only where D1 is not
  // bound (Node, tests, local dev).
  const stores = sortOwnerStores(
    (await listOwnerStoresD1(ownerId)) ??
      (await withUser(ownerId, tx =>
        tx.store.findMany({
          where: { ownerId, deletedAt: null },
          select: { id: true, createdAt: true },
        })
      ))
  );
  if (stores.length === 0) return;
  const e = await getEntitlements(stores[0].id);
  const max = e?.limits.maxStores;
  if (max === null) return;
  const allowance = typeof max === 'number' && max >= 1 ? max : 1;
  if (stores.length + 1 > allowance) {
    throw limitError(
      (e ?? { planCode: 'unknown' }) as Entitlements,
      'maxStores',
      allowance,
      stores.length,
      1
    );
  }
}

export const ANALYTICS_TIER_RANK = { basic: 0, standard: 1, advanced: 2 } as const;

/** Throws 402 unless the store's plan analytics tier is at least `min`. */
export async function assertAnalyticsTier(
  storeId: string,
  min: keyof typeof ANALYTICS_TIER_RANK
): Promise<void> {
  const e = await getEntitlements(storeId);
  if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  if (ANALYTICS_TIER_RANK[e.limits.analyticsTier] >= ANALYTICS_TIER_RANK[min]) return;
  const messageEn = `${min === 'advanced' ? 'Advanced' : 'Standard'} analytics are not included in your plan. Upgrade to unlock them.`;
  const messageAr = `${min === 'advanced' ? 'التحليلات المتقدمة' : 'التحليلات القياسية'} مش متاحة في باقتك. اعمل ترقية لباقتك عشان تفتحها.`;
  throw new AppError(402, PLAN_LIMIT_ERROR_CODE, messageEn, {
    limitKey: 'analyticsTier',
    limit: e.limits.analyticsTier,
    required: min,
    planCode: e.planCode,
    upgradeTo: upgradePlanFor('analyticsTier', min),
    messageEn,
    messageAr,
  });
}

export async function assertWithinLimit(
  storeId: string,
  limitKey: GatedLimitKey,
  opts: { delta?: number; tx?: Tx } = {}
): Promise<void> {
  const delta = opts.delta ?? 1;
  // With a transaction the check is ATOMIC with the caller's insert: the store row is locked FOR NO KEY UPDATE first (it serialises seat takers against each other but, unlike FOR UPDATE, does not block the FK inserts - orders, carts, products - that take FOR KEY SHARE on it), so concurrent
  // seat takers queue behind each other and each counts the previous one's row (no N-racers-one-seat overshoot).
  if (opts.tx)
    await opts.tx.$queryRaw`SELECT id FROM public.stores WHERE id = ${storeId} FOR NO KEY UPDATE`;
  const e = await getEntitlements(storeId, opts.tx);
  if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

  const limit = e.limits[limitKey];
  if (!isNumericLimitKey(limitKey)) {
    if (limit === true) return;
    throw limitError(e, limitKey, false, null, delta);
  }

  if (limit === null) return; // unlimited (comped, or a plan that sets no ceiling)
  if (typeof limit !== 'number') return;
  const used = (await countUsage(storeId, limitKey, opts.tx)) ?? 0;
  if (used + delta > limit) throw limitError(e, limitKey, limit, used, delta);
}

/**
 * Does the subscription state accept shopper orders AT THIS MOMENT? Evaluated at
 * order time (audit #3): the daily billing job runs at 04:00 UTC, so reading only the
 * row's status refused every order from the trial's last minute until the job, up to
 * ~24 h, even for a store whose card is about to be charged or whose InstaPay grace
 * (INSTAPAY_GRACE_DAYS) has not started. A trial that ended is treated as what the job
 * WILL make of it: a saved card or InstaPay = still open (charge pending / grace, like
 * `past_due`), no payment method = closed (the job moves it to canceled).
 */
export function ordersOpenFor(
  e: Pick<Entitlements, 'status' | 'trialEndsAt' | 'billingMethod' | 'hasSavedCard'>,
  now: Date
): boolean {
  if (e.status === 'canceled') return false;
  if (e.status !== 'trialing') return true;
  if (e.trialEndsAt && e.trialEndsAt.getTime() > now.getTime()) return true;
  return e.billingMethod === 'instapay' || e.hasSavedCard;
}

/**
 * Gate orders before inventory, payment, or notification side effects.
 *
 * A demo store (`stores.is_demo`, the looks showroom) never takes an order: refused first, before
 * the entitlement read, on EVERY order-creating path (this gate is the shared one:
 * `OrderService.create`, `createAdminOrder`, the WhatsApp payment link). The read goes through
 * `withStore`, so it runs under the caller's tenant guard + RLS like any other store read.
 */
export async function assertOrderAllowed(storeId: string): Promise<void> {
  const row = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { isDemo: true } })
  );
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  if (row.isDemo) {
    throw new AppError(403, 'DEMO_STORE', 'This is a demo store; orders are disabled', {
      messageEn: 'This is a demo store: ordering is disabled',
      messageAr: 'ده متجر تجريبي — الطلبات مقفولة',
    });
  }
  const e = await getEntitlements(storeId);
  if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  if (!ordersOpenFor(e, new Date())) {
    throw new AppError(402, 'SUBSCRIPTION_REQUIRED', 'Choose a paid plan to accept new orders', {
      messageEn: 'Choose a paid plan to accept new orders',
      messageAr: 'اختر باقة مدفوعة لاستقبال طلبات جديدة',
      upgradeTo: null,
    });
  }
  const limit = e.limits.maxOrdersPerMonth;
  if (limit === null) return;
  const used = (await countUsage(storeId, 'maxOrdersPerMonth')) ?? 0;
  if (used <= limit) return;
  const sub = await withStore(storeId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId } })
  );
  const monthKey = new Date(`${regionYearMonth(new Date())}-01T00:00:00.000Z`);
  if (
    sub?.ordersOverLimitMonth?.getTime() === monthKey.getTime() &&
    sub.ordersOverLimitNotifiedAt &&
    Date.now() >= sub.ordersOverLimitNotifiedAt.getTime() + 7 * 24 * 60 * 60 * 1000
  ) {
    throw limitError(e, 'maxOrdersPerMonth', limit, used, 1);
  }
  // Recover a missed post-commit notification; its atomic claim starts grace once.
  if (sub?.ordersOverLimitMonth?.getTime() !== monthKey.getTime()) await noteOrderCreated(storeId);
}

/**
 * Ruling B1-13: the showroom (`stores.is_demo`) collects no visitor PII. Refuses customer register
 * (with a storeId), newsletter subscribe, the contact form, affiliate applications and push
 * subscriptions with the same 403 `DEMO_STORE` shape as `assertOrderAllowed`. An unknown store id
 * is not this guard's business: the caller keeps its own not-found behaviour.
 */
export async function assertNotDemoStore(storeId: string): Promise<void> {
  const row = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { isDemo: true } })
  );
  if (row?.isDemo) {
    throw new AppError(403, 'DEMO_STORE', 'This is a demo store; this action is disabled', {
      messageEn: 'This is a demo store: this is turned off here',
      messageAr: 'ده متجر تجريبي — الخاصية دي مقفولة هنا',
    });
  }
}

/** Records first over-limit time and notifies the merchant once per month. */
export async function noteOrderCreated(storeId: string): Promise<{ over: boolean }> {
  try {
    const e = await getEntitlements(storeId);
    const limit = e?.limits.maxOrdersPerMonth ?? null;
    if (!e || limit === null) return { over: false };
    const used = (await countUsage(storeId, 'maxOrdersPerMonth')) ?? 0;
    if (used <= limit) return { over: false };

    const ym = regionYearMonth(new Date());
    const monthKey = new Date(`${ym}-01T00:00:00.000Z`);
    const claimed = await withStore(storeId, async tx => {
      // Atomic claim: exactly one order per month wins the right to notify.
      const sub = await tx.storeSubscription.upsert({
        where: { storeId },
        create: { storeId, planCode: e.subscribedPlanCode, status: 'active' },
        update: {},
      });
      if (sub.ordersOverLimitMonth?.getTime() === monthKey.getTime()) return false;
      const r = await tx.storeSubscription.updateMany({
        where: {
          storeId,
          OR: [{ ordersOverLimitMonth: null }, { ordersOverLimitMonth: { not: monthKey } }],
        },
        data: { ordersOverLimitMonth: monthKey, ordersOverLimitNotifiedAt: new Date() },
      });
      return r.count === 1;
    });
    if (claimed) await notifyMerchantOverOrderLimit(storeId, e, used, limit);
    return { over: true };
  } catch (err) {
    logger.error({ err, storeId }, '[plan-limit] noteOrderCreated failed (order is unaffected)');
    return { over: false };
  }
}

async function notifyMerchantOverOrderLimit(
  storeId: string,
  e: Entitlements,
  used: number,
  limit: number
): Promise<void> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true, owner: { select: { email: true } } },
    })
  );
  if (!store) return;
  const lang: 'en' | 'ar' =
    (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';
  const url = `/stores/${storeId}/billing`;
  const messageEn = planLimitMessage('maxOrdersPerMonth', limit, 'en');
  const messageAr = planLimitMessage('maxOrdersPerMonth', limit, 'ar');
  try {
    socketService.notifyStore(storeId, {
      type: 'plan_limit',
      title: lang === 'ar' ? 'تجاوزت حد الطلبات الشهري' : 'Monthly order limit passed',
      message: lang === 'ar' ? messageAr : messageEn,
      data: { storeId, limitKey: 'maxOrdersPerMonth', limit, used, url },
      createdAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err, storeId }, '[plan-limit] in-app notification failed');
  }
  if (store.owner?.email) {
    await EmailService.sendPlanLimitReached(
      storeId,
      {
        to: store.owner.email,
        storeName: store.name,
        planName: lang === 'ar' ? e.planNameAr : e.planNameEn,
        limit,
        used,
        billingUrl: `${config.adminUrl ?? ''}${url}`,
      },
      lang
    ).catch(err => logger.warn({ err, storeId }, '[plan-limit] over-limit email failed'));
  }
}

/** Usage vs limits for the merchant Billing page. */
export async function getUsageSummary(storeId: string) {
  const e = await getEntitlements(storeId);
  if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  const [products, staff, orders, domain] = await Promise.all([
    countUsage(storeId, 'maxProducts'),
    countUsage(storeId, 'maxStaff'),
    countUsage(storeId, 'maxOrdersPerMonth'),
    countUsage(storeId, 'customDomain'),
  ]);
  return {
    entitlements: e,
    usage: {
      maxProducts: products,
      maxStaff: staff,
      maxOrdersPerMonth: orders,
      maxStorageMb: null as number | null,
      customDomain: domain,
    },
  };
}
