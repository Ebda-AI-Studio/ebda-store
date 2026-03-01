import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ProductService } from '../services/product.service';
import { CartService } from '../services/cart.service';
import { OrderService } from '../services/order.service';
import { InvoiceService } from '../services/invoice.service';
import { EmailService } from '../services/email.service';
import { prisma } from '@force/database';
import { authenticate } from '../middleware/auth';
import {
  publicLimiter,
  storeResolveLimiter,
  cartLimiter,
  writeLimiter,
} from '../middleware/security';
import { getDefaultStoreId } from '../utils/store-helpers';

const router = Router();

// Apply public rate limiter to all routes
router.use(publicLimiter);

// GET /health - Health check endpoint
router.get('/health', async (_req: Request, res: Response) => {
  try {
    // Test database connection
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        database: 'connected',
      },
    });
  } catch {
    res.status(503).json({
      success: false,
      data: {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
      },
    });
  }
});

// ==========================================
// Validation Schemas
// ==========================================

const addCartItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).default(1),
  variantId: z.string().uuid().optional(),
});

const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1),
});

const shippingAddressSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().min(1),
});

const createOrderSchema = z.object({
  shippingAddress: shippingAddressSchema,
  billingAddress: shippingAddressSchema.optional(),
  paymentMethod: z.string().min(1),
  notes: z.string().optional(),
});

// GET /products - List all public products
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, category, search, featured } = req.query;
    const storeId = await getDefaultStoreId();

    const result = await ProductService.listPublic(storeId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      category: category as string,
      search: search as string,
      featured: featured === 'true',
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /products/:slugOrId - Get a product by slug or ID
router.get('/products/:slugOrId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slugOrId } = req.params;

    // Check if it's a UUID (ID) or slug
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);

    const storeId = await getDefaultStoreId();
    const product = isUuid
      ? await ProductService.getPublicById(storeId, slugOrId)
      : await ProductService.getPublicBySlug(storeId, slugOrId);

    res.json({
      success: true,
      data: { product },
    });
  } catch (error) {
    next(error);
  }
});

// GET /categories - List all categories
router.get('/categories', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = await getDefaultStoreId();
    const categories = await ProductService.getCategories(storeId);

    res.json({
      success: true,
      data: { categories },
    });
  } catch (error) {
    next(error);
  }
});

// Cart endpoints (using default store)
// GET /cart - Get current cart
router.get('/cart', cartLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_SESSION', message: 'Session ID required' },
      });
      return;
    }

    const storeId = await getDefaultStoreId();
    const cart = await CartService.getOrCreate(storeId, sessionId);

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// POST /cart/items - Add item to cart
router.post('/cart/items', cartLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_SESSION', message: 'Session ID required' },
      });
      return;
    }

    const { productId, quantity } = addCartItemSchema.parse(req.body);
    const storeId = await getDefaultStoreId();
    const cart = await CartService.addItem(storeId, sessionId, productId, quantity);

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /cart/items/:itemId - Update cart item
router.put(
  '/cart/items/:itemId',
  cartLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.headers['x-session-id'] as string;
      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_SESSION', message: 'Session ID required' },
        });
        return;
      }

      const { itemId } = req.params;
      const { quantity } = updateCartItemSchema.parse(req.body);
      const storeId = await getDefaultStoreId();
      const cart = await CartService.updateItem(storeId, sessionId, itemId, quantity);

      res.json({
        success: true,
        data: { cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /cart/items/:itemId - Remove item from cart
router.delete(
  '/cart/items/:itemId',
  cartLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.headers['x-session-id'] as string;
      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_SESSION', message: 'Session ID required' },
        });
        return;
      }

      const { itemId } = req.params;
      const storeId = await getDefaultStoreId();
      const cart = await CartService.removeItem(storeId, sessionId, itemId);

      res.json({
        success: true,
        data: { cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /cart - Clear cart
router.delete('/cart', cartLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_SESSION', message: 'Session ID required' },
      });
      return;
    }

    const storeId = await getDefaultStoreId();
    const cart = await CartService.clear(storeId, sessionId);

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// Order endpoints
// POST /orders - Create order (requires auth)
router.post(
  '/orders',
  authenticate,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.headers['x-session-id'] as string;
      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_SESSION', message: 'Session ID required' },
        });
        return;
      }

      const storeId = await getDefaultStoreId();
      const orderData = createOrderSchema.parse(req.body);
      const order = await OrderService.create(storeId, req.user!.userId, sessionId, orderData);

      res.status(201).json({
        success: true,
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /orders - Get user's orders (requires auth)
router.get('/orders', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = await getDefaultStoreId();
    const orders = await OrderService.getCustomerOrders(storeId, req.user!.userId);

    res.json({
      success: true,
      data: { orders },
    });
  } catch (error) {
    next(error);
  }
});

