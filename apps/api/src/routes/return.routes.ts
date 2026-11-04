import { storeDb } from '../lib/repo-factory';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, customerUserId } from '../middleware/auth';
import { requirePermission, hasPermission, type Role } from '../middleware/rbac';
import { ReturnService, REFUND_METHODS, GATEWAY_REFUND_METHODS } from '../services/return.service';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess, checkStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';

const router = Router({ mergeParams: true });

// Validation schemas
// BE:S-28: the free text of the admin actions lands in the audit log and in the customer's email, so it is bounded.
const approveBodySchema = z.object({ notes: z.string().trim().max(1000).optional() });
const rejectBodySchema = z.object({ reason: z.string().trim().min(1).max(1000) });
const trackingBodySchema = z.object({ trackingNumber: z.string().trim().min(1).max(100) });
const completeBodySchema = z.object({ refundMethod: z.string().trim().min(1).max(50) });

/** Task 8b: per RETURN ITEM id, the refund the merchant chose instead of the computed one. Strict; the service checks the range. */
const overridesSchema = z.record(
  z.string().uuid(),
  z
    .object({ amountMinor: z.number().int().min(0), reason: z.string().trim().min(3).max(300) })
    .strict()
);
/** `?overrides=` on the preview is a JSON object of the same shape (read-only what-if). */
function parseOverrides(raw: unknown) {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    return overridesSchema.parse(JSON.parse(raw));
  } catch {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'overrides must be a JSON object of { amountMinor, reason } by return item id'
    );
  }
}

const createReturnSchema = z
  .object({
    orderId: z.string().uuid(),
    type: z.enum(['return', 'exchange', 'refund']),
    reason: z.string().min(1).max(500),
    reasonDetail: z.string().max(2000).optional(),
    customerNotes: z.string().max(2000).optional(),
    // Individual (non-bundle) order lines. Now optional — a request may
    // instead (or additionally) name whole bundle boxes via
    // `bundleGroupIds` below. `.optional()` alone would accept a request
    // with neither field, so the `.refine()` at the bottom re-imposes "at
    // least one of the two" — the same requirement `.min(1)` enforced here
    // before bundles existed.
    items: z
      .array(
        z.object({
          orderItemId: z.string().uuid(),
          productId: z.string().uuid(),
          productName: z.string(),
          quantity: z.number().int().min(1),
          reason: z.string().optional(),
          condition: z.enum(['new', 'opened', 'damaged']).optional(),
        })
      )
      .optional(),
    // Bundle boxes to return as complete, atomic units — see
    // `ReturnService.create`'s `bundleGroupIds`. One id per BOX; capped at
    // 50 because a single customer return spanning 50 boxes in one
    // submission is already an anomaly worth a support conversation, not a
    // payload the endpoint should silently accept.
    bundleGroupIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  })
  .refine(
    data =>
      (data.items && data.items.length > 0) ||
      (data.bundleGroupIds && data.bundleGroupIds.length > 0),
    {
      message: 'At least one item or bundle group must be selected for return',
      path: ['items'],
    }
  );

// Customer Routes

