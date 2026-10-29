import { Router, Request, Response, NextFunction } from 'express';
import { typographySchema } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { fontLibraryProblems } from '../lib/font-url-guard';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma } from '@ebda/database';
import { invalidateCached } from '../lib/public-cache';
import { deleteR2ObjectIfOrphan } from '../services/r2-cleanup.service';
import logger from '../lib/logger';
import { storeUpdate } from '../lib/repo-factory';

const router = Router({ mergeParams: true });

const EMPTY = { fonts: [], zones: {} };

// GET /stores/:storeId/typography — current typography settings.
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
        const store = await prisma.store.findUnique({
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

// PUT /stores/:storeId/typography — replace the entire typography
// blob. The admin form is a single coherent unit, so partial updates
// don't add real value here — the client always sends the full shape.
router.put(
  '/',
  authenticate,
  requirePermission('settings:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = typographySchema.parse(req.body);
      // The URL of a font later drives an R2 delete: only this store's own uploads or Google stylesheets.
      const badFonts = fontLibraryProblems(storeId, data.fonts);
      if (badFonts.length > 0)
        throw new AppError(422, 'INVALID_FONT_URL', badFonts[0].reason, { fonts: badFonts });

      // Snapshot the previous custom-font URLs so we can clean up R2
      // when a font gets removed from the library.
      let previous: { fonts?: Array<{ type: string; url?: string }> } = {};
      try {
        const existing = await prisma.store.findUnique({
          where: { id: storeId },
          select: { typography: true },
        });
        previous = (existing?.typography as typeof previous) ?? {};
      } catch (err) {
        // pre-migration; nothing to compare
        logger.warn({ err, storeId }, '[typography PUT] previous read failed');
      }

      const store = await storeUpdate(prisma, {
        where: { id: storeId },
        data: { typography: data },
        select: { typography: true },
      });

      // R2 cleanup for any custom font URL that disappeared from the
      // library. Google fonts are external — nothing to delete.
      const newCustomUrls = new Set(data.fonts.filter(f => f.type === 'custom').map(f => f.url));
      const previousFonts = Array.isArray(previous.fonts) ? previous.fonts : [];
      for (const f of previousFonts) {
        if (f.type !== 'custom' || !f.url) continue;
        if (newCustomUrls.has(f.url)) continue;
        void deleteR2ObjectIfOrphan(f.url).catch(err =>
          logger.warn({ err, storeId, url: f.url }, '[typography PUT] r2 cleanup failed')
        );
      }

      await auditLog({
        action: 'store.typography.updated',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Bust the public store cache so the storefront picks up the new
      // typography on the next request rather than waiting out the TTL.
      await invalidateCached(`public:store:${storeId}`);

      res.json({ success: true, data: { typography: store.typography } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
