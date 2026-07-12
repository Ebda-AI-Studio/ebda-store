import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ProductService } from '../services/product.service';
import { CartService } from '../services/cart.service';
import { OrderService } from '../services/order.service';
import { InvoiceService } from '../services/invoice.service';
import { EmailService } from '../services/email.service';
import { prisma } from '@force/database';
import { authenticate, optionalAuthenticate, customerUserId } from '../middleware/auth';
import {
  publicLimiter,
  storeResolveLimiter,
  cartLimiter,
  writeLimiter,
  newsletterLimiter,
  viewIngestLimiter,
} from '../middleware/security';
import { recordProductView } from '../services/view-ingest.service';
import { getStoreIdFromRequest } from '../utils/store-helpers';
import logger from '../lib/logger';
import { featureService } from '../services/feature.service';
import { getCached } from '../lib/public-cache';
import { redis } from '../services/redis.service';
import { setEdgeCache } from '../lib/edge-cache';
import { stripMarketingPixelSecrets } from '../lib/marketing-pixels-secrets';
import { verifyReviewToken } from '../lib/review-token';
import { inngest } from '../lib/inngest/client';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { confirmPaymentFromProviderStatus } from '../services/payment-confirm.service';
import type { PaymentProvider } from '../services/payment-providers/types';

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

// Kuwait-friendly address schema: see notes in order.routes.ts. State and
// postalCode are optional (Kuwait has no postal codes for delivery and the
// "state" field is repurposed to hold the selected delivery area). We trim
// whitespace on required fields so a stray space doesn't trip min(1), and we
// add generous max lengths to bound abuse without rejecting normal Arabic or
// English input.
export const shippingAddressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  address1: z.string().trim().min(1).max(500),
  address2: z.string().max(500).optional(),
  // City is NOT required: Kuwait addresses have no "city" — the locality is the
  // area/district, which the storefront sends in `state`. The checkout form
  // always sends city:'' (KW model), so requiring it here 400'd EVERY order
  // ("خطأ في الدفع" → bounce back to the info step). Accept empty.
  city: z.string().trim().max(150).optional().default(''),
  // Governorate (محافظة) — top-level KW administrative division (Capital, Hawally,
  // Farwaniya, Ahmadi, Jahra, Mubarak Al-Kabeer). Explicit field added 2026-06-18
  // alongside sub-area; legacy orders used `state` or `area` for this concept.
  governorate: z.string().max(60).optional().default(''),
  governorateAr: z.string().max(60).optional().default(''),
  // Sub-area / district (منطقة) within the governorate, e.g. Salmiya, Rumaithiya.
  // The shipping-fee calculator matches on this value first, then falls back to governorate.
  area: z.string().max(150).optional().default(''),
  areaAr: z.string().max(150).optional().default(''),
  state: z.string().max(150).optional().default(''),
  postalCode: z.string().max(30).optional().default(''),
  country: z.string().trim().min(2).max(60),
  phone: z.string().max(40).optional(),
  // Email is optional. The form sends '' when the buyer leaves it blank;
  // z.string().email() rejects '' and .optional() only permits undefined, so a
  // blank email also 400'd the order. Treat '' (or whitespace) as "not given".
  email: z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().email().optional()
  ),
});

export const createOrderSchema = z.object({
  shippingAddress: shippingAddressSchema,
  billingAddress: shippingAddressSchema.optional(),
  paymentMethod: z.string().min(1),
  notes: z.string().max(2000).optional(),
  couponCode: z.string().trim().min(1).max(50).optional(),
  /** Loyalty points the customer requests to redeem. A request, not a
   *  trusted discount — the server re-resolves it against the customer's
   *  real balance + store caps. Ignored for guests. Bounded to a sane
   *  integer ceiling so a malformed value can't overflow the math. */
  pointsToRedeem: z.number().int().min(0).max(100_000_000).optional(),
  /** Buyer's UI locale. Stored on the order so transactional emails
   *  arrive in the buyer's language regardless of the store default. */
  locale: z.enum(['en', 'ar']).optional(),
  /**
   * Explicit SMS marketing consent captured from the checkout opt-in checkbox.
   * When true the customer has agreed to receive PROMOTIONAL SMS messages.
   * Transactional notifications (order shipped/delivered/cancelled/refunded)
   * are never gated on this — only promotional SMS is.
   * Defaults to false when omitted (no silent opt-in).
   */
  smsOptIn: z.boolean().optional().default(false),
});

