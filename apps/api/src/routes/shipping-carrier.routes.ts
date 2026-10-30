import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { storeDb, storeRepo } from '../lib/repo-factory';
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
import {
  cancelPickup,
  getPickupState,
  listPickupWindows,
  requestPickup,
} from '../services/shipment-pickup.service';
import { assertMayConfigureCarrier } from '../services/carriers/carrier-connection.service';
import { auditLog } from '../middleware/security';
import { AppError } from '../middleware/error-handler';

const router = Router();

// Mounted at the bare `/stores` prefix, which never sees `:storeId`: the store scope is
// registered here, per request (reads one transaction, carrier calls and writes store scope).
router.param('storeId', (req, res, next) => shippingCarrierRouteContext(req, res, next));

// ==========================================
// Validation schemas
// ==========================================

/**
 * Saving a carrier: credential FIELDS of one mode (write-only; the catalog is the authority on
 * which keys exist, which are required and their format, checked in the service), optional
 * activation of that mode, the enable/default switches and the non-secret settings (pickup
 * address, default weight, COD switch...).
 *
 * No credential is a URL: every adapter resolves its host from code (sandbox or live) or an
 * ENV override, never from merchant input, so a merchant cannot point the API host at an
 * internal address (SSRF). `settings` is a plain object and may not carry `sandbox` (the mode
 * is the row's `testMode`; the service drops the key).
 */
export const carrierConfigSchema = z.object({
  mode: z.enum(['sandbox', 'live']).optional(),
  credentials: z.record(z.string(), z.union([z.string().max(2000), z.null()])).optional(),
  activate: z.boolean().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
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
// PROVIDERS-18. Times are Africa/Cairo wall clock; the service checks them against what the
// shipment's carrier accepts (date only, a from/to window, or one of its own slots).
const requestPickupSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  window: z
    .object({
      from: z.string().regex(/^\d{2}:\d{2}$/),
      to: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .optional(),
  windowId: z.string().trim().min(1).max(40).optional(),
  windowLabel: z.string().trim().max(100).optional(),
  // One per dialog submit: a double click or a retried request is the SAME pickup.
  idempotencyKey: z.string().trim().min(8).max(100),
});
const manualStatusSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES as [string, ...string[]]),
  /** Return to origin only: put the items back in stock (default true). */
  restock: z.boolean().optional(),
});
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
// List all carrier configs for a store (write-only credentials: hints only)
// ==========================================

