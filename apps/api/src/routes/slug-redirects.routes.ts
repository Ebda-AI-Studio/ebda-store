import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { runInTenantContext } from '@force/database';
import { listSlugRedirects, deleteSlugRedirect } from '../services/slug-redirect.service';

// #903: SlugRedirect had no admin UI surface at all — a merchant could not
// see or remove a spuriously-captured bulk-import alias, or a stale redirect
// blocking an old slug being re-purposed. Read + delete only: rows are
// written exclusively by recordSlugRedirect alongside the entity rename that
// produced them (see docs/architecture/slug-redirects.md), so there is no
// create/edit path here on purpose.
const router = Router();

const listQuerySchema = z.object({ q: z.string().max(255).optional() });

// GET /:storeId/slug-redirects?q= — list this store's redirects, newest first.
// Responds `{ data: { rows, total, limit } }`: `total` counts every match so
// the admin can say "showing 200 of N" instead of silently capping (scoped
// audit, PR 1978); `q` filters by either slug so an older row stays findable.
router.get(
  '/:storeId/slug-redirects',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const { q } = listQuerySchema.parse(req.query);
      const data = await runInTenantContext(req.params.storeId, () =>
        listSlugRedirects(req.params.storeId, { q })
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
  async (req, res, next) => {
    try {
      await runInTenantContext(req.params.storeId, () =>
        deleteSlugRedirect(req.params.storeId, req.params.id)
      );
      res.json({ data: { deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
