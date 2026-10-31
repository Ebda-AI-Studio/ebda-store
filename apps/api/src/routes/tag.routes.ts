import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { invalidateStoreProductCaches } from '../lib/public-cache';

/**
 * Store tags, admin side (Phase B3 fix wave 1, Ruling B3-13): the skin-type / concern chips are
 * tags, and a tag has two labels: `name` (canonical, English; also the `?tag=` filter key) and
 * `nameAr` (shown on the Arabic storefront). Every query carries `storeId`.
 */
const router = Router({ mergeParams: true });

const adminChain = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];

// GET /stores/:storeId/tags — every tag with its product count (any status), name order.
router.get('/', ...adminChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const rows = await (
      await storeDb(storeId)
    ).tag.findMany({
      where: { storeId },
      select: { id: true, name: true, nameAr: true, _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
      take: 500,
    });
    res.json({
      success: true,
      data: {
        tags: rows.map(r => ({
          id: r.id,
          name: r.name,
          nameAr: r.nameAr,
          productCount: r._count.products,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    // null / '' clears the Arabic label (the storefront then falls back to `name`)
    nameAr: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

// PUT /stores/:storeId/tags/:tagId
router.put(
  '/:tagId',
  ...adminChain,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, tagId } = req.params;
      const data = updateTagSchema.parse(req.body);
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
      const existing = await w.tag.findFirst({
        where: { id: tagId, storeId },
        select: { id: true },
      });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Tag not found');
      if (data.name !== undefined) {
        const clash = await w.tag.findFirst({
          where: { storeId, name: data.name, NOT: { id: tagId } },
          select: { id: true },
        });
        if (clash) throw new AppError(409, 'TAG_EXISTS', 'A tag with this name already exists');
      }
      const tag = await w.tag.update({
        where: { id: tagId, storeId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.nameAr !== undefined ? { nameAr: data.nameAr || null } : {}),
        },
        select: { id: true, name: true, nameAr: true },
      });
      // The chips and the PLP read the public tag list: bust it with the product caches.
      await invalidateStoreProductCaches(storeId);
      await auditLog({
        action: 'tag.updated',
        userId: req.user!.userId,
        storeId,
        resourceType: 'tag',
        resourceId: tagId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { tag } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
