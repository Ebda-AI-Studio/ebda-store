/**
 * Insights Routes — Accounting Batch 4
 *
 * All routes are store-scoped and sit behind the standard
 * authenticate → authorize → requireStoreAccess chain.
 *
 * Routes:
 *   GET  /:storeId/insights/dashboard                    — KPI summary + top SKUs + funnel + narration
 *   GET  /:storeId/insights/cohorts                      — full cohort retention matrix + narration
 *   GET  /:storeId/insights/funnel?window=7|30|90        — funnel snapshots + narration
 *   GET  /:storeId/insights/segments                     — RFM segment counts + revenue + actions + narration
 *   GET  /:storeId/insights/products?perPage=50          — top SKUs by 30d units sold (contract: @ebda/shared productVelocityResponseSchema)
 *   GET  /:storeId/insights/customers/:customerId/rfm    — single customer RFM snapshot
 *   POST /:storeId/insights/rollup/run-now               — super_admin: trigger on-demand rollup (202)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { currentStoreId, prisma, runInTenantContext, RfmSegment } from '@ebda/database';
import { storeDb } from '../lib/repo-factory';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireAnalyticsTier } from '../middleware/analytics-tier';
import { requireStoreAccess } from '../middleware/store-access';
import { generateInsightNarration } from '../services/accounting/insights-narration.service';
import { inngest } from '../lib/inngest/client';
import { EFFECTIVE_STOCK_SELECT, effectiveInventory } from '../lib/effective-inventory';
import { storeTakesGuestOrders } from '../lib/guest-checkout';
import { customerKeyOf } from '../lib/customer-key';
import { listFunnelSnapshots } from '../services/accounting/funnel-report.service';
import {
  PRODUCT_VELOCITY_WINDOW_DAYS,
  type ProductVelocityResponse,
  type ProductVelocityRow,
} from '@ebda/shared';

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Recommended actions per RFM segment (bilingual, hardcoded per spec)
// ---------------------------------------------------------------------------

const SEGMENT_ACTIONS: Record<RfmSegment, { en: string; ar: string }> = {
  vip: {
    en: 'Offer exclusive early access and loyalty rewards to maintain high engagement.',
    ar: 'قدّم وصولاً حصرياً مبكراً ومكافآت ولاء للحفاظ على مستوى تفاعل عالٍ.',
  },
  loyal: {
    en: 'Send personalised thank-you messages and upsell complementary products.',
    ar: 'أرسل رسائل شكر مخصصة وعرض منتجات مكملة ترقى بمستوى المشتريات.',
  },
  potential: {
    en: 'Keep them engaged — they have ordered before. Offer personalised promotions to build frequency.',
    ar: 'حافظ على تفاعلهم — لقد اشتروا من قبل. قدّم عروضاً مخصصة لزيادة تكرار الشراء.',
  },
  new_customer: {
    en: 'Welcome with an onboarding discount and highlight best-sellers.',
    ar: 'رحّب بهم بخصم ترحيبي وأبرز المنتجات الأكثر مبيعاً.',
  },
  at_risk: {
    en: 'Re-engage with a win-back offer before they churn completely.',
    ar: 'أعد تفاعلهم بعرض استعادة قبل أن تفقدهم نهائياً.',
  },
  hibernating: {
    en: 'Send a reactivation campaign with a time-limited incentive.',
    ar: 'أطلق حملة إعادة تنشيط مع حافز محدود بوقت.',
  },
  lost: {
    en: 'Run a last-chance campaign; if unresponsive, suppress from active lists.',
    ar: 'شغّل حملة فرصة أخيرة؛ إذا لم يستجيبوا، أوقف إرسال الرسائل إليهم.',
  },
};

/**
 * Repeat-purchase rate (fraction 0..1) over a set of paid orders. Buyers are
 * keyed by `customerKeyOf` — the ONE grouping the Customers page and the RFM
 * rollup also use (user id, else lowercased guest email, else guest phone).
 * Guest orders with no contact at all are skipped.
 * Returns `repeatPurchaseRate: null` when no buyer is identifiable.
 *
 * The in-memory REFERENCE for `repeatPurchaseInDb` below, which the dashboard
 * calls (issue 2260). Kept exported so the unit suite can pin the grouping;
 * change both or neither.
 */
