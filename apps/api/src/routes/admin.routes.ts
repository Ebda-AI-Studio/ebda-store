import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { ProvisioningService } from '../services/provisioning.service';
import { auditLog } from '../middleware/security';
import {
  prisma,
  Prisma,
  UserRole,
  ProductStatus,
  OrderStatus,
  OrderPaymentStatus,
} from '@force/database';

const router = Router();

// Admin routes are authenticated. The default authorization is super_admin
// (enforced via `requireRole('super_admin')` on every write/management
// route), but a few read endpoints — list-stores, dashboard, and the
// per-store fetch — are also available to store_admins so the same admin
// frontend can serve a tenant. Those routes apply ownership filtering at
// the service layer (see ownerId scoping below).
router.use(authenticate);

// Helper: enforce ownership when a store_admin is the caller. Super admins
// pass through unscoped. Returns the userId to filter by, or undefined
// when no scoping is needed.
function ownerScopeForReq(req: Request): string | undefined {
  if (req.user?.role === 'super_admin') return undefined;
  return req.user?.userId;
}

// Pagination helper to bound inputs
function parsePagination(page?: string | unknown, limit?: string | unknown) {
  const p = Math.max(1, parseInt(String(page || '1')) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit || '10')) || 10));
  return { page: p, limit: l, skip: (p - 1) * l };
}

