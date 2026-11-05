import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { writeLimiter } from '../middleware/security';
import { LocationsService } from '../services/locations.service';
import { locationInputSchema } from '@ebda/shared';
import { tenantContext } from '../middleware/tenant-context';
import { storeDb } from '../lib/repo-factory';

/**
 * Locations routes (Store Locations / Branches feature, 2026-06-16).
 *
 * Public reads at `/public/:storeId/locations`.
 * Admin CRUD at `/stores/:storeId/locations`.
 *
 * Both surfaces 404 when the store has `locationsEnabled=false` so a
 * merchant who hasn't opted in never accidentally exposes an empty
 * locations page to crawlers. (Default: false — new-visual-feature rule #2.)
 *
 * This router is mounted at the bare '/' prefix in routes/index.ts, so
 * Express does NOT populate req.params.storeId at the mount level.
 * router.param (below) sets RLS tenant context after Express resolves
 * :storeId for the matched route (NOTE: ':id' elsewhere in this file is
 * the location's own id, NOT the storeId — only 'storeId' is registered).
 * See F2, docs/plans/2026-07-02-rls-cutover.md.
 */
const router = Router({ mergeParams: true });

router.param('storeId', tenantContext);

/**
 * Helper — short-circuit when the store hasn't opted in to Locations.
 * Returns true when the response has been handled (caller should `return`).
 */
async function gateLocationsEnabled(storeId: string, res: Response): Promise<boolean> {
  const store = await (
    await storeDb(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: { locationsEnabled: true },
  });
  if (!store) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
    return true;
  }
  if (!store.locationsEnabled) {
    res.status(404).json({
      success: false,
      error: { code: 'LOCATIONS_DISABLED', message: 'Locations not enabled for this store' },
    });
    return true;
  }
  return false;
}

// ==========================================
// PUBLIC: list published locations
// ==========================================
router.get(
  '/public/:storeId/locations',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      if (await gateLocationsEnabled(storeId, res)) return;
      const locations = await LocationsService.listPublished(storeId);
      res.json({ success: true, data: { locations } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: list all (including unpublished)
// ==========================================
router.get(
  '/stores/:storeId/locations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const locations = await LocationsService.list(storeId);
      res.json({ success: true, data: { locations } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: create
// ==========================================
router.post(
  '/stores/:storeId/locations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = locationInputSchema.parse(req.body);
      const location = await LocationsService.create(storeId, data);
      res.status(201).json({ success: true, data: { location } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: update
// ==========================================
router.put(
  '/stores/:storeId/locations/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = locationInputSchema.partial().parse(req.body);
      const location = await LocationsService.update(storeId, id, data);
      if (!location) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } });
        return;
      }
      res.json({ success: true, data: { location } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// ADMIN: delete
// ==========================================
router.delete(
  '/stores/:storeId/locations/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const ok = await LocationsService.remove(storeId, id);
      if (!ok) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } });
        return;
      }
      res.json({ success: true, data: { ok: true } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