// GET /stores/:storeId/returns - List customer returns
router.get(
  '/',
  authenticate,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, status } = req.query;
      // The shared API cookie space means this customer-facing list could
      // otherwise be hit with an admin token and return rows keyed on the
      // admin's userId (usually empty, but exposes the existence of a
      // matching userId/customer record). customerUserId() rejects
      // non-customer roles so the leak path is closed.
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }

      const result = await ReturnService.getCustomerReturns(storeId, customerId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        status: status as string,
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

// POST /stores/:storeId/returns - Create return request
router.post(
  '/',
  authenticate,
  writeLimiter,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createReturnSchema.parse(req.body);
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }

      const returnRequest = await ReturnService.create(storeId, {
        ...data,
        customerId,
      });

      // Audit log
      await auditLog({
        action: 'return.created',
        userId: customerId,
        resourceType: 'return',
        resourceId: returnRequest.id,
        details: { returnNumber: returnRequest.returnNumber, type: data.type },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(201).json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/returns/:id - Get return details
router.get(
  '/:id',
  authenticate,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const returnRequest = await ReturnService.getById(storeId, id);

      // Tenant + ownership gate. Previously the only check was "if
      // role===customer, must match customerId" — which left admins
      // with a clean bypass: a store_admin from Store A could read
      // any return on Store B by changing :storeId. Now:
      //   - customer: must own the return (customerId match)
      //   - store_admin / super_admin: must own (or be platform-staff
      //     for) the storeId in the URL
      const role = req.user!.role;
      if (role === 'customer') {
        if (returnRequest.customerId !== req.user!.userId) {
          res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Access denied' },
          });
          return;
        }
      } else if (role === 'store_admin' || role === 'super_admin') {
        const access = await checkStoreAccess(storeId, req.user!);
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

      res.json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Admin Routes

// GET /stores/:storeId/returns/admin - List all returns for store
router.get(
  '/admin/list',
  authenticate,
  requirePermission('returns:read'),
  requireStoreAccess,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, status, type } = req.query;

      const result = await ReturnService.list(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        status: status as string,
        type: type as string,
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

// GET /stores/:storeId/returns/admin/stats - Get return statistics
router.get(
  '/admin/stats',
  authenticate,
  requirePermission('returns:read'),
  requireStoreAccess,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const stats = await ReturnService.getStats(storeId);

      res.json({
        success: true,
        data: { stats },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/returns/admin/:id/approve - Approve return
router.post(
  '/admin/:id/approve',
  authenticate,
  requirePermission('returns:write'),
  requireStoreAccess,
  writeLimiter,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { notes } = approveBodySchema.parse(req.body ?? {});

      const returnRequest = await ReturnService.approve(storeId, id, req.user!.userId, notes);

      // Audit log
      await auditLog({
        action: 'return.approved',
        userId: req.user!.userId,
        resourceType: 'return',
        resourceId: id,
        details: { returnNumber: returnRequest.returnNumber },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/returns/admin/:id/reject - Reject return
router.post(
  '/admin/:id/reject',
  authenticate,
  requirePermission('returns:write'),
  requireStoreAccess,
  writeLimiter,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { reason: rawReason } = req.body ?? {};

      if (!rawReason) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Rejection reason is required' },
        });
        return;
      }

      const { reason } = rejectBodySchema.parse({ reason: rawReason });

      const returnRequest = await ReturnService.reject(storeId, id, req.user!.userId, reason);

      // Audit log
      await auditLog({
        action: 'return.rejected',
        userId: req.user!.userId,
        resourceType: 'return',
        resourceId: id,
        details: { returnNumber: returnRequest.returnNumber, reason },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/returns/admin/:id/received - Mark return as received
router.post(
  '/admin/:id/received',
  authenticate,
  requirePermission('returns:write'),
  requireStoreAccess,
  writeLimiter,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const returnRequest = await ReturnService.markReceived(storeId, id, req.user!.userId);

      // Audit log
      await auditLog({
        action: 'return.received',
        userId: req.user!.userId,
        resourceType: 'return',
        resourceId: id,
        details: { returnNumber: returnRequest.returnNumber },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/returns/admin/:id/refund-preview - What completing would refund.
// Read-only; the admin's refund-method dialog shows it before the merchant
// confirms, and hides "Original payment method" when the gateway cannot take it.
router.get(
  '/admin/:id/refund-preview',
  authenticate,
  requirePermission('returns:read'),
  requireStoreAccess,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const preview = await ReturnService.refundPreview(
        storeId,
        id,
        parseOverrides(req.query.overrides)
      );
      // Issue 2024: a caller who may complete returns but may not send money
      // back through a gateway (staff — no `orders:refund`) is shown the
      // option disabled with a reason, rather than 403'd after confirming.
      if (!hasPermission(req.user!.role as Role, 'orders:refund') && preview.gateway.available) {
        preview.gateway = {
          ...preview.gateway,
          available: false,
          unavailableReason: 'REFUND_PERMISSION_REQUIRED',
        };
      }
      res.json({ success: true, data: { preview } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/returns/admin/:id/complete - Complete return and refund
router.post(
  '/admin/:id/complete',
  authenticate,
  requirePermission('returns:write'),
  requireStoreAccess,
  writeLimiter,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { refundMethod: rawMethod } = req.body ?? {};

      if (!rawMethod) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Refund method is required' },
        });
        return;
      }

      const { refundMethod } = completeBodySchema.parse({ refundMethod: rawMethod });

      // Reject an unrecognised method instead of passing it through. The
      // service branches on a known set, and anything outside it silently took
      // the manual path — which is indistinguishable from a successful
      // completion, so the admin sending 'original' against a service matching
      // only 'gateway'/'original_payment' went unnoticed: no provider refund
      // was ever issued from this endpoint.
      if (!(REFUND_METHODS as readonly string[]).includes(refundMethod)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REFUND_METHOD',
            message: `Unknown refund method '${refundMethod}'. Expected one of: ${REFUND_METHODS.join(', ')}.`,
          },
        });
        return;
      }

      // Issue 2024: `returns:write` authorises COMPLETING a return, and staff
      // hold it; a gateway method additionally sends a real, irreversible
      // gateway refund, which is `orders:refund` — the permission
      // staff deliberately lack (rbac.ts, and the sibling order refund route).
      // Store credit / bank transfer / cash / manual record money only.
      // F-10 (2026-10-14, reversible default; Ruling S8-1): `store_credit` credits the
      // customer's spendable wallet — money — so it needs the same permission. Cash,
      // bank transfer and manual only RECORD a refund made elsewhere and stay open.
      if (
        ((GATEWAY_REFUND_METHODS as readonly string[]).includes(refundMethod) ||
          refundMethod === 'store_credit') &&
        !hasPermission(req.user!.role as Role, 'orders:refund')
      ) {
        res.status(403).json({
          success: false,
          error: {
            code: 'REFUND_PERMISSION_REQUIRED',
            message:
              'Refunding to the original payment method or as store credit requires the orders:refund permission.',
          },
        });
        return;
      }

      // B2B Task 8b: overriding a tier adjustment changes the amount paid out, so it needs the same permission as a refund.
      const refundOverrides = overridesSchema.parse(req.body?.refundOverrides ?? {});
      if (
        Object.keys(refundOverrides).length > 0 &&
        !hasPermission(req.user!.role as Role, 'orders:refund')
      ) {
        res.status(403).json({
          success: false,
          error: {
            code: 'REFUND_PERMISSION_REQUIRED',
            message: 'Overriding a refund requires the orders:refund permission.',
          },
        });
        return;
      }

      const returnRequest = await ReturnService.complete(
        storeId,
        id,
        req.user!.userId,
        refundMethod,
        refundOverrides
      );

      // Audit log
      await auditLog({
        action: 'return.completed',
        userId: req.user!.userId,
        resourceType: 'return',
        resourceId: id,
        details: {
          refundMethod,
          // Who overrode which item's refund, and why (Task 8b): the override is a money decision, so it is audit-logged.
          ...(Object.keys(refundOverrides).length > 0
            ? { refundOverrides, overriddenBy: req.user!.userId }
            : {}),
          // Ruling B2B-20: a carried tier shortfall the override waived (never re-claimed later).
          ...(returnRequest.tierCarryWaived > 0
            ? { tierCarryWaived: returnRequest.tierCarryWaived }
            : {}),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/returns/admin/:id/tracking - Update tracking number
router.put(
  '/admin/:id/tracking',
  authenticate,
  requirePermission('returns:write'),
  requireStoreAccess,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { trackingNumber } = trackingBodySchema.parse(req.body ?? {});

      const returnRequest = await ReturnService.updateTracking(storeId, id, trackingNumber);

      await auditLog({
        action: 'return.tracking_updated',
        userId: req.user!.userId,
        storeId,
        resourceType: 'return',
        resourceId: id,
        details: { trackingNumber },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /stores/:storeId/returns/admin/:id/timeline
// Read-only lifecycle history for a single return.
// Reads from audit_logs (actions: return.*) — append-only since return
// transitions are recorded there at every state-change site.
// ==========================================

router.get(
  '/admin/:id/timeline',
  authenticate,
  requirePermission('returns:read'),
  requireStoreAccess,
  requireFeature('returns'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id: returnId } = req.params;

      // Verify the return belongs to this store before exposing audit rows.
      const returnRecord = await (
        await storeDb(storeId)
      ).return.findFirst({
        where: { id: returnId, storeId },
        select: { id: true, returnNumber: true, status: true, createdAt: true },
      });

      if (!returnRecord) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Return not found' },
        });
        return;
      }

      // Audit rows keyed by resourceId=returnId, scoped to the store (the tenant
      // guard refuses an OR over storeId; store-less legacy rows are not visible
      // to a store scope under strict RLS anyway).
      const auditRows = await prisma.auditLog.findMany({
        where: {
          resourceType: 'return',
          resourceId: returnId,
          storeId,
        },
        include: { user: { select: { firstName: true, lastName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      const timeline = auditRows.map(row => {
        const details = row.details as Record<string, unknown>;
        return {
          id: row.id,
          at: row.createdAt.toISOString(),
          action: row.action,
          details: {
            returnNumber: details?.returnNumber != null ? String(details.returnNumber) : null,
            reason: details?.reason != null ? String(details.reason) : null,
            refundMethod: details?.refundMethod != null ? String(details.refundMethod) : null,
            trackingNumber: details?.trackingNumber != null ? String(details.trackingNumber) : null,
            notes: details?.notes != null ? String(details.notes) : null,
          },
          actorName: row.user
            ? `${row.user.firstName ?? ''} ${row.user.lastName ?? ''}`.trim()
            : null,
          actorRole: row.user?.role ?? null,
        };
      });

      res.json({ success: true, data: { timeline, returnNumber: returnRecord.returnNumber } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
