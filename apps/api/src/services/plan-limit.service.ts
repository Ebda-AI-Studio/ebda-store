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
 *   maxOrdersPerMonth  blocks after a seven-day grace; see `assertOrderAllowed`.
 *   maxStorageMb  declared + shown, not enforced: R2 usage per store is not
 *                 tracked yet (follow-up).
 */

import { prisma, withStore, type Prisma } from '@force/database';
import {
  PLAN_LIMIT_ERROR_CODE,
  isNumericLimitKey,
  planLimitMessage,
  planLimitMessageKey,
  regionMonthStart,
  regionYearMonth,
  type BooleanLimitKey,
  type GatedLimitKey,
} from '@force/shared';
import { AppError } from '../middleware/error-handler';
import { getEntitlements, parseLimits, type Entitlements } from './plan-entitlements';
import { socketService } from './socket.service';
import { EmailService } from './email.service';
import { config } from '../config';
import logger from '../lib/logger';

type Tx = Prisma.TransactionClient;

/** Current usage for a limit, or null when the platform does not track it yet. */
export async function countUsage(
  storeId: string,
  limitKey: GatedLimitKey,
  tx?: Tx
): Promise<number | null> {
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
    messageKey: planLimitMessageKey(limitKey),
    messageEn,
    messageAr,
  });
}

export async function assertWithinLimit(
  storeId: string,
  limitKey: GatedLimitKey,
  opts: { delta?: number } = {}
): Promise<void> {
  const delta = opts.delta ?? 1;
  const e = await getEntitlements(storeId);
  if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

  const limit = e.limits[limitKey];
  if (!isNumericLimitKey(limitKey)) {
    if (limit === true) return;
    throw limitError(e, limitKey, false, null, delta);
  }

  if (limit === null) return; // unlimited (comped, or a plan that sets no ceiling)
  if (typeof limit !== 'number') return;
  const used = (await countUsage(storeId, limitKey)) ?? 0;
  if (used + delta > limit) throw limitError(e, limitKey, limit, used, delta);
}

/** Gate orders before inventory, payment, or notification side effects. */
export async function assertOrderAllowed(storeId: string): Promise<void> {
  const e = await getEntitlements(storeId);
  if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  if (
    e.status === 'canceled' ||
    (e.status === 'trialing' && (!e.trialEndsAt || e.trialEndsAt.getTime() <= Date.now()))
  ) {
    throw new AppError(402, 'SUBSCRIPTION_REQUIRED', 'Choose a paid plan to accept new orders');
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
