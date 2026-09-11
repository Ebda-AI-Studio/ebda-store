import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess, checkStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { shippingCarrierService } from '../services/shipping-carrier.service';
import { CARRIER_CODES, CarrierCode } from '../services/carriers/types';

const router = Router();

// ==========================================
// Validation schemas
// ==========================================

/**
 * `credentials` is an open string map because each carrier declares its own
 * key set. One key is special: `baseUrl` reaches a server-side `fetch()` in
 * the carrier client, so unchecked it is an SSRF primitive (see
 * `carriers/icarry.carrier.ts` and `tests/unit/carrier-ssrf.test.ts`).
 *
 * The carrier client is the authority — it resolves the host and blocks
 * private/loopback/link-local targets at call time, which is the only check
 * that survives a DNS record changing after the write. This refinement is the
 * cheap edge half: it rejects an obviously-wrong value while the merchant is
 * still looking at the form, instead of silently storing it and failing later.
 */
const carrierConfigSchema = z.object({
  enabled: z.boolean(),
  isDefault: z.boolean().optional(),
  credentials: z.record(z.string(), z.string()).refine(
    creds => {
      const baseUrl = creds.baseUrl?.trim();
      if (!baseUrl) return true;
      try {
        const u = new URL(baseUrl);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'credentials.baseUrl must be an http(s) URL', path: ['baseUrl'] }
  ),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const shipOrderSchema = z.object({
  carrier: z.enum(CARRIER_CODES).optional(),
});

const listShipmentsSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  status: z.string().optional(),
  carrier: z.enum(CARRIER_CODES).optional(),
});

// ==========================================
// Admin middleware chain (shared)
// ==========================================

const adminMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('shipping_carriers'),
];

// ==========================================
// GET /:storeId/shipping-carriers/configs
// List all carrier configs for a store
// ==========================================

