import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { BlogService } from '../services/blog.service';
import { writeLimiter } from '../middleware/security';
import { tenantContext } from '../middleware/tenant-context';
import { storeDb } from '../lib/repo-factory';

/**
 * Blog routes (Bucket E1, 2026-05-17).
 *
 * Public reads at `/public/:storeId/blog` (list + single).
 * Admin CRUD at `/stores/:storeId/blog`.
 *
 * Both surfaces 404 when the store has `blogEnabled=false` so a
 * merchant who hasn't opted in never accidentally exposes a stub
 * empty blog (returns 0 posts) to crawlers.
 *
 * This router is mounted at the bare '/' prefix in routes/index.ts, so
 * Express does NOT populate req.params.storeId at the mount level.
 * router.param (below) sets RLS tenant context after Express resolves
 * :storeId for the matched route. See F2,
 * docs/plans/2026-07-02-rls-cutover.md.
 */
const router = Router({ mergeParams: true });

router.param('storeId', tenantContext);

const optionalNullableString = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().nullable().optional()
);

const blogPostSchema = z.object({
  slug: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  titleAr: optionalNullableString,
  excerpt: optionalNullableString,
  excerptAr: optionalNullableString,
  content: z.string().min(1).max(50000),
  contentAr: optionalNullableString,
  coverImage: optionalNullableString,
  isPublished: z.boolean().optional(),
});

const blogPostPatchSchema = blogPostSchema.partial();

/**
 * Helper — short-circuit when the store hasn't opted in.
 * Returns true when handled (caller should `return`).
 */
async function gateBlogEnabled(storeId: string, res: Response): Promise<boolean> {
  const store = await (
    await storeDb(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: { blogEnabled: true },
  });
  if (!store) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
    return true;
  }
  if (!store.blogEnabled) {
    res.status(404).json({
      success: false,
      error: { code: 'BLOG_DISABLED', message: 'Blog not enabled for this store' },
    });
    return true;
  }
  return false;
}

// ==========================================
// PUBLIC: list published posts
// ==========================================
router.get('/public/:storeId/blog', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    if (await gateBlogEnabled(storeId, res)) return;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const posts = await BlogService.listPublished(storeId, { limit, offset });
    res.json({ success: true, data: { posts } });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// PUBLIC: single published post by slug
// ==========================================
router.get(
  '/public/:storeId/blog/:slug',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;
      if (await gateBlogEnabled(storeId, res)) return;
      const post = await BlogService.getPublishedBySlug(storeId, slug);
      if (!post) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Blog post not found' } });
        return;
      }
      res.json({ success: true, data: { post } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: list all (including drafts)
// ==========================================
router.get(
  '/stores/:storeId/blog',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const posts = await BlogService.listAll(storeId);
      res.json({ success: true, data: { posts } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: read single
// ==========================================
router.get(
  '/stores/:storeId/blog/:postId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, postId } = req.params;
      const post = await BlogService.getById(storeId, postId);
      res.json({ success: true, data: { post } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: create
// ==========================================
router.post(
  '/stores/:storeId/blog',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const payload = blogPostSchema.parse(req.body);
      const post = await BlogService.create(storeId, payload);
      res.status(201).json({ success: true, data: { post } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: update
// ==========================================
router.put(
  '/stores/:storeId/blog/:postId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, postId } = req.params;
      const payload = blogPostPatchSchema.parse(req.body);
      const post = await BlogService.update(storeId, postId, payload);
      res.json({ success: true, data: { post } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: delete
// ==========================================
router.delete(
  '/stores/:storeId/blog/:postId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, postId } = req.params;
      await BlogService.remove(storeId, postId);
      res.json({ success: true, data: { ok: true } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