router.get(
  '/:storeId/shipping-carriers/configs',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const configs = await shippingCarrierService.getPublicCarrierConfigs(storeId);
      res.json({ success: true, data: { configs } });
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

      const configs = await shippingCarrierService.getPublicCarrierConfigs(storeId);
      res.json({
        success: true,
        data: { config: configs.find(c => c.carrier === carrier) ?? null },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// PUT /:storeId/shipping-carriers/configs/:carrier
// Save credentials (write-only) / switch mode / enable / settings for one carrier
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
      assertMayConfigureCarrier(carrier, req.user?.role ?? '');

      const body = carrierConfigSchema.parse(req.body);
      if ((body.credentials || body.activate) && !body.mode) {
        throw new AppError(422, 'MODE_REQUIRED', 'Say which mode (sandbox or live) these are for');
      }
      const result = await shippingCarrierService.upsertCarrierConfig(storeId, carrier, {
        credentials: body.credentials
          ? { mode: body.mode!, fields: body.credentials }
          : body.activate && body.mode
            ? { mode: body.mode, fields: {} }
            : undefined,
        activate: body.activate,
        enabled: body.enabled,
        isDefault: body.isDefault,
        settings: body.settings,
      });

      // Names of the fields that changed, never their values.
      await auditLog({
        action: 'shipping_carrier_config.updated',
        storeId,
        userId: req.user?.userId,
        resourceType: 'shipping_carrier_config',
        resourceId: String(result.config.id),
        details: {
          storeId,
          carrier,
          mode: body.mode,
          fields: result.changed,
          enabled: result.config.enabled,
          disabledUntilRetested: result.disabledUntilRetested,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // PROVIDERS-3: SANDBOX-FIRST automatic check of the credentials just saved (the saved mode),
      // the carrier's one read-only call. Never a shipment. A failed check does not undo the save.
      let check = null;
      if (result.changed.length > 0 && body.mode) {
        const tested = await shippingCarrierService.testConnection(
          storeId,
          carrier,
          body.mode,
          (body.mode === 'sandbox') === result.config.testMode
        );
        check = tested.check;
        await auditLog({
          action: 'shipping_carrier_config.connection_tested',
          storeId,
          userId: req.user?.userId,
          resourceType: 'shipping_carrier_config',
          resourceId: String(result.config.id),
          details: {
            storeId,
            carrier,
            mode: tested.mode,
            ok: tested.test.ok,
            code: tested.test.code,
            auto: true,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }

      res.json({ success: true, data: { ...result, check } });
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
      await auditLog({
        action: 'shipping_carrier_config.deleted',
        storeId,
        userId: req.user?.userId,
        resourceType: 'shipping_carrier_config',
        resourceId: carrier,
        details: { storeId, carrier },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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

      assertMayConfigureCarrier(carrier, req.user?.role ?? '');
      const result = await shippingCarrierService.testConnection(storeId, carrier);
      await auditLog({
        action: 'shipping_carrier_config.connection_tested',
        storeId,
        userId: req.user?.userId,
        resourceType: 'shipping_carrier_config',
        resourceId: carrier,
        details: {
          storeId,
          carrier,
          mode: result.mode,
          ok: result.test.ok,
          code: result.test.code,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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
      await auditLog({
        action: 'shipping_carrier_config.default_set',
        storeId,
        userId: req.user?.userId,
        resourceType: 'shipping_carrier_config',
        resourceId: carrier,
        details: { storeId, carrier },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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
      const { prisma } = await import('@ebda/database');
      const existing = await (
        await storeDb(storeId)
      ).shipment.findFirst({ where: { orderId, storeId } });

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
      const { prisma } = await import('@ebda/database');
      const existing = await (
        await storeDb(storeId)
      ).shipment.findFirst({ where: { id, storeId } });
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
// Courier pickups (PROVIDERS-18)
//   GET  /:storeId/shipments/:id/pickup                       the panel state + history
//   GET  /:storeId/shipments/:id/pickup/windows               the carrier's own slots (Mylerz)
//   POST /:storeId/shipments/:id/pickup                       request (idempotent)
//   POST /:storeId/shipments/:id/pickup/:pickupId/cancel      cancel at the carrier
// ==========================================

router.get(
  '/:storeId/shipments/:id/pickup',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getPickupState(req.params.storeId, req.params.id);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:storeId/shipments/:id/pickup/windows',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const windows = await listPickupWindows(req.params.storeId, req.params.id);
      res.json({ success: true, data: { windows } });
    } catch (error) {
      next(carrierErrorToHttp(error));
    }
  }
);

router.post(
  '/:storeId/shipments/:id/pickup',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = requestPickupSchema.parse(req.body ?? {});
      const { pickup, created } = await requestPickup(req.params.storeId, req.params.id, input, {
        userId: req.user?.userId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(created ? 201 : 200).json({ success: true, data: { pickup, created } });
    } catch (error) {
      next(carrierErrorToHttp(error));
    }
  }
);

router.post(
  '/:storeId/shipments/:id/pickup/:pickupId/cancel',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pickup = await cancelPickup(req.params.storeId, req.params.id, req.params.pickupId, {
        userId: req.user?.userId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { pickup } });
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
      const { status, restock } = manualStatusSchema.parse(req.body);
      const { prisma } = await import('@ebda/database');
      const existing = await (
        await storeDb(storeId)
      ).shipment.findFirst({ where: { id, storeId } });
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Shipment not found' },
        });
        return;
      }
      const shipment = await shippingCarrierService.manualUpdateStatus(
        id,
        status as (typeof SHIPMENT_STATUSES)[number],
        { restock }
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
      await auditLog({
        action: 'shipping_carrier_config.webhook_secret_rotated',
        storeId,
        userId: req.user?.userId,
        resourceType: 'shipping_carrier_config',
        resourceId: carrier,
        details: { storeId, carrier },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
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
      const { prisma } = await import('@ebda/database');

      // A DO store cannot join the platform `customer` (a User): the order's customerId is read and the customer attached
      // from Postgres, so the response has the same shape on either backend (Ruling CF-R6B-1).
      const onDo = (await storeRepo(storeId)).backend === 'do';
      const customerSelect = { email: true, firstName: true, lastName: true } as const;
      const shipment = await (
        await storeDb(storeId)
      ).shipment.findFirst({
        where: { id, storeId },
        include: {
          order: {
            select: {
              orderNumber: true,
              status: true,
              total: true,
              ...(onDo ? { customerId: true } : { customer: { select: customerSelect } }),
            },
          },
        },
      });
      if (shipment && onDo) {
        const o = shipment.order as unknown as Record<string, unknown> | null;
        const customerId = o?.customerId as string | null | undefined;
        if (o) {
          o.customer = customerId
            ? await prisma.user.findFirst({ where: { id: customerId }, select: customerSelect })
            : null;
          delete o.customerId;
        }
      }

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
      const { prisma } = await import('@ebda/database');
      const existing = await (
        await storeDb(storeId)
      ).shipment.findFirst({ where: { id, storeId } });

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

      const { prisma } = await import('@ebda/database');

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

      const shipment = await (
        await storeDb(storeId)
      ).shipment.findFirst({
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

export default router;
