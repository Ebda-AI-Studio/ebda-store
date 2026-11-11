import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import logger from '../lib/logger';
import { storeDb } from '../lib/repo-factory';

const router = Router({ mergeParams: true });

const EMPTY = { fonts: [], zones: {} };

// Typography is READ-ONLY here. Ruling TYPO-WRITER-1: the builder's publish
// (page-builder.service.ts: applyTypographyPatch inside the publish transaction) is the ONLY
// writer of stores.typography. A second PUT writer raced the draft/publish history and
// skipped its revision; its R2 font cleanup lives in publish. See docs/rulings/TYPO-WRITER-1.md.
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Defensive: column was added by migration 20260501010000. Until
      // every environment runs that migration, swallow P2022 and serve
      // an empty config so the admin page doesn't 500 on first visit.
      try {
        const store = await (
          await storeDb(storeId)
        ).store.findUnique({
          where: { id: storeId },
          select: { typography: true },
        });
        res.json({ success: true, data: { typography: store?.typography ?? EMPTY } });
      } catch (err) {
        logger.warn({ err, storeId }, '[typography GET] column missing?');
        res.json({ success: true, data: { typography: EMPTY } });
      }
    } catch (error) {
      next(error);
    }
  }
);

export default router;
