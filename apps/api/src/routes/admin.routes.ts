import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { ProvisioningService } from '../services/provisioning.service';
import { auditLog } from '../middleware/security';
import { prisma, Prisma } from '@force/database';

const router = Router();

// All admin routes require super_admin role
router.use(authenticate);
router.use(requireRole('super_admin'));

// Validation schemas
const provisionStoreSchema = z.object({
  storeName: z.string().min(1).max(100),
  storeSlug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
  domain: z.string().optional(),
  plan: z.enum(['free', 'starter', 'professional', 'enterprise']).optional(),
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1),
  ownerPassword: z.string().min(8).optional(),
  settings: z.object({
    theme: z.string().optional(),
    currency: z.string().optional(),
    timezone: z.string().optional(),
  }).optional(),
});

/**
 * POST /admin/stores
 * Provision a new store
 */
router.post('/stores', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = provisionStoreSchema.parse(req.body);

    const result = await ProvisioningService.provisionStore(input);

    await auditLog({
      action: 'store.provisioned',
      userId: req.user!.userId,
      resourceType: 'store',
      resourceId: result.store.id,
      details: {
        storeName: result.store.name,
        ownerEmail: result.owner.email,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/stores
 * List all stores
 */
router.get('/stores', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, status, search } = req.query;

    const result = await ProvisioningService.listStores({
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      status: status as string,
      search: search as string,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/stores/:id
 * Get store details with stats
 */
router.get('/stores/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const store = await prisma.store.findUnique({
      where: { id },
      include: {
        owner: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    if (!store) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Store not found' },
      });
      return;
    }

    const stats = await ProvisioningService.getStoreStats(id);

    res.json({
      success: true,
      data: { store, stats },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /admin/stores/:id/status
 * Update store status
 */
router.patch('/stores/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Invalid status' },
      });
      return;
    }

    const store = await ProvisioningService.updateStoreStatus(id, status);

    await auditLog({
      action: 'store.status.updated',
      userId: req.user!.userId,
      resourceType: 'store',
      resourceId: id,
      details: { newStatus: status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: { store },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /admin/stores/:id
 * Update store details
 */
router.put('/stores/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, slug, plan, status } = req.body;

    const store = await prisma.store.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(slug && { slug }),
        ...(plan && { plan }),
        ...(status && { status }),
      },
      include: {
        owner: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    await auditLog({
      action: 'store.updated',
      userId: req.user!.userId,
      resourceType: 'store',
      resourceId: id,
      details: { name, slug, plan, status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: { store },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/users
 * List all users
 */
router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '10', role, search } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const where: Prisma.UserWhereInput = {};
    if (role && role !== 'all') where.role = role as string;
    if (search) {
      where.OR = [
        { email: { contains: search as string, mode: 'insensitive' } },
        { firstName: { contains: search as string, mode: 'insensitive' } },
        { lastName: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: parseInt(limit as string),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          stores: {
            select: { id: true, name: true },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total,
          totalPages: Math.ceil(total / parseInt(limit as string)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/dashboard
 * Get platform-wide dashboard stats
 */
router.get('/dashboard', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      storeCount,
      userCount,
      orderCount,
      revenueResult,
      recentStores,
      recentOrders,
    ] = await Promise.all([
      prisma.store.count(),
      prisma.user.count(),
      prisma.order.count(),
      prisma.order.aggregate({
        where: { paymentStatus: 'paid' },
        _sum: { total: true },
      }),
      prisma.store.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: { select: { email: true } },
        },
      }),
      prisma.order.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { email: true, firstName: true, lastName: true } },
          store: { select: { name: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        stats: {
          stores: storeCount,
          users: userCount,
          orders: orderCount,
          revenue: revenueResult._sum.total || 0,
        },
        recentStores,
        recentOrders,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/products
 * List all products across all stores
 */
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '10', storeId, status, search } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const where: Prisma.ProductWhereInput = {};
    if (storeId) where.storeId = storeId as string;
    if (status) where.status = status as string;
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { sku: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: parseInt(limit as string),
        orderBy: { createdAt: 'desc' },
        include: {
          store: { select: { id: true, name: true } },
          images: { take: 1 },
        },
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        products,
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total,
          totalPages: Math.ceil(total / parseInt(limit as string)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/orders
 * List all orders across all stores
 */
router.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '10', storeId, status, paymentStatus } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const where: Prisma.OrderWhereInput = {};
    if (storeId) where.storeId = storeId as string;
    if (status) where.status = status as string;
    if (paymentStatus) where.paymentStatus = paymentStatus as string;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: parseInt(limit as string),
        orderBy: { createdAt: 'desc' },
        include: {
          store: { select: { id: true, name: true } },
          customer: { select: { id: true, email: true, firstName: true, lastName: true } },
          items: { take: 3 },
        },
      }),
      prisma.order.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total,
          totalPages: Math.ceil(total / parseInt(limit as string)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/customers
 * List all customers across all stores
 */
router.get('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '10', storeId, search } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const where: Prisma.CustomerWhereInput = {};
    if (storeId) where.storeId = storeId as string;
    if (search) {
      where.OR = [
        { email: { contains: search as string, mode: 'insensitive' } },
        { firstName: { contains: search as string, mode: 'insensitive' } },
        { lastName: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip,
        take: parseInt(limit as string),
        orderBy: { createdAt: 'desc' },
        include: {
          store: { select: { id: true, name: true } },
        },
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        customers,
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total,
          totalPages: Math.ceil(total / parseInt(limit as string)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/audit-logs
 * Get audit logs
 */
router.get('/audit-logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '50', action, userId, resourceType } = req.query;

    const where: Prisma.AuditLogWhereInput = {};
    if (action) where.action = { contains: action as string };
    if (userId) where.userId = userId as string;
    if (resourceType) where.resourceType = resourceType as string;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: parseInt(limit as string),
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        logs,
        meta: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total,
          totalPages: Math.ceil(total / parseInt(limit as string)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
