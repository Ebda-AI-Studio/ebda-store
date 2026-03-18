import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { ReturnService } from '../services/return.service';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';

const router = Router({ mergeParams: true });

// Validation schemas
const createReturnSchema = z.object({
  orderId: z.string().uuid(),
  type: z.enum(['return', 'exchange', 'refund']),
  reason: z.string().min(1).max(500),
  reasonDetail: z.string().max(2000).optional(),
  customerNotes: z.string().max(2000).optional(),
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
    .min(1),
});

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

      const result = await ReturnService.getCustomerReturns(storeId, req.user!.userId, {
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

      const returnRequest = await ReturnService.create(storeId, {
        ...data,
        customerId: req.user!.userId,
      });

      // Audit log
      await auditLog({
        action: 'return.created',
        userId: req.user!.userId,
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

      // Check if customer owns this return
      if (returnRequest.customerId !== req.user!.userId && req.user!.role === 'customer') {
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
      const { notes } = req.body;

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
      const { reason } = req.body;

      if (!reason) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Rejection reason is required' },
        });
        return;
      }

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
      const { refundMethod } = req.body;

      if (!refundMethod) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Refund method is required' },
        });
        return;
      }

      const returnRequest = await ReturnService.complete(
        storeId,
        id,
        req.user!.userId,
        refundMethod
      );

      // Audit log
      await auditLog({
        action: 'return.completed',
        userId: req.user!.userId,
        resourceType: 'return',
        resourceId: id,
        details: { refundMethod },
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
      const { trackingNumber } = req.body;

      const returnRequest = await ReturnService.updateTracking(storeId, id, trackingNumber);

      res.json({
        success: true,
        data: { return: returnRequest },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