// GET /products - List all public products (cached 30s)
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, category, search, featured, sort, minPrice, maxPrice, cursor, ids } =
      req.query;
    const storeId = await getStoreIdFromRequest(req);

    const sortValue =
      sort === 'newest' || sort === 'price_asc' || sort === 'price_desc' || sort === 'best_seller'
        ? sort
        : undefined;

    // Cursor MUST be a v4 UUID — refuse anything else so a malformed cursor
    // can't bypass the offset cap or trigger a Prisma error path.
    const validCursor =
      typeof cursor === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor)
        ? cursor
        : undefined;

    // ids query param — comma-separated product UUIDs. Used by page-builder
    // ExtraCarousel with `productSource === 'manual'`. Service caps at 50.
    const idsParam =
      typeof ids === 'string' && ids.length > 0
        ? ids
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, 50)
        : undefined;

    // Variant-option facet filters: ?opt_Size=Large,XL&opt_Color=Red
    // Each `opt_<OptionName>` param carries comma-separated selected values.
    // Capped at 10 option names and 20 values each to prevent abuse.
    const optionFilters: Record<string, string[]> = {};
    const MAX_OPTION_NAMES = 10;
    const MAX_OPTION_VALUES = 20;
    let optionFilterKey = '';
    for (const [key, raw] of Object.entries(req.query)) {
      if (!key.startsWith('opt_')) continue;
      if (Object.keys(optionFilters).length >= MAX_OPTION_NAMES) break;
      const optionName = key.slice(4); // strip "opt_"
      if (!optionName || typeof raw !== 'string') continue;
      const vals = raw
        .split(',')
        .map(v => v.trim())
        .filter(Boolean)
        .slice(0, MAX_OPTION_VALUES);
      if (vals.length > 0) {
        optionFilters[optionName] = vals;
        optionFilterKey += `${optionName}=${vals.join(',')};`;
      }
    }
    const hasOptionFilters = Object.keys(optionFilters).length > 0;

    // Cache key includes cursor + ids + option filters — different selections get distinct entries.
    const cacheKey = `public:products:${storeId}:${page || 1}:${limit || 20}:${category || ''}:${
      search || ''
    }:${featured || ''}:${sortValue || ''}:${minPrice || ''}:${maxPrice || ''}:${
      validCursor || ''
    }:${idsParam?.sort().join(',') ?? ''}:${optionFilterKey}`;

    const result = await getCached(cacheKey, 120, () =>
      ProductService.listPublic(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        category: category as string,
        search: search as string,
        featured: featured === 'true',
        sort: sortValue,
        minPrice: minPrice ? parseInt(minPrice as string, 10) : undefined,
        maxPrice: maxPrice ? parseInt(maxPrice as string, 10) : undefined,
        cursor: validCursor,
        ids: idsParam,
        optionFilters: hasOptionFilters ? optionFilters : undefined,
      })
    );

    // Edge-cacheable: product list is identical for all anonymous
    // visitors of the same store. Per-tenant via the default Vary on
    // x-store-id; per-locale because the storefront ?lang= query
    // surfaces in the URL, so it's already in the cache key without
    // needing Accept-Language Vary.
    setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300 });
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

    // Skip Redis cache for authenticated requests — per-user responses must
    // never be served from a shared cache (auth header OR session cookie).
    const isAuthenticated = !!req.headers['authorization'] || !!req.cookies?.token;

    const cacheKey = `public:product:${storeId}:${slugOrId}`;
    const product = isAuthenticated
      ? // Live fetch — bypass cache for authenticated callers
        await (isUuid
          ? ProductService.getPublicById(storeId, slugOrId)
          : ProductService.getPublicBySlug(storeId, slugOrId))
      : // Anonymous path — Redis-backed get-or-set (120s TTL, min required by
        // CLAUDE.md ESLint rule to avoid hammering Neon on cache miss).
        await getCached(cacheKey, 120, () =>
          isUuid
            ? ProductService.getPublicById(storeId, slugOrId)
            : ProductService.getPublicBySlug(storeId, slugOrId)
        );

    setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300 });
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

    setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 });
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

    const { productId, quantity, variantId } = addCartItemSchema.parse(req.body);
    const storeId = await getStoreIdFromRequest(req);
    const cart = await CartService.addItem(
      storeId,
      sessionId,
      productId,
      quantity,
      undefined,
      variantId
    );

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// POST /cart/sync - bulk-merge a guest cart into the session cart (post-login
// migration). Mirrors POST /cart/items but takes an array; uses the existing
// CartService.addItems. Without this the storefront's guest->login cart
// migration hit a 404 and silently lost the cart.
const syncCartSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1),
        variantId: z.string().uuid().optional(),
      })
    )
    .max(100),
});
router.post('/cart/sync', cartLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_SESSION', message: 'Session ID required' },
      });
      return;
    }
    const { items } = syncCartSchema.parse(req.body);
    const storeId = await getStoreIdFromRequest(req);
    const cart = await CartService.addItems(storeId, sessionId, items);
    res.json({ success: true, data: { cart } });
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
// POST /orders - Create order. Guest checkout supported: customerId is
// nullable in the schema, the cart service already handles a missing
// customerId by keying off sessionId, and the order's shippingAddress
// captures the contact info we need to fulfil the order. Visitors on
// a friend's laptop don't have an account; forcing them to register
// before checkout was the cause of "خطأ في الدفع".
router.post(
  '/orders',
  optionalAuthenticate,
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
      // Customer-leak guard: only treat req.user as the order owner when
      // the role is `customer`. The API cookie is shared between admin
      // and storefront origins (api.force-ai.co host), so a merchant
      // signed into app.forcemediakw.com sends the SAME cookie to
      // /public/orders on store.forcemediakw.com. Without this guard
      // we'd attach the merchant's super_admin/store_admin userId as
      // `Order.customerId` — downstream loyalty / abandoned-cart /
      // analytics code assumes that ID points to a customer record and
      // throws when it points at an admin instead. Mirror is in
      // apps/web/src/contexts/AuthContext.tsx (refreshUser).
      const orderCustomerId = req.user?.role === 'customer' ? req.user.userId : undefined;
      const order = await OrderService.create(storeId, orderCustomerId, sessionId, orderData);

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
    // customerUserId() rejects admin tokens here. Without this guard, an
    // admin's userId (which is never a customerId) would be passed to
    // OrderService.getCustomerOrders — usually empty, but it leaks the
    // existence of any user record matching the admin's id.
    const customerId = customerUserId(req);
    if (!customerId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Customer account required' },
      });
      return;
    }
    const result = await OrderService.getCustomerOrders(storeId, customerId, {
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

// GET /orders/:id - Get order by ID. Used by the storefront's checkout
// success page to render the just-completed order. Supports both
// signed-in customers and guests:
//
//   - signed-in customer: order must match their userId.
//   - guest: order must have customerId = null. The orderId is a v4
//     uuid handed back from /public/orders moments ago, so anyone in
//     possession of it is the legitimate viewer. Same trust model as
//     /payments/create — see the comment there for the rationale.
//
// We use optionalAuthenticate so a stale admin cookie bleeding through
// from app.forcemediakw.com doesn't reject a guest's success page; the
// role-guard below handles that case.
router.get(
  '/orders/:id',
  optionalAuthenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const storeId = await getStoreIdFromRequest(req);
      const order = await OrderService.getById(storeId, id);

      const isCustomer = req.user?.role === 'customer';
      if (isCustomer) {
        if (order.customerId !== req.user!.userId) {
          res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Not authorized to view this order' },
          });
          return;
        }
      } else if (order.customerId !== null) {
        // Order belongs to a customer but the viewer isn't signed in
        // as that customer (or as anyone). Reject — admins viewing
        // customer orders go through the /stores/:storeId/orders
        // admin route, not this public path.
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
  }
);

