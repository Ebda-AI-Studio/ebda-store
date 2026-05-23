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
 *   GET  /:storeId/insights/products?perPage=50          — top SKU velocity ranking
 *   GET  /:storeId/insights/customers/:customerId/rfm    — single customer RFM snapshot
 *   POST /:storeId/insights/rollup/run-now               — super_admin: trigger on-demand rollup (202)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, runInTenantContext, RfmSegment } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { generateInsightNarration } from '../services/accounting/insights-narration.service';
import { inngest } from '../lib/inngest/client';

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
    en: 'Nurture with targeted promotions to convert into loyal repeat buyers.',
    ar: 'استهدفهم بعروض موجهة لتحويلهم إلى مشترين متكررين دائمين.',
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

// ---------------------------------------------------------------------------
// GET /:storeId/insights/dashboard
// ---------------------------------------------------------------------------

router.get(
  '/:storeId/insights/dashboard',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const [orderStats, , topSegmentRaw, yesterdayFunnel, topSkus, narration] = await Promise.all([
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

        // Segment counts
        runInTenantContext(storeId, () =>
          prisma.customerRfmSnapshot.groupBy({
            by: ['segment'],
            where: { storeId },
            _count: { id: true },
          })
        ),

        // Top segment by count
        runInTenantContext(storeId, () =>
          prisma.customerRfmSnapshot.groupBy({
            by: ['segment'],
            where: { storeId },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: 1,
          })
        ),

        // Yesterday funnel snapshot
        runInTenantContext(storeId, () =>
          prisma.funnelSnapshot.findFirst({
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
        ? await runInTenantContext(storeId, () =>
            prisma.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, name: true, nameAr: true, sku: true },
            })
          )
        : [];
      const productMap = Object.fromEntries(products.map(p => [p.id, p]));

      // Repeat purchase rate = customers with ≥2 paid orders in last 30d / total customers with ≥1 order
      const [repeatBuyers, totalBuyers] = await runInTenantContext(storeId, () =>
        Promise.all([
          prisma.order.groupBy({
            by: ['customerId'],
            where: {
              storeId,
              paymentStatus: 'paid',
              customerId: { not: null },
              createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
            },
            having: { customerId: { _count: { gte: 2 } } },
            _count: { customerId: true },
          }),
          prisma.order.groupBy({
            by: ['customerId'],
            where: {
              storeId,
              paymentStatus: 'paid',
              customerId: { not: null },
              createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
            },
            _count: { customerId: true },
          }),
        ])
      );

      const repeatPurchaseRate =
        totalBuyers.length > 0 ? Math.round((repeatBuyers.length / totalBuyers.length) * 100) : 0;

      res.json({
        data: {
          aov: orderStats._avg?.total ?? 0,
          mrr30d: orderStats._sum?.total ?? 0,
          orderCount30d: orderStats._count,
          repeatPurchaseRate,
          topSegment: topSegmentRaw[0]?.segment ?? null,
          topSkus: topSkus.map(s => ({
            productId: s.productId,
            name: productMap[s.productId]?.name ?? null,
            nameAr: productMap[s.productId]?.nameAr ?? null,
            sku: productMap[s.productId]?.sku ?? null,
            revenue: s._sum?.total ?? 0,
            unitsSold: s._sum?.quantity ?? 0,
          })),
          yesterdayFunnel: yesterdayFunnel ?? null,
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const [cohorts, narration] = await Promise.all([
        runInTenantContext(storeId, () =>
          prisma.customerCohortSnapshot.findMany({
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const parsed = funnelQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', details: parsed.error.flatten() });
        return;
      }
      const { window: days } = parsed.data;

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [funnelDays, narration] = await Promise.all([
        runInTenantContext(storeId, () =>
          prisma.funnelSnapshot.findMany({
            where: { storeId, periodDate: { gte: since } },
            orderBy: { periodDate: 'desc' },
          })
        ),
        generateInsightNarration(storeId, 'funnel'),
      ]);

      res.json({ data: { days: funnelDays, narration: narration ?? undefined } });
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const [rawSegments, narration] = await Promise.all([
        runInTenantContext(storeId, () =>
          prisma.customerRfmSnapshot.groupBy({
            by: ['segment'],
            where: { storeId },
            _count: { id: true },
            _sum: { monetaryFils: true },
          })
        ),
        generateInsightNarration(storeId, 'segment'),
      ]);

      const segments = rawSegments.map(s => ({
        name: s.segment,
        count: s._count.id,
        revenue: Number(s._sum.monetaryFils ?? 0),
        recommendedAction: SEGMENT_ACTIONS[s.segment] ?? { en: '', ar: '' },
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const parsed = productsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: 'validation_failed', details: parsed.error.flatten() });
        return;
      }
      const { perPage } = parsed.data;

      // Aggregate OrderItem revenue + units sold (all time)
      const topItems = await runInTenantContext(storeId, () =>
        prisma.orderItem.groupBy({
          by: ['productId'],
          where: { order: { storeId, paymentStatus: 'paid' } },
          _sum: { total: true, quantity: true },
          orderBy: { _sum: { total: 'desc' } },
          take: perPage,
        })
      );

      const productIds = topItems.map(s => s.productId);
      const products = productIds.length
        ? await runInTenantContext(storeId, () =>
            prisma.product.findMany({
              where: { id: { in: productIds } },
              select: {
                id: true,
                name: true,
                nameAr: true,
                sku: true,
                inventory: true,
                status: true,
              },
            })
          )
        : [];
      const productMap = Object.fromEntries(products.map(p => [p.id, p]));

      const ranked = topItems.map((s, index) => ({
        rank: index + 1,
        productId: s.productId,
        name: productMap[s.productId]?.name ?? null,
        nameAr: productMap[s.productId]?.nameAr ?? null,
        sku: productMap[s.productId]?.sku ?? null,
        inventory: productMap[s.productId]?.inventory ?? null,
        status: productMap[s.productId]?.status ?? null,
        revenue: Number(s._sum?.total ?? 0),
        unitsSold: s._sum?.quantity ?? 0,
      }));

      res.json({ data: { products: ranked } });
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;

      const rows = await runInTenantContext(storeId, () =>
        prisma.customerRfmSnapshot.findMany({
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;

      const snapshot = await runInTenantContext(storeId, () =>
        prisma.customerRfmSnapshot.findUnique({
          where: { storeId_customerId: { storeId, customerId } },
        })
      );

      if (!snapshot) {
        res
          .status(404)
          .json({ error: 'not_found', message: 'No RFM snapshot found for this customer.' });
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
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId;
      const userId = (req as any).user?.id;

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
