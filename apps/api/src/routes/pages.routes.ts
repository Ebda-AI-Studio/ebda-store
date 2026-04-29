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

// ---------- Block schema (mirrors apps/api/src/services/pages.service.ts) ----------

const headingBlock = z.object({
  type: z.literal('heading'),
  level: z.union([z.literal(2), z.literal(3)]),
  text: z.string().max(500),
});

const paragraphBlock = z.object({
  type: z.literal('paragraph'),
  text: z.string().max(10000),
});

const bulletsBlock = z.object({
  type: z.literal('bullets'),
  items: z.array(z.string().max(2000)).max(100),
});

const numberedBlock = z.object({
  type: z.literal('numbered'),
  items: z.array(z.string().max(2000)).max(100),
});

const imageBlock = z.object({
  type: z.literal('image'),
  url: z.string().max(2048),
  alt: z.string().max(500),
});

const buttonBlock = z.object({
  type: z.literal('button'),
  label: z.string().max(200),
  url: z.string().max(2048),
});

const blockSchema = z.discriminatedUnion('type', [
  headingBlock,
  paragraphBlock,
  bulletsBlock,
  numberedBlock,
  imageBlock,
  buttonBlock,
]);

const optionalBlockArray = z.array(blockSchema).max(200).nullable().optional();

const upsertSchema = z.object({
  title: optionalNullableString,
  titleAr: optionalNullableString,
  contentBlocks: optionalBlockArray,
  contentBlocksAr: optionalBlockArray,
  coverImage: optionalNullableString,
  isPublished: z.boolean().optional(),
  position: z.number().int().optional(),
});

// ==========================================
// Admin Routes
// ==========================================

// GET /stores/:storeId/pages - list all CMS pages for a store
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

// GET /stores/:storeId/pages/:slug - single CMS page (admin)
//
// Returns the raw block arrays so the editor can hydrate its form.
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

// PUT /stores/:storeId/pages/:slug - upsert a CMS page (store_admin OK)
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

// DELETE /stores/:storeId/pages/:slug - super_admin only.
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

// GET /public/:storeId/pages/:slug - storefront public read.
//
// Three-state response so the storefront can distinguish "no row, fall
// back to legacy copy" from "merchant explicitly turned this page off":
//
//   - 200 + page          -> render `contentHtml` / `contentHtmlAr`
//   - 404 NOT_FOUND       -> no row exists; storefront falls back
//   - 410 PAGE_DISABLED   -> row exists but isPublished=false;
//                            storefront shows "Page unavailable" and
//                            MUST NOT fall back to default copy.
router.get(
  '/public/:storeId/pages/:slug',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      const result = await PagesService.getPublic(storeId, slug);
      if (result.status === 'not_found') {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Page not found' },
        });
        return;
      }
      if (result.status === 'disabled') {
        res.status(410).json({
          success: false,
          error: { code: 'PAGE_DISABLED', message: 'Page is turned off by the merchant' },
        });
        return;
      }
      res.json({ success: true, data: { page: result.page } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