// POST /orders/:id/verify-payment — GUEST-SAFE verify-on-return.
//
// THE PRIMARY payment-confirmation path. MyFatoorah's webhook is
// configured account-level in their portal and does NOT fire per
// invoice for FWB, so the storefront success page must actively ask
// the provider "is this invoice paid?" on return and reconcile our DB.
// The webhook path remains as a backup (when a store DOES wire the
// portal webhook).
//
// AUTHZ (guest-safe, IDOR-resistant — most buyers are not logged in):
//   1. The orderId in the path is a v4 UUID handed back from
//      /public/orders moments ago — practically unguessable. Same trust
//      model as GET /public/orders/:id and /payments/create.
//   2. customerId guard: signed-in customers may only verify their own
//      order; for guest orders (customerId === null) possession of the
//      UUID is the credential. An admin/customer cookie that doesn't
//      own the order is rejected (mirrors GET /orders/:id exactly).
//   3. The mark-paid transition is ONLY driven by the provider's own
//      GetPaymentStatus answer for THIS order's stored invoice/
//      transaction id. A caller cannot fabricate "paid" — even if they
//      somehow guessed a UUID, the order only flips to paid when
//      MyFatoorah independently reports that invoice as Paid. The
//      optional `paymentId` from the redirect URL is recorded for the
//      audit trail but is never trusted as proof of payment on its own.
//
// IDEMPOTENT: safe to call on every page load / retry. The shared
// confirmPaymentFromProviderStatus helper only writes + fans out on a
// real transition, so a later webhook (or a second verify) is a no-op.
const verifyPaymentSchema = z.object({
  // MyFatoorah appends ?paymentId=<id> (sometimes ?Id=) to the success
  // URL. Optional + recorded for audit only — authorization rides on the
  // order UUID + the provider's status answer, not on this value.
  paymentId: z.string().trim().min(1).max(128).optional(),
});

