import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { PagesService } from '../services/pages.service';

const router = Router();

// Empty strings from controlled admin inputs are coerced to null so an
// explicit clear hits the DB column.
const optionalNullableString = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().nullable().optional()
);

const upsertSchema = z.object({
  title: optionalNullableString,
  titleAr: optionalNullableString,
  contentMd: optionalNullableString,
  contentMdAr: optionalNullableString,
  coverImage: optionalNullableString,
  isPublished: z.boolean().optional(),
  position: z.number().int().optional(),
});

// ==========================================
// Admin Routes
// ==========================================

// GET /stores/:storeId/pages — list all CMS pages for a store
router.get(
  '/stores/:storeId/pages',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const pages = await PagesService.list(storeId);
      res.json({ success: true, data: { pages } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/pages/:slug — single CMS page (admin)
router.get(
  '/stores/:storeId/pages/:slug',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      const page = await PagesService.get(storeId, slug);
      if (!page) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Page not found' },
        });
        return;
      }
      res.json({ success: true, data: { page } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/pages/:slug — upsert a CMS page (store_admin OK)
router.put(
  '/stores/:storeId/pages/:slug',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      const payload = upsertSchema.parse(req.body);
      const page = await PagesService.upsert(storeId, slug, payload);
      res.json({ success: true, data: { page } });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/pages/:slug — super_admin only.
//
// Keeps the platform from accidentally letting a store_admin nuke a
// critical legal page (Privacy/Terms). Merchants edit content; only
// platform staff delete shells.
router.delete(
  '/stores/:storeId/pages/:slug',
  authenticate,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      await PagesService.remove(storeId, slug);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public Routes
// ==========================================

// GET /public/:storeId/pages/:slug — storefront public read.
// Returns 404 when the row is missing OR unpublished. The storefront
// treats both cases the same and falls back to its legacy hardcoded
// copy so existing stores don't lose their pages overnight.
router.get(
  '/public/:storeId/pages/:slug',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      const page = await PagesService.getPublic(storeId, slug);
      if (!page) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Page not found' },
        });
        return;
      }
      res.json({ success: true, data: { page } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
