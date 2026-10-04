import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess, checkStoreAccess } from '../middleware/store-access';
import { shippingCarrierRouteContext } from '../middleware/tenant-context';
import { requireFeature } from '../middleware/feature-gate';
import { shippingCarrierService } from '../services/shipping-carrier.service';
import {
  CARRIER_CODES,
  CarrierCode,
  CarrierError,
  SHIPMENT_STATUSES,
} from '../services/carriers/types';
import { codReconciliationService } from '../services/cod-reconciliation.service';
import { AppError } from '../middleware/error-handler';

const router = Router();

// Mounted at the bare `/stores` prefix, which never sees `:storeId`: the store scope is
// registered here, per request (reads one transaction, carrier calls and writes store scope).
router.param('storeId', (req, res, next) => shippingCarrierRouteContext(req, res, next));

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
export const carrierConfigSchema = z.object({
  enabled: z.boolean(),
  isDefault: z.boolean().optional(),
  credentials: z.record(z.string(), z.string()).refine(
    creds => {
      const baseUrl = creds.baseUrl?.trim();
      if (!baseUrl) return true;
      // An unchanged field resubmits the `****` mask maskCredentials()
      // emitted (preserveMaskedCredentials merges it back to the real
      // stored value AFTER this parse) — validating that as a URL runs
      // `new URL('****')`, which throws, and would 400 a save the
      // merchant made no baseUrl edit in at all.
      if (baseUrl.includes('****')) return true;
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

const shipOrderSchema = z
  .object({
    carrier: z.enum(CARRIER_CODES).optional(),
    // The manual carrier: the merchant types the courier's name and the tracking number.
    manual: z
      .object({
        carrierName: z.string().trim().min(1).max(80),
        trackingNumber: z.string().trim().min(1).max(80),
      })
      .optional(),
  })
  .refine(v => v.carrier !== 'manual' || !!v.manual, {
    message: 'manual shipments need a carrier name and a tracking number',
    path: ['manual'],
  });

const cancelShipmentSchema = z.object({ force: z.boolean().optional() });
const manualStatusSchema = z.object({ status: z.enum(SHIPMENT_STATUSES as [string, ...string[]]) });
const importSettlementSchema = z.object({
  carrier: z.enum(CARRIER_CODES),
  // the statement as text: a CSV a merchant downloads from their carrier's portal
  csv: z.string().min(1).max(2_000_000),
});
const codReportSchema = z.object({
  carrier: z.enum(CARRIER_CODES).optional(),
  status: z
    .enum(['awaiting', 'partial', 'settled', 'over_remitted', 'mismatch', 'flagged'])
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** Carrier failures as HTTP answers: an outage is a 502 (the order is untouched), a refusal a 4xx. */
function carrierErrorToHttp(err: unknown): unknown {
  if (!(err instanceof CarrierError)) return err;
  switch (err.code) {
    case 'CARRIER_UNAVAILABLE':
      return new AppError(
        502,
        'CARRIER_UNAVAILABLE',
        'The carrier is not answering. The order is unchanged; booking is retried automatically, or try again shortly.'
      );
    case 'CARRIER_MISCONFIGURED':
      return new AppError(
        409,
        'CARRIER_MISCONFIGURED',
        'The carrier refused the saved credentials. Check them in the carrier settings.'
      );
    case 'COD_NOT_SUPPORTED':
      return new AppError(409, 'COD_NOT_SUPPORTED', err.message);
    case 'NEEDS_MAPPING':
      return new AppError(422, 'NEEDS_MAPPING', err.message);
    default:
      return new AppError(422, 'CARRIER_REJECTED', err.message);
  }
}

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
      const { carrier, manual } = shipOrderSchema.parse(req.body);

      const shipment = await shippingCarrierService.createShipmentForOrder(
        storeId,
        orderId,
        carrier,
        { manual }
      );

      res.status(201).json({ success: true, data: { shipment } });
    } catch (error) {
      next(carrierErrorToHttp(error));
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

      const { force } = cancelShipmentSchema.parse(req.body ?? {});
      const shipment = await shippingCarrierService.cancelShipment(existing.id, { force });

      res.json({ success: true, data: { shipment } });
    } catch (error) {
      next(carrierErrorToHttp(error));
    }
  }
);

// ==========================================
// GET /:storeId/orders/:orderId/shipment
// The order page's shipping card: the shipment (if any), the carriers that can be used,
// and the COD the carrier would have to collect.
// ==========================================

router.get(
  '/:storeId/orders/:orderId/shipment',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const data = await shippingCarrierService.getShipmentForOrder(storeId, orderId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/shipments/:id/label
// The printable label: a hosted URL, or the PDF as base64.
// ==========================================

router.get(
  '/:storeId/shipments/:id/label',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { prisma } = await import('@force/database');
      const existing = await prisma.shipment.findFirst({ where: { id, storeId } });
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Shipment not found' },
        });
        return;
      }
      const label = await shippingCarrierService.getLabel(id);
      res.json({ success: true, data: { label } });
    } catch (error) {
      next(carrierErrorToHttp(error));
    }
  }
);

// ==========================================
// POST /:storeId/shipments/:id/status
// Manual carrier only: the merchant moves the shipment along.
// ==========================================

router.post(
  '/:storeId/shipments/:id/status',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { status } = manualStatusSchema.parse(req.body);
      const { prisma } = await import('@force/database');
      const existing = await prisma.shipment.findFirst({ where: { id, storeId } });
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Shipment not found' },
        });
        return;
      }
      const shipment = await shippingCarrierService.manualUpdateStatus(
        id,
        status as (typeof SHIPMENT_STATUSES)[number]
      );
      res.json({ success: true, data: { shipment } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// POST /:storeId/shipping-carriers/webhook-secret/:carrier/rotate
// Replace the secret in the carrier's callback URL (the old URL stops working).
// ==========================================

router.post(
  '/:storeId/shipping-carriers/webhook-secret/:carrier/rotate',
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
      await shippingCarrierService.rotateWebhookSecret(storeId, carrier);
      res.json({ success: true, data: { message: 'Webhook secret rotated' } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// COD reconciliation
// GET  /:storeId/cod-reconciliation          shipments, matches, totals, unmatched lines
// POST /:storeId/cod-reconciliation/import   a carrier's settlement statement (CSV text)
// ==========================================

router.get(
  '/:storeId/cod-reconciliation',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const q = codReportSchema.parse(req.query);
      const report = await codReconciliationService.getReport(storeId, q);
      res.json({ success: true, data: report });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:storeId/cod-reconciliation/import',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { carrier, csv } = importSettlementSchema.parse(req.body);
      const result = await codReconciliationService.importSettlement(storeId, carrier, csv);
      res.json({ success: true, data: result });
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
      next(carrierErrorToHttp(error));
    }
  }
);

// ==========================================
// Public route: GET /stores/public/:storeId/orders/:orderId/tracking
// Returns tracking info for an order (ownership check via session/auth).
// This router is mounted ONLY at '/stores' (#1993 removed the '/public'
// dual mount, which republished every admin route above under a prefix
// csrfProtection skips); the literal '/public' segment gives the same
// '/stores/public/...' storefront shape as shipping/coupons/wallet.
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
        // a booking that failed or is in flight is the merchant's business, not the customer's
        where: { orderId, storeId, status: { notIn: ['creation_failed', 'creating'] } },
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