router.post(
  '/orders/:id/verify-payment',
  optionalAuthenticate,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = verifyPaymentSchema.parse(req.body ?? {});
      const storeId = await getStoreIdFromRequest(req);

      const order = await prisma.order.findFirst({
        where: { id, storeId, deletedAt: null },
        select: {
          id: true,
          storeId: true,
          customerId: true,
          paymentStatus: true,
          locale: true,
          payments: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              provider: true,
              transactionId: true,
              metadata: true,
              amount: true,
              currency: true,
            },
          },
        },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      // Same ownership guard as GET /orders/:id.
      const isCustomer = req.user?.role === 'customer';
      if (isCustomer) {
        if (order.customerId !== req.user!.userId) {
          res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Not authorized to verify this order' },
          });
          return;
        }
      } else if (order.customerId !== null) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Not authorized to verify this order' },
        });
        return;
      }

      const payment = order.payments[0];

      // Already paid → idempotent success. Don't bother re-asking the
      // provider; the webhook (or an earlier verify) already reconciled.
      if (order.paymentStatus === 'paid') {
        res.json({
          success: true,
          data: { paymentStatus: 'paid', providerStatus: 'completed', statusChanged: false },
        });
        return;
      }

      // COD orders have a cod_pending payment and never an online provider
      // transaction — there's nothing to verify against a gateway.
      if (!payment || !payment.transactionId || payment.provider === 'cod') {
        res.json({
          success: true,
          data: {
            paymentStatus: order.paymentStatus === 'failed' ? 'failed' : 'unpaid',
            providerStatus: 'pending',
            statusChanged: false,
          },
        });
        return;
      }

      // Ask the provider directly. PaymentService resolves the provider +
      // per-store credentials from the stored payment row. We key on OUR
      // stored transactionId (the invoice id), which is the authoritative
      // link to this order — not the redirect's paymentId.
      //
      // Fail-soft: a provider/network blip here must NOT 500 the success
      // page. Return a truthful "pending" so the customer sees "confirming…"
      // and the webhook backup (or a later reload) reconciles. The order
      // stays unpaid until we actually get a Paid answer — never optimistic.
      let status;
      try {
        status = await PaymentService.getPaymentStatus(
          payment.transactionId,
          payment.provider as PaymentProvider,
          storeId
        );
      } catch (err) {
        logger.warn(
          { err, orderId: order.id, storeId },
          '[VERIFY-ON-RETURN] provider getPaymentStatus failed — returning pending'
        );
        res.json({
          success: true,
          data: { paymentStatus: 'unpaid', providerStatus: 'pending', statusChanged: false },
        });
        return;
      }

      const result = await confirmPaymentFromProviderStatus({
        payment: {
          id: payment.id,
          status: payment.status,
          provider: payment.provider,
          metadata: {
            ...((payment.metadata as object) || {}),
            ...(body.paymentId ? { returnPaymentId: body.paymentId } : {}),
          },
          amount: payment.amount,
          currency: payment.currency,
        },
        order: {
          id: order.id,
          storeId: order.storeId,
          paymentStatus: order.paymentStatus,
          locale: order.locale,
        },
        providerStatus: status,
        source: 'guest_verify',
        triggeredByUserId: req.user?.role === 'customer' ? req.user.userId : null,
      });

      logger.info(
        {
          orderId: order.id,
          storeId,
          providerStatus: result.providerStatus,
          paymentStatus: result.paymentStatus,
          statusChanged: result.statusChanged,
        },
        '[VERIFY-ON-RETURN] guest payment verification'
      );

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// GET /orders/:id/invoice - Get invoice for customer's own order (requires auth)
router.get(
  '/orders/:id/invoice',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const storeId = await getStoreIdFromRequest(req);
      const order = await OrderService.getById(storeId, id);

      // Ensure the request comes from the customer who placed the order.
      // customerUserId() returns undefined for admin tokens — admins must
      // use the /stores/:storeId/orders/:id/invoice route instead.
      const customerId = customerUserId(req);
      if (!customerId || order.customerId !== customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Not authorized to view this invoice' },
        });
        return;
      }

      // ?locale=ar renders an Arabic RTL invoice; falls back to order.locale.
      const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;
      const html = await InvoiceService.generateInvoice(storeId, id, locale);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      next(error);
    }
  }
);