export function computeRepeatPurchase(
  orders: Array<{ customerId: string | null; shippingAddress: unknown }>
): { repeatPurchaseRate: number | null; identifiedBuyers: number } {
  const ordersPerBuyer = new Map<string, number>();
  for (const o of orders) {
    const key = customerKeyOf(o);
    if (!key) continue;
    ordersPerBuyer.set(key, (ordersPerBuyer.get(key) ?? 0) + 1);
  }
  const identifiedBuyers = ordersPerBuyer.size;
  if (identifiedBuyers === 0) return { repeatPurchaseRate: null, identifiedBuyers };
  let repeat = 0;
  for (const n of ordersPerBuyer.values()) if (n >= 2) repeat += 1;
  return { repeatPurchaseRate: repeat / identifiedBuyers, identifiedBuyers };
}

/**
 * `computeRepeatPurchase`, computed in Postgres over paid orders since `since`
 * (issue 2260). The grouping key is `customerKeyOf` byte-for-byte: the
 * customer id, else the shipping email LOWERCASED (not trimmed), else the
 * shipping phone VERBATIM — each only when it is a non-empty JSON string, the
 * same `typeof === 'string'` test `contactOf` applies. An order with none of
 * the three is skipped. Returns two integers, never the rows.
 */
export async function repeatPurchaseInDb(
  storeId: string,
  since: Date
): Promise<{ repeatPurchaseRate: number | null; identifiedBuyers: number }> {
  const rows = await prisma.$queryRaw<Array<{ repeat: number; buyers: number }>>`
    SELECT
      COUNT(*) FILTER (WHERE n >= 2)::int AS repeat,
      COUNT(*)::int AS buyers
    FROM (
      SELECT
        COALESCE(
          NULLIF(o.customer_id, ''),
          NULLIF(CASE WHEN jsonb_typeof(o.shipping_address -> 'email') = 'string'
                      THEN lower(o.shipping_address ->> 'email') END, ''),
          NULLIF(CASE WHEN jsonb_typeof(o.shipping_address -> 'phone') = 'string'
                      THEN o.shipping_address ->> 'phone' END, '')
        ) AS buyer_key,
        COUNT(*) AS n
      FROM orders o
      WHERE o.store_id = ${storeId}
        AND o.payment_status = 'paid'
        AND o.created_at >= ${since}
      GROUP BY 1
    ) per_buyer
    WHERE buyer_key IS NOT NULL
  `;
  const buyers = rows[0]?.buyers ?? 0;
  if (buyers === 0) return { repeatPurchaseRate: null, identifiedBuyers: 0 };
  return { repeatPurchaseRate: (rows[0]?.repeat ?? 0) / buyers, identifiedBuyers: buyers };
}

// ---------------------------------------------------------------------------
// GET /:storeId/insights/dashboard
// ---------------------------------------------------------------------------

