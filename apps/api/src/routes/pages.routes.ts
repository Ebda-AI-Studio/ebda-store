import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { PagesService, canDeletePage } from '../services/pages.service';
import { auditLog } from '../middleware/security';
import { tenantContext } from '../middleware/tenant-context';

const router = Router();

// This router is mounted at the bare '/' prefix in routes/index.ts (so
// both its '/stores/:storeId/pages' admin CRUD paths and its
// '/public/:storeId/pages/:slug' public paths resolve correctly), but
// Express does NOT populate req.params.storeId at that bare mount level.
// Every route below declares ':storeId' explicitly, so router.param sets
// RLS tenant context correctly here regardless of which surface is hit.
// See F2, docs/plans/done/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

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
  requireMfaEnrolled,
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
  requireMfaEnrolled,
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
  requireMfaEnrolled,
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

// DELETE /stores/:storeId/pages/:slug - a store_admin deletes their own CUSTOM pages; the standard
// pages (home, legal, about...) stay (PROTECTED_PAGE_SLUGS), only platform staff remove those shells.
router.delete(
  '/stores/:storeId/pages/:slug',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      if (!canDeletePage(req.user?.role, slug)) {
        res.status(403).json({
          success: false,
          error: { code: 'PAGE_PROTECTED', message: 'Standard pages cannot be deleted' },
        });
        return;
      }
      await PagesService.remove(storeId, slug);
      await auditLog({
        action: 'page.deleted',
        userId: req.user!.userId,
        resourceType: 'page',
        resourceId: slug,
        details: { storeId, slug },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
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
//   - 200 + page: null    -> no row exists; storefront falls back
//   - 410 PAGE_DISABLED   -> row exists but isPublished=false;
//                            storefront shows "Page unavailable" and
//                            MUST NOT fall back to default copy.
//
// "No row" is the NORMAL state of privacy / terms / about on a store that
// never edited them (the storefront then shows its built-in copy), so it is
// answered 200, not 404: a 404 from this route spends the caller's per-IP
// store-miss budget (`storeMissLimiter`, 20 a minute; only a dead product or
// blog link in a verified store is left out, LAUNCH-RL-MISS-3), and a shopper
// reading the policy pages of a real store was being counted as a prober
// (pre-QA sweep 2026-11-09, finding 6). An unknown store is still a 404.
router.get(
  '/public/:storeId/pages/:slug',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      const result = await PagesService.getPublic(storeId, slug);
      if (result.status === 'not_found') {
        res.json({ success: true, data: { page: null } });
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