// GET /public/:storeId/search/suggest - Storefront typeahead suggestions
//
// Returns up to 25 active products matching `q` against name OR nameAr,
// with image[0] flattened to a single URL so the header dropdown can
// render thumbnails without further joins. 30s edge cache + 60s memory
// cache keep cold-start hits cheap on busy stores. The dropdown's
// max-h-[70vh] + overscroll-contain takes care of the scroll inside
// the typeahead.
router.get('/:storeId/search/suggest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;

    // Validate UUID to prevent enumeration / cache-key bloat
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(storeId)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_ID', message: 'Invalid store ID' },
      });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      res.json({ success: true, data: { suggestions: [] } });
      return;
    }

    const cacheKey = `public:suggest:${storeId}:${trimmed.toLowerCase()}`;
    const result = await getCached(cacheKey, 120, () =>
      ProductService.getSuggestSuggestions(storeId, trimmed, 25)
    );

    res.setHeader('Cache-Control', 'private, max-age=120');
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

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

// POST /public/:storeId/views — Storefront product view beacon
//
// Records a storefront product page view as a per-day aggregate counter in
// `product_daily_views`. Used by the PDP to fire a fire-and-forget beacon on
// mount (alongside existing marketing pixel events). This is the server-side
// ingest that powers the FunnelSnapshot.productViews field in the nightly rollup.
//
// Design decisions:
//  • Two-layer rate limiting: viewIngestLimiter (60/min per IP via Redis) +
//    session debounce in view-ingest.service.ts (one increment per
//    sessionId+productId per 10-minute window). A view flood cannot hammer Neon.
//  • Upsert-increment (one SQL round-trip). Never blocks the page load.
//  • Fail-open: any error in recordProductView is swallowed so the 200 response
//    always returns — the storefront beacon is fire-and-forget.
//  • Store ownership: product is verified to belong to the storeId in the path
//    before any write happens.
const viewSchema = z.object({
  productId: z.string().uuid(),
  sessionId: z.string().min(1).max(128).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post(
  '/:storeId/views',
  viewIngestLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      if (!UUID_RE.test(storeId)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_ID', message: 'Invalid store ID' },
        });
        return;
      }

      const parsed = viewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'productId is required and must be a UUID' },
        });
        return;
      }

      const { productId, sessionId } = parsed.data;

      // Verify the product belongs to this store (ownership guard).
      // Explicit select to avoid fetching unnecessary columns.
      const product = await prisma.product.findFirst({
        where: { id: productId, storeId, deletedAt: null },
        select: { id: true },
      });

      if (!product) {
        // Return 200 for non-existent products — the storefront shouldn't see
        // an error for a tracking beacon; we just silently skip.
        res.json({ success: true, data: { recorded: false } });
        return;
      }

      // Fire-and-forget: recordProductView is internally fail-open.
      // We don't await in a way that blocks the response, but the function
      // itself is lightweight (single SQL upsert) so awaiting is fine — it
      // resolves well under 50ms in the common case.
      const recorded = await recordProductView(storeId, productId, sessionId);

      res.json({ success: true, data: { recorded } });
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

    setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 });
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

