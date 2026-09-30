import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { TaxService } from '../services/tax.service';
import { tenantContext } from '../middleware/tenant-context';

const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

// Validation schemas
const updateSettingsSchema = z.object({
  taxEnabled: z.boolean().optional(),
  taxIncludedInPrice: z.boolean().optional(),
  defaultTaxRate: z.number().min(0).max(100).nullable().optional(),
});

// Optional columns are `.nullable()` so an emptied field on the edit modal
// CLEARS them: Prisma reads `null` as "set to NULL", `undefined` (omitted
// key) as "leave alone". Without the null form the merchant's clear no-ops.
const createTaxRateSchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).optional().nullable(),
  rate: z.number().min(0).max(100),
  country: z.string().max(2).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  priority: z.number().int().min(0).optional(),
  isCompound: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updateTaxRateSchema = createTaxRateSchema.partial();

// GET /stores/:storeId/tax/settings - Get tax settings
router.get(
  '/:storeId/tax/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const settings = await TaxService.getSettings(storeId);

      res.json({
        success: true,
        data: { settings },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/tax/settings - Update tax settings
router.put(
  '/:storeId/tax/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = updateSettingsSchema.parse(req.body);

      const settings = await TaxService.updateSettings(storeId, data);

      res.json({
        success: true,
        data: { settings },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/tax/rates - List tax rates
router.get(
  '/:storeId/tax/rates',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { includeInactive } = req.query;

      const rates = await TaxService.listRates(storeId, includeInactive === 'true');

      res.json({
        success: true,
        data: { rates },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/tax/rates/:id - Get tax rate by ID
router.get(
  '/:storeId/tax/rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const rate = await TaxService.getRate(storeId, id);

      res.json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/tax/rates - Create tax rate
router.post(
  '/:storeId/tax/rates',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createTaxRateSchema.parse(req.body);

      const rate = await TaxService.createRate(storeId, data);

      res.status(201).json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/tax/rates/:id - Update tax rate
router.put(
  '/:storeId/tax/rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateTaxRateSchema.parse(req.body);

      const rate = await TaxService.updateRate(storeId, id, data);

      res.json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/tax/rates/:id - Delete tax rate
router.delete(
  '/:storeId/tax/rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      await TaxService.deleteRate(storeId, id);

      res.json({
        success: true,
        data: { message: 'Tax rate deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/tax/rates/:id/toggle - Toggle tax rate active status
router.patch(
  '/:storeId/tax/rates/:id/toggle',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('tax'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const rate = await TaxService.toggleRate(storeId, id);

      res.json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: Calculate tax for an order
// POST /public/:storeId/tax/calculate
router.post(
  '/public/:storeId/tax/calculate',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { subtotal, country, state } = req.body;

      if (subtotal === undefined || subtotal === null) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_SUBTOTAL', message: 'Subtotal is required' },
        });
        return;
      }

      const result = await TaxService.calculateTax(storeId, subtotal, country, state);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
