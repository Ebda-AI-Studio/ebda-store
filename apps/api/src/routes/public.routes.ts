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
import { getStoreIdFromRequest } from '../utils/store-helpers';
import { redis } from '../services/redis.service';
import { BoundedMap } from '../lib/bounded-map';
import logger from '../lib/logger';
import { featureService } from '../services/feature.service';

const router = Router();

// ==========================================
// Cache-aside helper (uses Redis with in-memory fallback)
// ==========================================

// Bounded to 1000 keys so a long-running process never grows the Map
// without limit when Redis is unavailable. The cache is a best-effort
// fallback for Redis, so random eviction is acceptable.
const memoryCache = new BoundedMap<string, { data: unknown; expiresAt: number }>(1000);

async function getCached<T>(key: string, ttl: number, fetchFn: () => Promise<T>): Promise<T> {
  // Try Redis first
  try {
    const cached = await redis.get<string>(key);
    if (cached) {
      return typeof cached === 'string' ? JSON.parse(cached) : (cached as T);
    }
  } catch {
    // Redis unavailable, fall through to memory cache
  }

  // Try in-memory cache
  const memEntry = memoryCache.get(key);
  if (memEntry && memEntry.expiresAt > Date.now()) {
    return memEntry.data as T;
  }

  // Fetch fresh data
  const data = await fetchFn();

  // Write to Redis (best-effort)
  try {
    await redis.set(key, JSON.stringify(data), ttl);
  } catch {
    // Redis unavailable, use memory cache as fallback
  }

  // Always write to memory cache as fallback
  memoryCache.set(key, { data, expiresAt: Date.now() + ttl * 1000 });

  return data;
}

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
  postalCode: z.string().optional().default(''),
  country: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

const createOrderSchema = z.object({
  shippingAddress: shippingAddressSchema,
  billingAddress: shippingAddressSchema.optional(),
  paymentMethod: z.string().min(1),
  notes: z.string().optional(),
  couponCode: z.string().trim().min(1).max(50).optional(),
});

// GET /products - List all public products (cached 30s)
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, category, search, featured } = req.query;
    const storeId = await getStoreIdFromRequest(req);

    // Build a cache key from query params so different filters get their own entry
    const cacheKey = `public:products:${storeId}:${page || 1}:${limit || 20}:${category || ''}:${search || ''}:${featured || ''}`;

    const result = await getCached(cacheKey, 30, () =>
      ProductService.listPublic(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        category: category as string,
        search: search as string,
        featured: featured === 'true',
      })
    );

    res.setHeader('Cache-Control', 'private, max-age=60');
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

    const storeId = await getStoreIdFromRequest(req);
    const product = isUuid
      ? await ProductService.getPublicById(storeId, slugOrId)
      : await ProductService.getPublicBySlug(storeId, slugOrId);

    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({
      success: true,
      data: { product },
    });
  } catch (error) {
    next(error);
  }
});