// Validation schemas
const updateStoreAdminSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(100)
    .optional(),
  plan: z.enum(['free', 'starter', 'professional', 'enterprise']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

const provisionStoreSchema = z.object({
  storeName: z.string().min(1).max(100),
  storeSlug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  domain: z.string().optional(),
  plan: z.enum(['free', 'starter', 'professional', 'enterprise']).optional(),
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1),
  ownerPassword: z.string().min(8).optional(),
  settings: z
    .object({
      theme: z.string().optional(),
      currency: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
});

/**
 * POST /admin/stores
 * Provision a new store
 */
router.post(
  '/stores',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
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
  }
);

/**
 * GET /admin/stores
 * List all stores
 */
router.get(
  '/stores',
  requireRole(['super_admin', 'store_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, status, search } = req.query;
      const { page, limit } = parsePagination(pageStr, limitStr);

      const result = await ProvisioningService.listStores({
        page,
        limit,
        status: status as string,
        search: search as string,
        // Store admins see only their own stores; super admins see everything.
        ownerId: ownerScopeForReq(req),
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

/**
 * GET /admin/stores/:id
 * Get store details with stats. Store admins can view their own stores;
 * super admins can view any store.
 */
router.get(
  '/stores/:id',
  requireRole(['super_admin', 'store_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
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

      // Store admins can only view stores they own.
      const ownerScope = ownerScopeForReq(req);
      if (ownerScope && store.ownerId !== ownerScope) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Not authorized to view this store' },
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
  }
);

/**
 * PATCH /admin/stores/:id/status
 * Update store status
 */
router.patch(
  '/stores/:id/status',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
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
  }
);

/**
 * PUT /admin/stores/:id
 * Update store details
 */
router.put(
  '/stores/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { name, slug, plan, status } = updateStoreAdminSchema.parse(req.body);

      const store = await prisma.store.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(slug !== undefined && { slug }),
          ...(plan !== undefined && { plan }),
          ...(status !== undefined && { status }),
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
        details: {
          ...(name !== undefined && { name }),
          ...(slug !== undefined && { slug }),
          ...(plan !== undefined && { plan }),
          ...(status !== undefined && { status }),
        },
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
  }
);

/**
 * GET /admin/users
 * List all users
 */
router.get(
  '/users',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, role, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.UserWhereInput = {};
      if (role && role !== 'all') where.role = role as UserRole;
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
          take: limit,
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
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/users/:id
 * Get a single user by ID
 */
router.get(
  '/users/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const user = await prisma.user.findUnique({
        where: { id },
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
            select: { id: true, name: true, slug: true },
          },
        },
      });

      if (!user) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/users/:id
 * Update a user's role and status
 */
router.put(
  '/users/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        role: z.enum(['super_admin', 'store_admin', 'customer']).optional(),
        status: z.enum(['active', 'inactive', 'suspended']).optional(),
      });
      const data = schema.parse(req.body);

      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      const user = await prisma.user.update({
        where: { id },
        data: {
          role: data.role as UserRole | undefined,
          status: data.status as 'active' | 'inactive' | 'suspended' | undefined,
        },
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
            select: { id: true, name: true, slug: true },
          },
        },
      });

      await auditLog({
        action: 'user.updated',
        userId: req.user!.userId,
        resourceType: 'user',
        resourceId: id,
        details: { changedFields: Object.keys(data).join(', ') },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/dashboard
 * Get platform-wide dashboard stats
 */
router.get(
  '/dashboard',
  requireRole(['super_admin', 'store_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Store admins see only stats for the stores they own. Super admins
      // get the platform-wide aggregate.
      const ownerScope = ownerScopeForReq(req);
      const storeFilter: Prisma.StoreWhereInput = ownerScope ? { ownerId: ownerScope } : {};
      const orderFilter: Prisma.OrderWhereInput = ownerScope
        ? { store: { ownerId: ownerScope } }
        : {};

      const [storeCount, userCount, orderCount, revenueResult, recentStores, recentOrders] =
        await Promise.all([
          prisma.store.count({ where: storeFilter }),
          // User count is platform-wide and only meaningful for super admins.
          // Store admins don't have access to the cross-tenant user table —
          // return 0 so the dashboard widget renders without leaking data.
          ownerScope ? Promise.resolve(0) : prisma.user.count(),
          prisma.order.count({ where: orderFilter }),
          prisma.order.aggregate({
            where: { ...orderFilter, paymentStatus: 'paid' },
            _sum: { total: true },
          }),
          prisma.store.findMany({
            where: storeFilter,
            take: 5,
            orderBy: { createdAt: 'desc' },
            include: {
              owner: { select: { email: true } },
            },
          }),
          prisma.order.findMany({
            where: orderFilter,
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
  }
);

/**
 * GET /admin/products
 * List all products across all stores
 */
router.get(
  '/products',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, storeId, status, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.ProductWhereInput = {};
      if (storeId) where.storeId = storeId as string;
      if (status) where.status = status as ProductStatus;
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
          take: limit,
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
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/products/:id
 * Get a single product by ID across all stores
 */
router.get(
  '/products/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const product = await prisma.product.findUnique({
        where: { id },
        include: {
          store: { select: { id: true, name: true, slug: true } },
          images: { orderBy: { position: 'asc' } },
          categories: {
            include: { category: { select: { id: true, name: true } } },
          },
          variants: {
            include: {
              options: {
                include: {
                  value: {
                    include: { option: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!product) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Product not found' },
        });
        return;
      }

      // Transform categories to flat array
      const transformedProduct = {
        ...product,
        categories: product.categories.map(pc => pc.category),
      };

      res.json({
        success: true,
        data: { product: transformedProduct },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/orders
 * List all orders across all stores
 */
router.get(
  '/orders',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, storeId, status, paymentStatus } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.OrderWhereInput = {};
      if (storeId) where.storeId = storeId as string;
      if (status) where.status = status as OrderStatus;
      if (paymentStatus) where.paymentStatus = paymentStatus as OrderPaymentStatus;

      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          skip,
          take: limit,
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
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/customers
 * List all customers across all stores
 */
router.get(
  '/customers',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, storeId, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

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
          take: limit,
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
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/audit-logs
 * Get audit logs
 */
router.get(
  '/audit-logs',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, action, userId, resourceType } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.AuditLogWhereInput = {};
      if (action) where.action = { contains: action as string };
      if (userId) where.userId = userId as string;
      if (resourceType) where.resourceType = resourceType as string;

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          skip,
          take: limit,
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
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