// GET /orders/:id - Get order by ID (requires auth)
router.get('/orders/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const storeId = await getDefaultStoreId();
    const order = await OrderService.getById(storeId, id);

    // Ensure user owns this order
    if (order.customerId !== req.user!.userId) {
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

// GET /orders/:id/invoice - Get invoice for customer's own order (requires auth)
router.get(
  '/orders/:id/invoice',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const storeId = await getDefaultStoreId();
      const order = await OrderService.getById(storeId, id);

      // Ensure user owns this order
      if (order.customerId !== req.user!.userId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Not authorized to view this invoice' },
        });
        return;
      }

      const html = await InvoiceService.generateInvoice(storeId, id);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores - List all public stores
router.get('/stores', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '10' } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const [stores, total] = await Promise.all([
      prisma.store.findMany({
        where: {
          status: 'active',
        },
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          settings: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.store.count({
        where: {
          status: 'active',
        },
      }),
    ]);

    res.json({
      success: true,
      data: stores,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:slugOrId - Get store by slug or ID (public)
router.get('/stores/:slugOrId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slugOrId } = req.params;

    // Check if it's a UUID (ID) or slug
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);

    const store = await prisma.store.findFirst({
      where: {
        ...(isUuid ? { id: slugOrId } : { slug: slugOrId }),
        status: 'active',
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        slug: true,
        domain: true,
        logo: true,
        logoAr: true,
        favicon: true,
        description: true,
        descriptionAr: true,
        template: true,
        theme: true,
        socialLinks: true,
        email: true,
        phone: true,
        phoneAr: true,
        whatsapp: true,
        address: true,
        addressAr: true,
        announcementBar: true,
        metaTitle: true,
        metaTitleAr: true,
        metaDescription: true,
        metaDescriptionAr: true,
        settings: true,
        marketingPixels: true,
        createdAt: true,
      },
    });

    if (!store) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Store not found' },
      });
      return;
    }

    res.json({
      success: true,
      data: { store },
    });
  } catch (error) {
    next(error);
  }
});

// GET /store - Get default store info
router.get('/store', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await prisma.store.findFirst({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        settings: true,
      },
    });

    if (!store) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Store not found' },
      });
      return;
    }

    res.json({
      success: true,
      data: { store },
    });
  } catch (error) {
    next(error);
  }
});

// GET /store/resolve - Resolve store by domain header (for multi-tenant)
router.get(
  '/store/resolve',
  storeResolveLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const domain = req.headers['x-store-domain'] as string;

      if (!domain) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_DOMAIN', message: 'x-store-domain header is required' },
        });
        return;
      }

      // Find store by domain
      const store = await prisma.store.findFirst({
        where: {
          domain,
          status: 'active',
        },
        select: {
          id: true,
          name: true,
          nameAr: true,
          slug: true,
          domain: true,
          logo: true,
          logoAr: true,
          favicon: true,
          template: true,
          theme: true,
          socialLinks: true,
          email: true,
          phone: true,
          phoneAr: true,
          whatsapp: true,
          address: true,
          addressAr: true,
          announcementBar: true,
          metaTitle: true,
          metaTitleAr: true,
          metaDescription: true,
          metaDescriptionAr: true,
          settings: true,
          marketingPixels: true,
        },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'STORE_NOT_FOUND', message: 'No store found for the specified domain' },
        });
        return;
      }

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /contact - Submit contact form
router.post('/contact', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contactSchema = z.object({
      name: z.string().min(1, 'Name is required').max(100),
      email: z.string().email('Invalid email address'),
      subject: z.string().min(1, 'Subject is required').max(200),
      message: z.string().min(1, 'Message is required').max(5000),
    });

    const data = contactSchema.parse(req.body);

    // Send notification email to admin
    await EmailService.sendContactForm({
      name: data.name,
      email: data.email,
      subject: data.subject,
      message: data.message,
    });

    res.json({
      success: true,
      data: { message: 'Message sent successfully' },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
