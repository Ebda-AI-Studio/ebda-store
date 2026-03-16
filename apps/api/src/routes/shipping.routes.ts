import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { ShippingService } from '../services/shipping.service';

const router = Router();

// Validation schemas
const createShippingZoneSchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).optional(),
  areas: z.array(z.string()).min(1),
  areasAr: z.array(z.string()).optional(),
  deliveryFee: z.number().min(0),
  freeShippingThreshold: z.number().min(0).optional(),
  estimatedDays: z.number().int().min(1).optional(),
  estimatedDaysMin: z.number().int().min(1).optional(),
  estimatedDaysMax: z.number().int().min(1).optional(),
  position: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const updateShippingZoneSchema = createShippingZoneSchema.partial();

const reorderSchema = z.object({
  zoneIds: z.array(z.string().uuid()),
});

// GET /stores/:storeId/shipping - List all shipping zones
router.get(
  '/:storeId/shipping',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, isActive } = req.query;

      const result = await ShippingService.list(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/shipping/:id - Get shipping zone by ID
router.get(
  '/:storeId/shipping/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const zone = await ShippingService.getById(storeId, id);

      res.json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/shipping - Create shipping zone
router.post(
  '/:storeId/shipping',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createShippingZoneSchema.parse(req.body);

      const zone = await ShippingService.create(storeId, data);

      res.status(201).json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/shipping/:id - Update shipping zone
router.put(
  '/:storeId/shipping/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateShippingZoneSchema.parse(req.body);

      const zone = await ShippingService.update(storeId, id, data);

      res.json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/shipping/:id - Delete shipping zone
router.delete(
  '/:storeId/shipping/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      await ShippingService.delete(storeId, id);

      res.json({
        success: true,
        data: { message: 'Shipping zone deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/shipping/:id/toggle - Toggle shipping zone active status
router.patch(
  '/:storeId/shipping/:id/toggle',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const zone = await ShippingService.toggleActive(storeId, id);

      res.json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/shipping/reorder - Reorder shipping zones
router.put(
  '/:storeId/shipping/reorder',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { zoneIds } = reorderSchema.parse(req.body);

      const result = await ShippingService.reorder(storeId, zoneIds);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: Get shipping zones for storefront
// GET /public/:storeId/shipping
router.get('/public/:storeId/shipping', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;

    const zones = await ShippingService.getPublicZones(storeId);

    res.json({
      success: true,
      data: { zones },
    });
  } catch (error) {
    next(error);
  }
});

// Public endpoint: Calculate shipping cost
// POST /public/:storeId/shipping/calculate
router.post(
  '/public/:storeId/shipping/calculate',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { area, orderTotal } = req.body;

      if (!area) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_AREA', message: 'Delivery area is required' },
        });
        return;
      }

      const result = await ShippingService.calculateShipping(storeId, area, orderTotal || 0);

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
