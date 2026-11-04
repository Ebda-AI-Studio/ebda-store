import { Router } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { runInStoreTenantContext as runInTenantContext } from '../lib/store-scoped-read';
import { withStore } from '@ebda/database';
import { listSlugRedirects, deleteSlugRedirect } from '../services/slug-redirect.service';

// #903: SlugRedirect had no admin UI surface at all — a merchant could not
// see or remove a spuriously-captured bulk-import alias, or a stale redirect
// blocking an old slug being re-purposed. Read + delete only: rows are
// written exclusively by recordSlugRedirect alongside the entity rename that
// produced them (see docs/architecture/slug-redirects.md), so there is no
// create/edit path here on purpose.
const router = Router();

const listQuerySchema = z.object({
  q: z.string().max(255).optional(),
  // Issue 2255: page through every row. `limit` is clamped to
  // SLUG_REDIRECT_LIST_MAX by the service; `cursor` is the previous page's
  // `nextCursor` (a row id).
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

// GET /:storeId/slug-redirects?q= — list this store's redirects, newest first.
// Responds `{ data: { rows, total, limit, nextCursor } }`: `total` counts every match so
// the admin can say "showing 200 of N" instead of silently capping (scoped
// audit, PR 1978); `q` filters by either slug so an older row stays findable.
router.get(
  '/:storeId/slug-redirects',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const { q, limit, cursor } = listQuerySchema.parse(req.query);
      const data = await withStore(req.params.storeId, () =>
        listSlugRedirects(req.params.storeId, { q, limit, cursor })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:storeId/slug-redirects/:id — remove a redirect row
router.delete(
  '/:storeId/slug-redirects/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('seo'), // BE:S-9
  async (req, res, next) => {
    try {
      await withStore(req.params.storeId, () =>
        deleteSlugRedirect(req.params.storeId, req.params.id)
      );
      res.json({ data: { deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