router.get(
  '/:storeId/insights/dashboard',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireAnalyticsTier('standard'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const [orderStats, prevOrderStats, topSegmentRaw, yesterdayFunnel, topSkus, narration] =
        await Promise.all([
          // AOV + MRR-equiv (last 30d)
          runInTenantContext(storeId, () =>
            prisma.order.aggregate({
              where: {
                storeId,
                paymentStatus: 'paid',
                createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
              },
              _avg: { total: true },
              _sum: { total: true },
              _count: true,
            })
          ),

          // AOV for the PREVIOUS 30d window (days 30–60 ago) — drives the
          // period-over-period change shown on the dashboard AOV tile.
          runInTenantContext(storeId, () =>
            prisma.order.aggregate({
              where: {
                storeId,
                paymentStatus: 'paid',
                createdAt: {
                  gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
                  lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                },
              },
              _avg: { total: true },
            })
          ),

          // Top segment by count + revenue contribution
          runInTenantContext(storeId, async () =>
            (await storeDb(currentStoreId())).customerRfmSnapshot.groupBy({
              by: ['segment'],
              where: { storeId },
              _count: { id: true },
              _sum: { monetaryFils: true },
              orderBy: { _count: { id: 'desc' } },
              take: 1,
            })
          ),

          // Yesterday funnel snapshot
          runInTenantContext(storeId, async () =>
            (await storeDb(currentStoreId())).funnelSnapshot.findFirst({
              where: { storeId },
              orderBy: { periodDate: 'desc' },
            })
          ),

          // Top 5 SKUs by revenue (last 7d)
          runInTenantContext(storeId, () =>
            prisma.orderItem.groupBy({
              by: ['productId'],
              where: {
                order: {
                  storeId,
                  paymentStatus: 'paid',
                  createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
                },
              },
              _sum: { total: true, quantity: true },
              orderBy: { _sum: { total: 'desc' } },
              take: 5,
            })
          ),

          // AI narration (graceful null on failure)
          generateInsightNarration(storeId, 'segment'),
        ]);

      // Enrich top SKUs with product info
      const productIds = topSkus.map(s => s.productId);
      const products = productIds.length
        ? await runInTenantContext(storeId, async () =>
            (await storeDb(storeId)).product.findMany({
              where: { storeId, id: { in: productIds } },
              select: { id: true, name: true, nameAr: true, sku: true },
            })
          )
        : [];
      const productMap = Object.fromEntries(products.map(p => [p.id, p]));

      // Repeat purchase rate over the last 30d = buyers with ≥2 paid orders /
      // buyers with ≥1. A buyer is the registered customer, or — for a guest
      // checkout — `customerKeyOf` (lowercased email, else phone), the ONE key the
      // Customers page and RFM rollup use. Filtering on
      // `customerId: { not: null }` read 0% on every guest-checkout store (all
      // of demo-store's orders are guest). `null` = unknown (no identifiable
      // buyer in the window), which the page renders as "—", never as 0%.
      //
      // Aggregated IN POSTGRES (issue 2260): loading every paid order of the
      // window with its full shippingAddress JSON into memory on every page
      // load grew linearly with a merchant's success. `repeatBuyersSql` groups
      // by exactly `customerKeyOf`'s key (see its doc) and returns two counts.
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [{ repeatPurchaseRate, identifiedBuyers }, guestCheckout] = await Promise.all([
        runInTenantContext(storeId, () => repeatPurchaseInDb(storeId, since30d)),
        // Same 30d window: does this store take guest orders? Ruling AN-1's
        // definition — ANY order with no customer, paid or not — the same
        // probe /insights/funnel uses. Deriving it from the PAID orders read a
        // false `false` on a store whose guest orders are unpaid COD, while
        // the funnel page read `true` for the same days (issue 2257).
        runInTenantContext(storeId, () => storeTakesGuestOrders(storeId, since30d)),
      ]);

      // Window length used to derive a per-day velocity from the 7d unit sums.
      const TOP_SKU_WINDOW_DAYS = 7;
      const topRfmSegment = topSegmentRaw[0];

      res.json({
        data: {
          // Page contract: aov is an object with this/last-period piastres so the
          // tile can render a period-over-period delta (dashboard/page.tsx).
          aov: {
            thisPeriodFils: orderStats._avg?.total ?? 0,
            lastPeriodFils: prevOrderStats._avg?.total ?? 0,
          },
          mrr30d: orderStats._sum?.total ?? 0,
          orderCount30d: orderStats._count,
          repeatPurchaseRate,
          repeatPurchaseBuyers: identifiedBuyers,
          // Page contract: topSegment is an object (segment/count/revenue) — the
          // page calls `topSegment.segment.replace(...)`, so a bare string here
          // would throw. Null when the store has no RFM snapshot rows.
          topSegment: topRfmSegment
            ? {
                segment: topRfmSegment.segment,
                count: topRfmSegment._count.id,
                revenueContributionFils: Number(topRfmSegment._sum.monetaryFils ?? 0),
              }
            : null,
          topSkus: topSkus.map(s => {
            const unitsSold7d = s._sum?.quantity ?? 0;
            return {
              productId: s.productId,
              name: productMap[s.productId]?.name ?? null,
              nameAr: productMap[s.productId]?.nameAr ?? null,
              sku: productMap[s.productId]?.sku ?? null,
              // Page contract: unitsSold7d + velocity (units/day) replace the
              // old revenue/unitsSold field names (dashboard/page.tsx TopSku).
              unitsSold7d,
              velocity: unitsSold7d / TOP_SKU_WINDOW_DAYS,
            };
          }),
          guestCheckout,
          yesterdayFunnel: yesterdayFunnel
            ? {
                ...yesterdayFunnel,
                // FunnelSnapshot has no rate column — the page read a
                // `conversionRate` that never existed and always showed 0.0%.
                // Derived here as cart→order; null (unknown) when no cart was
                // created that day. Deliberately NOT named `conversionRate`:
                // that name is the /analytics orders-per-product-view rate
                // (ruling AN-5), and one name must mean one metric.
                cartToOrderRate:
                  yesterdayFunnel.cartsCreated > 0
                    ? yesterdayFunnel.ordersCompleted / yesterdayFunnel.cartsCreated
                    : null,
              }
            : null,
          // As-of timestamp for the velocity panel. The top-SKU velocity is
          // computed live from the trailing 7d order window at request time,
          // so "as of" is the moment this response was assembled. Mirrors the
          // date+time the segments / cohorts / funnel panels show.
          velocityAsOf: topSkus.length > 0 ? new Date().toISOString() : null,
          narration: narration ?? undefined,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:storeId/insights/cohorts
// ---------------------------------------------------------------------------

router.get(
  '/:storeId/insights/cohorts',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireAnalyticsTier('advanced'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const [cohorts, narration] = await Promise.all([
        runInTenantContext(storeId, async () =>
          (await storeDb(currentStoreId())).customerCohortSnapshot.findMany({
            where: { storeId },
            orderBy: [{ cohortMonth: 'desc' }, { periodOffset: 'asc' }],
          })
        ),
        generateInsightNarration(storeId, 'cohort'),
      ]);

      res.json({ data: { cohorts, narration: narration ?? undefined } });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:storeId/insights/funnel?window=7|30|90
// ---------------------------------------------------------------------------

const funnelQuerySchema = z.object({
  window: z.coerce
    .number()
    .int()
    .refine(v => [7, 30, 90].includes(v), {
      message: 'window must be 7, 30, or 90',
    })
    .default(7),
});

router.get(
  '/:storeId/insights/funnel',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireAnalyticsTier('advanced'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const parsed = funnelQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const { window: days } = parsed.data;

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [funnelDays, narration, guestCheckout] = await Promise.all([
        // Shared with the merchant MCP `admin_get_funnel` tool.
        runInTenantContext(storeId, () => listFunnelSnapshots(storeId, days)),
        generateInsightNarration(storeId, 'funnel'),
        // checkoutsStarted / ordersAbandoned come from abandoned_carts, which
        // cannot see guest carts — flag it so the page shows "not tracked for
        // guest checkout" instead of a false 0.
        runInTenantContext(storeId, () => storeTakesGuestOrders(storeId, since)),
      ]);

      res.json({
        data: { days: funnelDays, guestCheckout, narration: narration ?? undefined },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:storeId/insights/segments
// ---------------------------------------------------------------------------

router.get(
  '/:storeId/insights/segments',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireAnalyticsTier('advanced'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const [rawSegments, narration] = await Promise.all([
        runInTenantContext(storeId, async () =>
          (await storeDb(currentStoreId())).customerRfmSnapshot.groupBy({
            by: ['segment'],
            where: { storeId },
            _count: { id: true },
            _sum: { monetaryFils: true },
          })
        ),
        generateInsightNarration(storeId, 'segment'),
      ]);

      // Page contract (segments/page.tsx RfmSegmentRow): segment / count /
      // totalMonetaryFils / recommendedAction (English, flat string — kept for
      // existing readers such as the dashboard summary card) plus
      // recommendedActionAr, so the page renders the admin's locale instead
      // of always English (analytics audit §4).
      const segments = rawSegments.map(s => ({
        segment: s.segment,
        count: s._count.id,
        totalMonetaryFils: Number(s._sum.monetaryFils ?? 0),
        recommendedAction: SEGMENT_ACTIONS[s.segment]?.en ?? null,
        recommendedActionAr: SEGMENT_ACTIONS[s.segment]?.ar ?? null,
      }));

      res.json({ data: { segments, narration: narration ?? undefined } });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:storeId/insights/products?perPage=50
// ---------------------------------------------------------------------------

const productsQuerySchema = z.object({
  perPage: z.coerce.number().int().positive().max(200).default(50),
});

router.get(
  '/:storeId/insights/products',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireAnalyticsTier('standard'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const parsed = productsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const { perPage } = parsed.data;

      // Ranked by units sold in the trailing 30 days (paid orders) — the
      // "recent velocity" the page promises. The previous all-time revenue
      // ranking returned none of the fields the page reads (sold 7d/30d,
      // velocity, ASP, stock, cost), so every one rendered blank or 0.
      const DAY_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const since30d = new Date(now - PRODUCT_VELOCITY_WINDOW_DAYS * DAY_MS);
      const since7d = new Date(now - 7 * DAY_MS);

      const top30d = await runInTenantContext(storeId, () =>
        prisma.orderItem.groupBy({
          by: ['productId'],
          where: { order: { storeId, paymentStatus: 'paid', createdAt: { gte: since30d } } },
          _sum: { total: true, quantity: true },
          orderBy: [{ _sum: { quantity: 'desc' } }, { productId: 'asc' }],
          take: perPage,
        })
      );

      const productIds = top30d.map(s => s.productId);
      const [sold7dRows, products] = productIds.length
        ? await runInTenantContext(storeId, async () =>
            Promise.all([
              prisma.orderItem.groupBy({
                by: ['productId'],
                where: {
                  productId: { in: productIds },
                  order: { storeId, paymentStatus: 'paid', createdAt: { gte: since7d } },
                },
                _sum: { quantity: true },
              }),
              (await storeDb(storeId)).product.findMany({
                where: { id: { in: productIds }, storeId },
                select: {
                  id: true,
                  name: true,
                  nameAr: true,
                  sku: true,
                  costPrice: true,
                  // Variant-aware stock — never `product.inventory` directly
                  // (docs/architecture/inventory-model.md).
                  ...EFFECTIVE_STOCK_SELECT,
                },
              }),
            ])
          )
        : [[], []];

      const sold7d = new Map(sold7dRows.map(r => [r.productId, r._sum?.quantity ?? 0]));
      const productMap = new Map(products.map(p => [p.id, p]));

      const ranked: ProductVelocityRow[] = top30d.map((s, index) => {
        const product = productMap.get(s.productId);
        const units30d = s._sum?.quantity ?? 0;
        const revenue30d = Number(s._sum?.total ?? 0);
        return {
          rank: index + 1,
          productId: s.productId,
          name: product?.name ?? null,
          nameAr: product?.nameAr ?? null,
          sku: product?.sku ?? null,
          unitsSold7d: sold7d.get(s.productId) ?? 0,
          unitsSold30d: units30d,
          velocityPerDay: units30d / PRODUCT_VELOCITY_WINDOW_DAYS,
          avgSellingPriceFils: units30d > 0 ? Math.round(revenue30d / units30d) : null,
          // Unknown (null), not 0, when the product is untracked or gone.
          stockOnHand:
            product && product.trackInventory !== false ? effectiveInventory(product) : null,
          costPriceFils: product?.costPrice ?? null,
        };
      });

      const body: ProductVelocityResponse = {
        windowDays: PRODUCT_VELOCITY_WINDOW_DAYS,
        products: ranked,
      };
      res.json({ data: body });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:storeId/insights/customers/rfm-batch
// Returns Array<{ customerId, segment }> for all customers with an RFM snapshot.
// Lightweight — select only the two fields needed for the badge.
// ---------------------------------------------------------------------------

router.get(
  '/:storeId/insights/customers/rfm-batch',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireAnalyticsTier('advanced'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const rows = await runInTenantContext(storeId, async () =>
        (await storeDb(currentStoreId())).customerRfmSnapshot.findMany({
          where: { storeId, isGuest: false },
          select: { customerId: true, segment: true },
        })
      );

      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:storeId/insights/customers/:customerId/rfm
// ---------------------------------------------------------------------------

router.get(
  '/:storeId/insights/customers/:customerId/rfm',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireAnalyticsTier('advanced'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;

      const snapshot = await runInTenantContext(storeId, async () =>
        (await storeDb(currentStoreId())).customerRfmSnapshot.findUnique({
          where: { storeId_customerId: { storeId, customerId } },
        })
      );

      if (!snapshot) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'No RFM snapshot found for this customer.' },
        });
        return;
      }

      res.json({ data: snapshot });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /:storeId/insights/rollup/run-now  (super_admin only)
// ---------------------------------------------------------------------------

router.post(
  '/:storeId/insights/rollup/run-now',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;
      const userId = req.user?.userId;

      await inngest.send({
        name: 'insights/rollup-requested',
        data: { storeId, requestedBy: userId },
      });

      res.status(202).json({ data: { queued: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
