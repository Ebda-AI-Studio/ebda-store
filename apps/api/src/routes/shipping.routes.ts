import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { ShippingService } from '../services/shipping.service';
import { prisma } from '@force/database';

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

// GET /:storeId/shipping/area-rates — list all area rates for the store.
// MUST be defined before `/:storeId/shipping/:id` or Express matches the
// literal `area-rates` segment as a zone id and 404s (caught by the
// integration test).
router.get(
  '/:storeId/shipping/area-rates',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const rates = await prisma.shippingAreaRate.findMany({
        where: { storeId },
        orderBy: [{ position: 'asc' }, { governorate: 'asc' }, { area: 'asc' }],
      });

      res.json({
        success: true,
        data: { rates },
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

// ─── ShippingAreaRate schemas ──────────────────────────────────────────────

const areaRateSchema = z.object({
  governorate: z.string().min(1).max(60),
  governorateAr: z.string().min(1).max(60),
  area: z.string().min(1).max(60),
  areaAr: z.string().min(1).max(60),
  deliveryFee: z.number().int().min(0),
  freeShippingThreshold: z.number().int().min(0).optional().nullable(),
  isActive: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const updateAreaRateSchema = areaRateSchema.partial();

const bulkAreaRateSchema = z.object({ rates: z.array(areaRateSchema).max(300) });

// ─── ShippingAreaRate authed CRUD ──────────────────────────────────────────
// (GET list lives above the `/:id` zone route to avoid the route-shadowing 404.)

// PUT /:storeId/shipping/area-rates/bulk — upsert all area rates (admin "save all")
router.put(
  '/:storeId/shipping/area-rates/bulk',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { rates } = bulkAreaRateSchema.parse(req.body);

      await prisma.$transaction(
        rates.map(rate =>
          prisma.shippingAreaRate.upsert({
            where: {
              storeId_governorate_area: {
                storeId,
                governorate: rate.governorate,
                area: rate.area,
              },
            },
            create: {
              storeId,
              governorate: rate.governorate,
              governorateAr: rate.governorateAr,
              area: rate.area,
              areaAr: rate.areaAr,
              deliveryFee: rate.deliveryFee,
              freeShippingThreshold: rate.freeShippingThreshold ?? null,
              isActive: rate.isActive ?? true,
              position: rate.position ?? 0,
            },
            update: {
              governorateAr: rate.governorateAr,
              areaAr: rate.areaAr,
              deliveryFee: rate.deliveryFee,
              freeShippingThreshold: rate.freeShippingThreshold ?? null,
              isActive: rate.isActive ?? true,
              position: rate.position ?? 0,
            },
          })
        )
      );

      const rates_result = await prisma.shippingAreaRate.findMany({
        where: { storeId },
        orderBy: [{ position: 'asc' }, { governorate: 'asc' }, { area: 'asc' }],
      });

      res.json({
        success: true,
        data: { rates: rates_result },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /:storeId/shipping/area-rates/:id — partial update a single area rate
router.patch(
  '/:storeId/shipping/area-rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateAreaRateSchema.parse(req.body);

      const rate = await prisma.shippingAreaRate.updateMany({
        where: { id, storeId },
        data,
      });

      if (rate.count === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Area rate not found' },
        });
        return;
      }

      const updated = await prisma.shippingAreaRate.findFirst({
        where: { id, storeId },
      });

      res.json({
        success: true,
        data: { rate: updated },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:storeId/shipping/area-rates/:id — delete a single area rate
router.delete(
  '/:storeId/shipping/area-rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const deleted = await prisma.shippingAreaRate.deleteMany({
        where: { id, storeId },
      });

      if (deleted.count === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Area rate not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: { message: 'Area rate deleted successfully' },
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
      const calcSchema = z.object({
        area: z.string().trim().min(1).max(150),
        orderTotal: z.number().int().min(0).optional().default(0),
        governorate: z.string().trim().max(60).optional().default(''),
      });
      const parsed = calcSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_AREA', message: 'Delivery area is required' },
        });
        return;
      }
      const { area, orderTotal, governorate } = parsed.data;

      const result = await ShippingService.calculateShipping(
        storeId,
        area,
        orderTotal,
        governorate || undefined
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: Get area rates for storefront (active only, no sensitive fields)
// GET /public/:storeId/shipping/area-rates
router.get(
  '/public/:storeId/shipping/area-rates',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const rates = await prisma.shippingAreaRate.findMany({
        where: { storeId, isActive: true },
        orderBy: [{ position: 'asc' }, { governorate: 'asc' }, { area: 'asc' }],
        select: {
          governorate: true,
          governorateAr: true,
          area: true,
          areaAr: true,
          deliveryFee: true,
          freeShippingThreshold: true,
        },
      });

      res.json({
        success: true,
        data: { rates },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