// GET /stores/:slugOrId - Get store by slug or ID (public, cached 120s)
router.get('/stores/:slugOrId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slugOrId } = req.params;

    const result = await getCached(`public:store:${slugOrId}`, 120, async () => {
      // Check if it's a UUID (ID) or slug
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        slugOrId
      );

      // Return active OR suspended stores (so the storefront can render a
      // branded "we'll be back soon" page for suspended stores instead of
      // 404'ing). Inactive stores stay hidden — `inactive` is reserved for
      // archived/draft stores merchants haven't published. Soft-deleted
      // stores (`deletedAt` set) are also excluded.
      const store = await prisma.store.findFirst({
        where: {
          ...(isUuid ? { id: slugOrId } : { slug: slugOrId }),
          status: { in: ['active', 'suspended'] },
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          nameAr: true,
          slug: true,
          domain: true,
          status: true,
          logo: true,
          logoAr: true,
          favicon: true,
          description: true,
          descriptionAr: true,
          currency: true,
          timezone: true,
          template: true,
          theme: true,
          typography: true,
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
          metaDescriptionAeo: true,
          metaDescriptionAeoAr: true,
          ogImage: true,
          twitterHandle: true,
          googleSiteVerification: true,
          settings: true,
          taxEnabled: true,
          taxIncludedInPrice: true,
          marketingPixels: true,
          pwaEnabled: true,
          pwaSettings: true,
          blogEnabled: true,
          locationsEnabled: true,
          heroTitle: true,
          heroTitleAr: true,
          heroSubtitle: true,
          heroSubtitleAr: true,
          heroCtaText: true,
          heroCtaTextAr: true,
          heroCtaLink: true,
          heroImage: true,
          createdAt: true,
          llmsTxt: true,
          aboutJson: true,
          faqs: {
            where: { isActive: true },
            orderBy: { orderIndex: 'asc' },
            select: {
              id: true,
              question: true,
              questionAr: true,
              answer: true,
              answerAr: true,
            },
          },
          howtos: {
            where: { isActive: true },
            orderBy: { orderIndex: 'asc' },
            select: {
              id: true,
              title: true,
              titleAr: true,
              description: true,
              descriptionAr: true,
              steps: true,
              stepsAr: true,
            },
          },
        },
      });

      if (!store) return null;

      // Strip server-only marketing-pixel secrets (Meta CAPI / TikTok Events
      // access tokens) before this store object reaches the public storefront
      // (and the edge cache). The browser pixel snippets only use the public
      // pixel IDs — the tokens must never be exposed to anonymous visitors.
      const publicStore = {
        ...store,
        marketingPixels: stripMarketingPixelSecrets(store.marketingPixels),
      };

      const enabledFeatures = await featureService.getEnabledFeatureKeys(store.id);
      // Mirror the /store/resolve endpoint: surface explicitly-disabled
      // CMS pages so the storefront footer can hide their links rather
      // than rendering a "Page unavailable" landing on click.
      const disabledPages = await prisma.storePage.findMany({
        where: { storeId: store.id, isPublished: false },
        select: { slug: true },
      });
      const disabledCmsSlugs = disabledPages.map(p => p.slug);
      return { store: publicStore, enabledFeatures, disabledCmsSlugs };
    });

    if (!result) {
      res.status(404).json({
        success: false,
        error: { code: 'STORE_NOT_FOUND', message: 'Store not found' },
      });
      return;
    }

    setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 });
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

    // Write to cache (best-effort, 5min TTL — default store rarely
    // changes; even longer would be fine but 5 min keeps merchant
    // edits visible without an explicit invalidate hook).
    try {
      await redis.set(cacheKey, JSON.stringify(store), 300);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PUBLIC] Redis cache write failed for default store'
      );
    }

    setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 });
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

      // Redis-cached (120s, same shape/TTL as /stores/:slugOrId above) —
      // this is the domain→store lookup every storefront page load depends
      // on, so it must not hit Postgres on every request.
      const result = await getCached(`public:store:resolve:${domain}`, 120, async () => {
        // Find store by domain. Suspended stores are returned with their
        // `status` so the storefront can render the branded maintenance page
        // for that store. Inactive (archived/draft) and soft-deleted stores
        // stay hidden — those should still 404.
        const store = await prisma.store.findFirst({
          where: {
            domain,
            status: { in: ['active', 'suspended'] },
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
            nameAr: true,
            slug: true,
            domain: true,
            status: true,
            logo: true,
            logoAr: true,
            favicon: true,
            description: true,
            descriptionAr: true,
            currency: true,
            timezone: true,
            template: true,
            theme: true,
            typography: true,
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
            metaDescriptionAeo: true,
            metaDescriptionAeoAr: true,
            ogImage: true,
            twitterHandle: true,
            googleSiteVerification: true,
            settings: true,
            taxEnabled: true,
            taxIncludedInPrice: true,
            marketingPixels: true,
            pwaEnabled: true,
            pwaSettings: true,
            blogEnabled: true,
            locationsEnabled: true,
            heroTitle: true,
            heroTitleAr: true,
            heroSubtitle: true,
            heroSubtitleAr: true,
            heroCtaText: true,
            heroCtaTextAr: true,
            heroCtaLink: true,
            heroImage: true,
            llmsTxt: true,
            aboutJson: true,
            faqs: {
              where: { isActive: true },
              orderBy: { orderIndex: 'asc' },
              select: {
                id: true,
                question: true,
                questionAr: true,
                answer: true,
                answerAr: true,
              },
            },
            howtos: {
              where: { isActive: true },
              orderBy: { orderIndex: 'asc' },
              select: {
                id: true,
                title: true,
                titleAr: true,
                description: true,
                descriptionAr: true,
                steps: true,
                stepsAr: true,
              },
            },
          },
        });

        if (!store) return null;

        const enabledFeatures = await featureService.getEnabledFeatureKeys(store.id);

        // Surface CMS pages that the merchant has explicitly turned off
        // ("Show on storefront" toggle in /content). The storefront uses
        // this to hide footer links pointing at those slugs — without it,
        // a customer would click "Privacy" in the footer and land on a
        // "Page unavailable" message, which is a worse UX than the link
        // simply not being there. Only rows that exist AND are unpublished
        // need to be reported; if the row is missing the storefront falls
        // back to its built-in copy and the link should still work.
        const disabledPages = await prisma.storePage.findMany({
          where: { storeId: store.id, isPublished: false },
          select: { slug: true },
        });
        const disabledCmsSlugs = disabledPages.map(p => p.slug);

        // Strip server-only marketing-pixel secrets before the store reaches the
        // public storefront + edge cache (browser pixels use public IDs only).
        const publicStore = {
          ...store,
          marketingPixels: stripMarketingPixelSecrets(store.marketingPixels),
        };

        return { store: publicStore, enabledFeatures, disabledCmsSlugs };
      });

      if (!result) {
        res.status(404).json({
          success: false,
          error: { code: 'STORE_NOT_FOUND', message: 'No store found for the specified domain' },
        });
        return;
      }

      setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 });
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /newsletter/subscribe - Customer newsletter signup
//
// Idempotent: re-submitting an already-subscribed email returns 200 with
// `alreadySubscribed: true` (so the storefront can show the same friendly
// "thanks!" state without leaking whether the address is on the list to a
// would-be enumerator). The welcome email is fire-and-forget so SMTP
// problems don't block the response — the row is the source of truth.
router.post(
  '/newsletter/subscribe',
  newsletterLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subscribeSchema = z.object({
        email: z.string().email('Invalid email address').max(254),
        language: z.enum(['en', 'ar']).optional(),
        source: z.enum(['footer', 'popup', 'manual']).optional(),
      });

      const data = subscribeSchema.parse(req.body);
      const storeId = await getStoreIdFromRequest(req);
      const normalizedEmail = data.email.trim().toLowerCase();

      const existing = await prisma.newsletterSubscriber.findUnique({
        where: {
          storeId_email: { storeId, email: normalizedEmail },
        },
      });

      if (existing) {
        // If they had previously unsubscribed, re-activate the row so the
        // admin's send count stays correct.
        if (!existing.isActive) {
          await prisma.newsletterSubscriber.update({
            where: { id: existing.id },
            data: {
              isActive: true,
              unsubscribedAt: null,
              language: data.language ?? existing.language,
              source: data.source ?? existing.source,
            },
          });
        }

        res.json({
          success: true,
          data: { alreadySubscribed: true },
        });
        return;
      }

      await prisma.newsletterSubscriber.create({
        data: {
          storeId,
          email: normalizedEmail,
          language: data.language ?? null,
          source: data.source ?? 'footer',
          isActive: true,
        },
      });

      // Fire-and-forget welcome email — don't await so a slow / misconfigured
      // SMTP server doesn't keep the customer staring at a spinner.
      EmailService.sendWelcome(
        storeId,
        { email: normalizedEmail, name: '' },
        (data.language as 'en' | 'ar' | undefined) ?? undefined
      ).catch(err => {
        logger.warn(
          { err: err instanceof Error ? err.message : 'unknown', storeId },
          '[NEWSLETTER] welcome email failed'
        );
      });

      res.json({
        success: true,
        data: { alreadySubscribed: false },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Token-gated review submission (Task 28)
// ==========================================

// GET /reviews/can-submit?orderId=...&productId=...&token=...
// Validates the HMAC token + order state + no-existing-review.
// Returns product + store info for the form to render.
router.get(
  '/reviews/can-submit',
  publicLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        orderId: z.string().min(1),
        productId: z.string().min(1),
        token: z.string().min(1),
      });
      const { orderId, productId, token } = schema.parse(req.query);

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          storeId: true,
          reviewRequestSentAt: true,
          deliveredAt: true,
        },
      });
      if (!order) {
        res.status(404).json({ ok: false, error: 'ORDER_NOT_FOUND' });
        return;
      }
      if (order.status !== 'delivered') {
        res.status(400).json({ ok: false, error: 'ORDER_NOT_DELIVERED' });
        return;
      }

      const sentAt = order.reviewRequestSentAt || order.deliveredAt;
      if (!sentAt) {
        res.status(400).json({ ok: false, error: 'NO_SENT_AT' });
        return;
      }

      const tokenOk = verifyReviewToken(orderId, productId, token, sentAt);
      if (!tokenOk) {
        res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
        return;
      }

      // Check no existing review for this (orderId, productId) pair
      const existing = await prisma.review.findUnique({
        where: { orderId_productId: { orderId, productId } },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({ ok: false, error: 'ALREADY_REVIEWED', reviewId: existing.id });
        return;
      }

      // Load product + store info for the form
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, nameAr: true, images: true, storeId: true },
      });
      if (!product || product.storeId !== order.storeId) {
        res.status(404).json({ ok: false, error: 'PRODUCT_NOT_FOUND' });
        return;
      }

      const store = await prisma.store.findUnique({
        where: { id: order.storeId },
        select: { name: true, nameAr: true, slug: true, logo: true },
      });

      res.json({ ok: true, product, store });
    } catch (error) {
      next(error);
    }
  }
);

