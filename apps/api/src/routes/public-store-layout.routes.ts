/**
 * Public read of a store's layout settings — used by the storefront's
 * <HomeComposition> to decide which sections to render and how. No auth
 * required; the data is layout-only (no PII), and it must load fast on
 * cold-cache page loads.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
import { resolveLayoutSettings } from '@force/shared';

const router = Router();

router.get('/stores/:storeId/layout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const store = await prisma.store.findFirst({
      where: { id: storeId, status: 'active' },
      select: { layoutSettings: true },
    });
    if (!store) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Store not found' },
      });
      return;
    }
    const layout = resolveLayoutSettings(store.layoutSettings);
    // Cache lightly at the edge — layout settings change rarely
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({ success: true, data: { layout } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /public/stores/:storeId/testimonials
 * Returns approved store-wide reviews suitable for the home page testimonial
 * row. Filters: minimum rating, optional verified-purchase only. Capped at
 * `limit` (default 6) and ordered by rating DESC, recent first.
 *
 * Empty result is valid — the storefront hides the section when no
 * qualifying reviews exist.
 */
router.get(
  '/stores/:storeId/testimonials',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const minRating = Math.max(
        1,
        Math.min(5, parseInt((req.query.minRating as string) || '4', 10))
      );
      const verifiedOnly = req.query.verifiedOnly === 'true';
      const limit = Math.max(1, Math.min(20, parseInt((req.query.limit as string) || '6', 10)));

      const reviews = await prisma.review.findMany({
        where: {
          storeId,
          status: 'published',
          rating: { gte: minRating },
          ...(verifiedOnly ? { verifiedPurchase: true } : {}),
        },
        include: {
          customer: {
            select: { firstName: true, lastName: true },
          },
        },
        orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      });

      const testimonials = reviews.map(r => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        comment: r.body,
        authorName: r.customer
          ? `${r.customer.firstName ?? ''} ${(r.customer.lastName ?? '').slice(0, 1).toUpperCase()}.`.trim()
          : 'Customer',
        authorCity: null as string | null,
        createdAt: r.createdAt.toISOString(),
      }));

      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      res.json({ success: true, data: { testimonials } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