// GET /categories - List all categories (cached 120s)
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = await getStoreIdFromRequest(req);
    const categories = await getCached(`public:categories:${storeId}`, 120, () =>
      ProductService.getCategories(storeId)
    );

    res.setHeader('Cache-Control', 'private, max-age=60');
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

    const storeId = await getStoreIdFromRequest(req);
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
    const storeId = await getStoreIdFromRequest(req);
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
      const storeId = await getStoreIdFromRequest(req);
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
      const storeId = await getStoreIdFromRequest(req);
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

    const storeId = await getStoreIdFromRequest(req);
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

      const storeId = await getStoreIdFromRequest(req);
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
    const { page, limit } = req.query;
    const storeId = await getStoreIdFromRequest(req);
    const result = await OrderService.getCustomerOrders(storeId, req.user!.userId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /orders/:id - Get order by ID (requires auth)
router.get('/orders/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const storeId = await getStoreIdFromRequest(req);
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
      const storeId = await getStoreIdFromRequest(req);
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

// GET /public/:storeId/wishlist/:userId - Get a user's public wishlist (no auth required)
router.get(
  '/:storeId/wishlist/:userId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, userId } = req.params;

      // Validate UUID format to prevent enumeration attacks
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(storeId) || !uuidRegex.test(userId)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_ID', message: 'Invalid store or user ID' },
        });
        return;
      }

      // Verify store exists and is active before querying wishlists
      const store = await prisma.store.findFirst({
        where: { id: storeId, status: 'active' },
        select: { id: true },
      });
      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Store not found' },
        });
        return;
      }

      const wishlist = await prisma.wishlist.findFirst({
        where: { userId, storeId },
        include: {
          items: {
            include: {
              product: {
                include: {
                  images: {
                    orderBy: { position: 'asc' },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      if (!wishlist) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Wishlist not found' },
        });
        return;
      }

      if (!wishlist.isPublic) {
        res.status(403).json({
          success: false,
          error: { code: 'PRIVATE_WISHLIST', message: 'This wishlist is private' },
        });
        return;
      }

      const items = wishlist.items.map(item => ({
        id: item.id,
        product: {
          id: item.product.id,
          name: item.product.name,
          slug: item.product.slug,
          price: item.product.price / 1000,
          compareAtPrice: item.product.compareAtPrice
            ? item.product.compareAtPrice / 1000
            : undefined,
          images: item.product.images.map(img => img.url),
          status: item.product.status,
        },
      }));

      res.json({
        success: true,
        data: { items, isPublic: wishlist.isPublic },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores - List all public stores
router.get('/stores', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '10' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 10));
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

    res.setHeader('Cache-Control', 'private, max-age=60');
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

// GET /stores/:slugOrId - Get store by slug or ID (public, cached 60s)
router.get('/stores/:slugOrId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slugOrId } = req.params;

    const result = await getCached(`public:store:${slugOrId}`, 60, async () => {
      // Check if it's a UUID (ID) or slug
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        slugOrId
      );

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
          currency: true,
          timezone: true,
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
          ogImage: true,
          twitterHandle: true,
          googleSiteVerification: true,
          settings: true,
          marketingPixels: true,
          pwaEnabled: true,
          pwaSettings: true,
          heroTitle: true,
          heroTitleAr: true,
          heroSubtitle: true,
          heroSubtitleAr: true,
          heroCtaText: true,
          heroCtaTextAr: true,
          heroCtaLink: true,
          heroImage: true,
          createdAt: true,
        },
      });

      if (!store) return null;

      const enabledFeatures = await featureService.getEnabledFeatureKeys(store.id);
      return { store, enabledFeatures };
    });

    if (!result) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Store not found' },
      });
      return;
    }

    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /store - Get default store info
router.get('/store', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Try Redis cache first (best-effort)
    const cacheKey = 'store:default';
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        res.json({
          success: true,
          data: { store: parsed },
        });
        return;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PUBLIC] Redis cache read failed for default store'
      );
    }

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

    // Write to cache (best-effort, 60s TTL)
    try {
      await redis.set(cacheKey, JSON.stringify(store), 60);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PUBLIC] Redis cache write failed for default store'
      );
    }

    res.setHeader('Cache-Control', 'private, max-age=60');
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
      const rawDomain = req.headers['x-store-domain'] as string;

      if (!rawDomain) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_DOMAIN', message: 'x-store-domain header is required' },
        });
        return;
      }

      // Normalize domain: strip www prefix, lowercase — matches how domains
      // are stored in the DB and how the storefront middleware normalizes them.
      const domain = rawDomain.toLowerCase().replace(/^www\./, '');

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
          description: true,
          descriptionAr: true,
          currency: true,
          timezone: true,
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
          ogImage: true,
          twitterHandle: true,
          googleSiteVerification: true,
          settings: true,
          marketingPixels: true,
          pwaEnabled: true,
          pwaSettings: true,
          heroTitle: true,
          heroTitleAr: true,
          heroSubtitle: true,
          heroSubtitleAr: true,
          heroCtaText: true,
          heroCtaTextAr: true,
          heroCtaLink: true,
          heroImage: true,
        },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'STORE_NOT_FOUND', message: 'No store found for the specified domain' },
        });
        return;
      }

      const enabledFeatures = await featureService.getEnabledFeatureKeys(store.id);

      res.setHeader('Cache-Control', 'private, max-age=60');
      res.json({
        success: true,
        data: { store, enabledFeatures },
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