// POST /reviews/submit
// Creates a verified-purchase Review (status: 'pending') and fires
// the review/submitted Inngest event for AI spam-check + translation (Task 30).
router.post(
  '/reviews/submit',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        orderId: z.string().min(1),
        productId: z.string().min(1),
        token: z.string().min(1),
        rating: z.number().int().min(1).max(5),
        title: z.string().max(200).optional().nullable(),
        body: z.string().min(20, 'Review must be at least 20 characters').max(5000),
        language: z.enum(['en', 'ar']).default('en'),
      });
      const data = schema.parse(req.body);

      // Re-validate token + order state — never trust the form's prior check
      const order = await prisma.order.findUnique({
        where: { id: data.orderId },
        select: {
          id: true,
          status: true,
          storeId: true,
          reviewRequestSentAt: true,
          deliveredAt: true,
          customerId: true,
        },
      });
      if (!order || order.status !== 'delivered') {
        res.status(400).json({ ok: false, error: 'ORDER_NOT_DELIVERED' });
        return;
      }

      const sentAt = order.reviewRequestSentAt || order.deliveredAt;
      if (!sentAt || !verifyReviewToken(data.orderId, data.productId, data.token, sentAt)) {
        res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
        return;
      }

      // Verify the product is actually in this order (defense-in-depth)
      const orderItem = await prisma.orderItem.findFirst({
        where: { orderId: data.orderId, productId: data.productId },
        select: { id: true },
      });
      if (!orderItem) {
        res.status(400).json({ ok: false, error: 'PRODUCT_NOT_IN_ORDER' });
        return;
      }

      // Create the review — status 'pending' until AI spam-check + moderation
      const review = await prisma.review.create({
        data: {
          productId: data.productId,
          storeId: order.storeId,
          orderId: data.orderId,
          customerId: order.customerId,
          rating: data.rating,
          title: data.title ?? null,
          body: data.body,
          language: data.language,
          verifiedPurchase: true,
          status: 'pending',
        },
        select: { id: true },
      });

      // Fire AI spam-check + translation event (Task 30 wires the handler)
      inngest
        .send({
          name: 'review/submitted',
          data: { reviewId: review.id, storeId: order.storeId },
        })
        .catch((err: unknown) =>
          logger.warn({ err, reviewId: review.id }, '[ReviewSubmit] inngest enqueue failed')
        );

      res.json({ ok: true, reviewId: review.id });
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

    // Fire-and-forget notification email to admin — don't await so a slow /
    // misconfigured SMTP server doesn't keep the visitor staring at a
    // spinner (matches the newsletter-signup handler above).
    EmailService.sendContactForm({
      name: data.name,
      email: data.email,
      subject: data.subject,
      message: data.message,
    }).catch(err => {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[CONTACT] notification email failed'
      );
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