router.get(
  '/:storeId/shipping-carriers/configs',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const configs = await shippingCarrierService.getCarrierConfigs(storeId);

      // Mask credentials in response
      const safe = configs.map((c: any) => ({
        ...c,
        credentials: maskCredentials(c.credentials),
      }));

      res.json({ success: true, data: { configs: safe } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/shipping-carriers/configs/:carrier
// Get a single carrier config
// ==========================================

router.get(
  '/:storeId/shipping-carriers/configs/:carrier',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, carrier } = req.params;

      if (!isValidCarrier(carrier)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CARRIER', message: `Unknown carrier: ${carrier}` },
        });
        return;
      }

      const config = await shippingCarrierService.getCarrierConfig(storeId, carrier);

      res.json({
        success: true,
        data: {
          config: config ? { ...config, credentials: maskCredentials(config.credentials) } : null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// PUT /:storeId/shipping-carriers/configs/:carrier
// Upsert a carrier config
// ==========================================

router.put(
  '/:storeId/shipping-carriers/configs/:carrier',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, carrier } = req.params;

      if (!isValidCarrier(carrier)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CARRIER', message: `Unknown carrier: ${carrier}` },
        });
        return;
      }

      const data = carrierConfigSchema.parse(req.body);
      const result = await shippingCarrierService.upsertCarrierConfig(storeId, carrier, data);

      res.json({
        success: true,
        data: { config: { ...result, credentials: undefined } },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// DELETE /:storeId/shipping-carriers/configs/:carrier
// Delete a carrier config
// ==========================================

router.delete(
  '/:storeId/shipping-carriers/configs/:carrier',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, carrier } = req.params;

      if (!isValidCarrier(carrier)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CARRIER', message: `Unknown carrier: ${carrier}` },
        });
        return;
      }

      await shippingCarrierService.deleteCarrierConfig(storeId, carrier);

      res.json({ success: true, data: { message: 'Carrier config deleted' } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// POST /:storeId/shipping-carriers/test/:carrier
// Test carrier credentials
// ==========================================

router.post(
  '/:storeId/shipping-carriers/test/:carrier',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, carrier } = req.params;

      if (!isValidCarrier(carrier)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CARRIER', message: `Unknown carrier: ${carrier}` },
        });
        return;
      }

      const result = await shippingCarrierService.testConnection(storeId, carrier);

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// POST /:storeId/shipping-carriers/default/:carrier
// Set the default carrier for a store
// ==========================================

router.post(
  '/:storeId/shipping-carriers/default/:carrier',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, carrier } = req.params;

      if (!isValidCarrier(carrier)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CARRIER', message: `Unknown carrier: ${carrier}` },
        });
        return;
      }

      await shippingCarrierService.setDefaultCarrier(storeId, carrier);

      res.json({ success: true, data: { message: `${carrier} set as default carrier` } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// POST /:storeId/orders/:orderId/ship
// Manually trigger shipment creation for an order
// ==========================================

router.post(
  '/:storeId/orders/:orderId/ship',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const { carrier } = shipOrderSchema.parse(req.body);

      const shipment = await shippingCarrierService.createShipmentForOrder(
        storeId,
        orderId,
        carrier
      );

      res.status(201).json({ success: true, data: { shipment } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// POST /:storeId/orders/:orderId/ship/cancel
// Cancel the shipment for an order
// ==========================================

router.post(
  '/:storeId/orders/:orderId/ship/cancel',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;

      // Find the shipment for this order
      const { prisma } = await import('@force/database');
      const existing = await prisma.shipment.findFirst({ where: { orderId, storeId } });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'No shipment found for this order' },
        });
        return;
      }

      const shipment = await shippingCarrierService.cancelShipment(existing.id);

      res.json({ success: true, data: { shipment } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/shipments
// List shipments for a store (paginated)
// ==========================================

router.get(
  '/:storeId/shipments',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const options = listShipmentsSchema.parse(req.query);

      const result = await shippingCarrierService.listShipments(storeId, options);

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/shipments/:id
// Get a single shipment
// ==========================================

router.get(
  '/:storeId/shipments/:id',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { prisma } = await import('@force/database');

      const shipment = await prisma.shipment.findFirst({
        where: { id, storeId },
        include: {
          order: {
            select: {
              orderNumber: true,
              status: true,
              total: true,
              customer: { select: { email: true, firstName: true, lastName: true } },
            },
          },
        },
      });

      if (!shipment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Shipment not found' },
        });
        return;
      }

      res.json({ success: true, data: { shipment } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// POST /:storeId/shipments/:id/track
// Force-refresh tracking status from carrier
// ==========================================

router.post(
  '/:storeId/shipments/:id/track',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      // Verify the shipment belongs to this store
      const { prisma } = await import('@force/database');
      const existing = await prisma.shipment.findFirst({ where: { id, storeId } });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Shipment not found' },
        });
        return;
      }

      const shipment = await shippingCarrierService.updateShipmentStatus(id);

      res.json({ success: true, data: { shipment } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public route: GET /public/:storeId/orders/:orderId/tracking
// Returns tracking info for an order (ownership check via session/auth)
// ==========================================

router.get(
  '/public/:storeId/orders/:orderId/tracking',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = req.user;

      const { prisma } = await import('@force/database');

      // Fetch order to verify ownership
      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId },
        select: { id: true, customerId: true, orderNumber: true },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      // Customer path: ownership against `customerId`.
      // Admin path: must own the store (or be super_admin) — without
      // this check a store_admin from Store A could read tracking for
      // any Order under Store B by changing :storeId in the URL.
      if (user?.role === 'customer') {
        if (order.customerId !== user.userId) {
          res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Access denied' },
          });
          return;
        }
      } else if (user?.role === 'store_admin' || user?.role === 'super_admin') {
        const access = await checkStoreAccess(storeId, user);
        if (!access.ok) {
          res
            .status(access.status)
            .json({ success: false, error: { code: access.code, message: access.message } });
          return;
        }
      } else {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Access denied' },
        });
        return;
      }

      const shipment = await prisma.shipment.findFirst({
        where: { orderId, storeId },
        select: {
          id: true,
          carrier: true,
          trackingNumber: true,
          trackingUrl: true,
          status: true,
          statusHistory: true,
          estimatedDeliveryAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.json({
        success: true,
        data: {
          orderNumber: order.orderNumber,
          shipment: shipment ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Helpers
// ==========================================

function isValidCarrier(carrier: string): carrier is CarrierCode {
  return (CARRIER_CODES as readonly string[]).includes(carrier);
}

function maskCredentials(credentials: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value === 'string' && value.length > 4) {
      masked[key] = `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 4))}`;
    } else {
      masked[key] = '****';
    }
  }
  return masked;
}

export default router;
