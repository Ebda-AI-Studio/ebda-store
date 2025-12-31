import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { OrderService } from '../services/order.service';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';

const router = Router({ mergeParams: true });

// Validation schemas
const addressSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  company: z.string().optional(),
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().min(2).max(2),
  phone: z.string().optional(),
});

const createOrderSchema = z.object({
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  paymentMethod: z.string(),
  notes: z.string().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum([
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
  ]),
});

// Helper to get session ID
const getSessionId = (req: Request): string => {
  return (req.headers['x-session-id'] as string) || 'anonymous';
};

// GET /stores/:storeId/orders - List orders
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { page, limit, status } = req.query;

    // Check if admin or getting own orders
    const isAdmin = req.user?.role === 'store_admin' || req.user?.role === 'super_admin';

    const result = await OrderService.list(storeId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      status: status as string,
      customerId: isAdmin ? undefined : req.user?.userId,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:storeId/orders/:id - Get order
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, id } = req.params;

    const order = await OrderService.getById(storeId, id);

    // Check authorization
    const isAdmin = req.user?.role === 'store_admin' || req.user?.role === 'super_admin';
    if (!isAdmin && order.customerId !== req.user?.userId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to view this order' },
      });
      return;
    }

    res.json({
      success: true,
      data: { order },
    });
  } catch (error) {
    next(error);
  }
});

// POST /stores/:storeId/orders - Create order (checkout)
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const sessionId = getSessionId(req);
    const data = createOrderSchema.parse(req.body);

    const order = await OrderService.create(storeId, req.user!.userId, sessionId, data);

    res.status(201).json({
      success: true,
      data: { order },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /stores/:storeId/orders/:id/status - Update order status
router.put(
  '/:id/status',
  authenticate,
  requirePermission('orders:manage'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { status } = updateStatusSchema.parse(req.body);

      const previousOrder = await OrderService.getById(storeId, id);
      const order = await OrderService.updateStatus(storeId, id, status);

      // Audit log
      await auditLog({
        action: 'order.status.updated',
        userId: req.user!.userId,
        resourceType: 'order',
        resourceId: id,
        details: { previousStatus: previousOrder.status, newStatus: status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/orders/my - Get customer's own orders
router.get('/my/list', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;

    const orders = await OrderService.getCustomerOrders(storeId, req.user!.userId);

    res.json({
      success: true,
      data: { orders },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
