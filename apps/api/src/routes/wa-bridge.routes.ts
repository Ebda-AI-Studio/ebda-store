/**
 * WBS→Ebda Bridge Routes — WhatsApp Customer-DM Ordering (Phase 6 / Option C)
 *
 * Endpoints WBS calls into during the customer-DM-to-order flow. All
 * routes auth via `X-WBS-API-KEY` header (mapped to a Store by the
 * waBridgeAuth middleware → req.bridgeStore).
 *
 * Endpoints (mounted at /api/v1/wa-bridge):
 *   GET  /categories                              category list
 *   GET  /products/search?q=                      text search top-10
 *   GET  /products/by-category?categoryId=&page=  paginated 10/page
 *   GET  /store-catalog                           full catalog for bot intent classifier (Phase 8)
 *   POST /cart/from-wa                            create cart + signed JWT
 *   POST /cart/redeem                             single-use JWT redemption
 *   GET  /health                                  bridge ping
 *
 * Designed around Meta WhatsApp Cloud API constraints from the audit
 * research: interactive list messages cap at 10 rows → category-then-
 * product pagination is the right primitive for browsing.
 */

import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { prisma } from '@force/database';
import { groupOrderLinesForDisplay, BRAND_MARKETING_URL } from '@force/shared';
import { config } from '../config';
import { waBridgeAuth } from '../middleware/wa-bridge-auth';
import { isWhatsappEnabled, FEATURE_DISABLED_BODY } from '../middleware/wa-feature-gate';
import { makeRateLimitStore, rateLimitRedisClient } from '../middleware/security';
import {
  EFFECTIVE_STOCK_SELECT,
  effectiveInventory,
  isOrderable,
} from '../lib/effective-inventory';
import logger from '../lib/logger';
import { maskPhone } from '../lib/pii-mask';
import { waBridgeTiming } from '../lib/observability/wa-bridge-timing';
import { AppError } from '../middleware/error-handler';
import { CustomerAddressService } from '../services/customer-address.service';
import { encryption } from '../services/encryption.service';
import { featureService } from '../services/feature.service';
import {
  listPurchasableBundles,
  describeBundleContents,
  resolveBundle,
  type ResolvedBundle,
} from '../services/bundle.service';

const addressSvc = new CustomerAddressService(prisma as any);

/** Default service menu when the merchant hasn't customized it. */
const DEFAULT_SERVICE_MENU = {
  orderNow: true,
  subscriptionBoxes: false,
  locationsHours: true,
  chatWithAgent: true,
  labels: { en: {}, ar: {} },
};

const router = Router();

// Per-API-key rate limit. 120 req/min headroom — a single store running
// a customer-DM ordering flow has natural rhythm (browse → choose → cart),
// so even an aggressive customer can't reasonably exceed 120/min. Real
// purpose: contain a buggy WBS state-machine retry loop from overwhelming
// Ebda. Falls back to IP when the key is missing (still gets the same cap).
const bridgeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  // The API key is HASHED before it becomes a bucket key: the store is Redis,
  // and a rate-limit store is not a secret store — a plaintext key would sit
  // in Redis (and any dump of it) in clear. Same rule as merchantMcpLimiter.
  keyGenerator: req => {
    const apiKey = req.headers['x-wbs-api-key'];
    if (typeof apiKey === 'string' && apiKey) {
      return `wbs:${createHash('sha256').update(apiKey).digest('hex').slice(0, 24)}`;
    }
    return ipKeyGenerator(req.ip ?? '') || 'anonymous';
  },
  message: {
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Too many requests from this WBS integration. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Redis-backed so the 120/min cap is shared across all API replicas (F8)
  // instead of multiplying by replica count — matches every other limiter
  // in the codebase (`middleware/security.ts`).
  store: makeRateLimitStore(rateLimitRedisClient, 'wa-bridge'),
  // Fail-OPEN on a Redis store error, same posture as every other limiter
  // (see middleware/security.ts): a Redis blip must not 500 the bridge.
  passOnStoreError: true,
});

// Rate limit applies to every wa-bridge call (including the
// customer-facing /cart/redeem). The auth middleware is mounted
// per-route below so /cart/redeem can be reached by storefront browsers
// that don't have a WBS API key — that endpoint's auth IS the signed
// JWT carrying the cart payload.
router.use(bridgeRateLimit);

// Timing middleware — emits structured {path, method, status, durationMs}
// per request for latency diagnosis. Phase 0 instrumentation.
router.use(waBridgeTiming(logger));

const PAGE_SIZE = 10; // Meta interactive list cap
const CHECKOUT_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes

// ─── GET /health ─────────────────────────────────────────────────────────────
router.get('/health', waBridgeAuth, (req, res) => {
  res.json({
    success: true,
    data: { storeId: req.bridgeStore?.id, storeName: req.bridgeStore?.name },
  });
});

// ─── GET /categories ─────────────────────────────────────────────────────────
router.get('/categories', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const storeId = req.bridgeStore!.id;
    const categories = await prisma.category.findMany({
      where: { storeId, deletedAt: null, isActive: true },
      select: {
        id: true,
        name: true,
        nameAr: true,
        slug: true,
        image: true,
        _count: { select: { products: true } },
      },
      orderBy: { position: 'asc' },
      take: 50, // safety cap; WBS only consumes top-10 per list-message
    });

    res.json({
      success: true,
      data: categories.map((c: (typeof categories)[number]) => ({
        id: c.id,
        name: c.name,
        nameAr: c.nameAr,
        slug: c.slug,
        productCount: c._count.products,
        imageUrl: c.image ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] categories failed');
    res.status(500).json({ success: false, error: 'CATEGORIES_FETCH_FAILED' });
  }
});

// ─── GET /products/search?q=&page= ───────────────────────────────────────────
// Bilingual: matches name OR nameAr (both case-insensitive).
// Paginated: page param (default 1) with PAGE_SIZE per page so WBS can
// implement "Show more…" rows the same way as /products/by-category.
// limit param allows WBS to request a different page size (default PAGE_SIZE,
// max 50) — WBS uses 9 products/page so it can reserve one row for "Show more".
const searchSchema = z.object({
  q: z.string().min(1).max(80),
  page: z.coerce.number().int().min(1).max(50).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(PAGE_SIZE),
});
router.get('/products/search', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const parse = searchSchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ success: false, error: 'INVALID_QUERY' });
      return;
    }
    const { q, page, limit } = parse.data;
    const storeId = req.bridgeStore!.id;

    // Case-insensitive contains on name + nameAr, plus exact SKU match.
    // Fetch limit+1 to cheaply determine hasMore without a COUNT query.
    const products = await prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { nameAr: { contains: q, mode: 'insensitive' } },
          { sku: { equals: q } },
        ],
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        price: true,
        compareAtPrice: true,
        inventory: true,
        trackInventory: true,
        allowBackorder: true,
        // Required by the `inStock` flag below: for a variant product the
        // stock is the variant sum, not `inventory`. See lib/effective-inventory.ts.
        // All variants WITH `isActive` — never pre-filtered: an all-disabled
        // product would otherwise read as variant-less and inherit the parent
        // column (issue 2147). effectiveInventory drops the disabled ones.
        variants: { select: { inventory: true, allowBackorder: true, isActive: true } },
        images: {
          select: { url: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
      take: limit + 1, // +1 probe for hasMore
      skip: (page - 1) * limit,
    });

    const hasMore = products.length > limit;
    const pageProducts = hasMore ? products.slice(0, limit) : products;

    res.json({
      success: true,
      data: pageProducts.map(p => ({
        id: p.id,
        name: p.name,
        nameAr: p.nameAr,
        priceFils: p.price,
        currency: req.bridgeStore!.currency,
        compareAtFils: p.compareAtPrice,
        inStock: !p.trackInventory || effectiveInventory(p) > 0 || p.allowBackorder,
        inventory: p.trackInventory ? effectiveInventory(p) : null,
        imageUrl: p.images[0]?.url || null,
      })),
      pagination: { page, perPage: limit, hasMore },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] product search failed');
    res.status(500).json({ success: false, error: 'PRODUCT_SEARCH_FAILED' });
  }
});

// ─── GET /products/by-category?categoryId=&page= ─────────────────────────────
const byCategorySchema = z.object({
  categoryId: z.string().uuid(),
  page: z.coerce.number().int().min(1).max(50).default(1),
});
router.get('/products/by-category', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const parse = byCategorySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ success: false, error: 'INVALID_QUERY' });
      return;
    }
    const { categoryId, page } = parse.data;
    const storeId = req.bridgeStore!.id;

    // Verify category belongs to bridge store (defense in depth — WBS
    // could pass a categoryId from a different store).
    const cat = await prisma.category.findFirst({
      where: { id: categoryId, storeId, deletedAt: null },
      select: { id: true },
    });
    if (!cat) {
      res.status(404).json({ success: false, error: 'CATEGORY_NOT_FOUND' });
      return;
    }

    const products = await prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        categories: { some: { categoryId } },
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        price: true,
        inventory: true,
        trackInventory: true,
        allowBackorder: true,
        // Required by the `inStock` flag below: for a variant product the
        // stock is the variant sum, not `inventory`. See lib/effective-inventory.ts.
        // All variants WITH `isActive` — never pre-filtered: an all-disabled
        // product would otherwise read as variant-less and inherit the parent
        // column (issue 2147). effectiveInventory drops the disabled ones.
        variants: { select: { inventory: true, allowBackorder: true, isActive: true } },
        // Issue 3: include imageUrl so WBS can send product images before the list
        images: {
          select: { url: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    });

    res.json({
      success: true,
      data: products.map(p => ({
        id: p.id,
        name: p.name,
        nameAr: p.nameAr,
        priceFils: p.price,
        currency: req.bridgeStore!.currency,
        inStock: !p.trackInventory || effectiveInventory(p) > 0 || p.allowBackorder,
        imageUrl: p.images[0]?.url ?? null,
      })),
      pagination: { page, perPage: PAGE_SIZE, hasMore: products.length === PAGE_SIZE },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] by-category failed');
    res.status(500).json({ success: false, error: 'BY_CATEGORY_FAILED' });
  }
});

// ─── GET /store-catalog (Phase 8 — bot intent classifier) ───────────────────
// Returns all active categories + products in a single response sized for
// the Gemini intent-classification prompt. WBS caches this at 5-min TTL;
// Ebda adds a 30-day Cache-Control so CDN/Varnish can edge-cache if needed.
//
// Product cap: 1000. Stores with >1000 products will see a warning in the
// response; pagination in Phase 8.2. For Demo Shop today (~235 products)
// the cap is never hit.
//
// Phase 4 extension: optional ?phone=<E164> query param. When provided, the
// response includes `customerHistory` with past order data scoped strictly to
// this store (tenant isolation enforced — same phone on another store returns
// independent history). Privacy: no email, address, or payment info returned.
const CATALOG_PRODUCT_CAP = 1000;
const CUSTOMER_HISTORY_DAYS = 90; // don't surface orders older than 90 days
const CUSTOMER_HISTORY_ORDER_LIMIT = 10; // last 10 paid orders for frequency analysis
const FREQUENT_CATEGORIES_TOP = 3;
const FREQUENT_PRODUCTS_TOP = 5;

/**
 * Build the `customerHistory` payload for a given phone + store.
 * Returns { isReturning: false, ... } if the customer has no paid orders
 * for this store within the 90-day window (clear "not found" signal for bot).
 * Returns null only on database error (caller omits the key from response).
 *
 * Tenant isolation: user is looked up by (phone, storeId, role=customer).
 * A phone that belongs to Store A and Store B gets separate histories.
 * Privacy: no email, address, or payment data returned.
 */
export async function buildCustomerHistory(
  phone: string,
  storeId: string,
  currency: string
): Promise<Record<string, unknown> | null> {
  try {
    // Normalise: strip leading + for comparison flexibility — but keep
    // the value as-is since WBS sends E164 with leading +
    const normalised = phone.trim();

    // Look up the customer scoped to this store only.
    const user = await prisma.user.findFirst({
      where: {
        phone: normalised,
        storeId,
        role: 'customer',
        deletedAt: null,
      },
      select: {
        id: true,
        firstName: true,
        language: true,
      },
    });

    // No customer account for this phone at this store → still return a
    // structured "not returning" object so the bot has a deterministic shape.
    if (!user) {
      return {
        isReturning: false,
        totalOrders: 0,
        totalSpentFils: 0,
        firstName: null,
        preferredLanguage: null,
        lastOrder: null,
        frequentCategories: [],
        frequentProducts: [],
      };
    }

    // Fetch last 10 paid orders within the 90-day window (for frequency analysis)
    const since = new Date(Date.now() - CUSTOMER_HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const orders = await prisma.order.findMany({
      where: {
        storeId,
        customerId: user.id,
        paymentStatus: 'paid',
        deletedAt: null,
        createdAt: { gte: since },
      },
      select: {
        id: true,
        orderNumber: true,
        createdAt: true,
        total: true,
        items: {
          select: {
            id: true,
            productId: true,
            productName: true,
            quantity: true,
            price: true,
            bundleId: true,
            bundleGroupId: true,
            bundleName: true,
            bundleNameAr: true,
            product: {
              select: {
                nameAr: true,
                categories: {
                  select: {
                    category: {
                      select: {
                        id: true,
                        name: true,
                        nameAr: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: CUSTOMER_HISTORY_ORDER_LIMIT,
    });

    if (orders.length === 0) {
      return {
        isReturning: false,
        totalOrders: 0,
        totalSpentFils: 0,
        firstName: user.firstName || null,
        preferredLanguage: (user.language === 'ar' ? 'ar' : 'en') as 'en' | 'ar',
        lastOrder: null,
        frequentCategories: [],
        frequentProducts: [],
      };
    }

    // Compute aggregate spend across the window
    const totalSpentFils = orders.reduce((sum, o) => sum + o.total, 0);

    // Build lastOrder from most-recent order (already sorted desc). Grouped
    // through `groupOrderLinesForDisplay` first — this feeds the WBS
    // shopping bot's conversational context (the design doc's "the
    // WhatsApp thread" collapse requirement), so a returning customer's
    // last purchase must read as ONE "Ramadan Box" line, never its 3
    // components at their per-line allocated (and confusing) prices.
    const latest = orders[0];
    const lastOrder = {
      orderId: latest.id,
      orderNumber: latest.orderNumber,
      createdAt: latest.createdAt.toISOString(),
      totalFils: latest.total,
      items: groupOrderLinesForDisplay(latest.items).map(row =>
        row.kind === 'bundle'
          ? {
              // WBS echoes this id back verbatim on "repeat last order"
              // (`/cart/from-wa`'s `cartFromWaSchema` requires a uuid and
              // rejects `null`), so this must be a resolvable id, not a
              // display placeholder — the bundle's own id, exactly what
              // `/store-catalog` already advertises and what the bundle
              // branch below already resolves.
              productId: row.lines[0].bundleId,
              productName: row.name,
              productNameAr: row.nameAr,
              quantity: row.quantity,
              priceFils: row.total,
              isBundle: true,
            }
          : {
              productId: row.item.productId,
              productName: row.item.productName, // snapshot name at time of purchase
              productNameAr: row.item.product?.nameAr ?? null,
              quantity: row.item.quantity,
              priceFils: row.item.price,
            }
      ),
    };

    // Frequency analysis: count category orders + product quantity across all fetched orders
    const categoryCount: Map<string, { id: string; name: string; nameAr: string; count: number }> =
      new Map();
    const productCount: Map<
      string,
      {
        productId: string;
        name: string;
        nameAr: string | null;
        priceFils: number;
        totalQty: number;
      }
    > = new Map();

    for (const order of orders) {
      // Track which categories appeared in this order (count once per order, not per item)
      const seenCatsThisOrder = new Set<string>();
      for (const item of order.items) {
        for (const pc of item.product?.categories ?? []) {
          const cat = pc.category;
          if (!seenCatsThisOrder.has(cat.id)) {
            seenCatsThisOrder.add(cat.id);
            const existing = categoryCount.get(cat.id);
            if (existing) {
              existing.count += 1;
            } else {
              categoryCount.set(cat.id, {
                id: cat.id,
                name: cat.name,
                nameAr: cat.nameAr ?? '',
                count: 1,
              });
            }
          }
        }
        // Product frequency — total quantity across all orders in the window.
        // A bundle component line is skipped (#1561): its `price` is the
        // allocated share of a discounted box, a number the product was never
        // sold at, and the WBS bot quotes `priceFils` straight to the shopper.
        // The box itself is already surfaced through `lastOrder`. Categories
        // above still count the component: they carry no price, and the
        // customer did buy from that category.
        if (item.bundleGroupId) continue;
        const existing = productCount.get(item.productId);
        if (existing) {
          existing.totalQty += item.quantity;
        } else {
          productCount.set(item.productId, {
            productId: item.productId,
            name: item.productName,
            nameAr: item.product?.nameAr ?? null,
            priceFils: item.price,
            totalQty: item.quantity,
          });
        }
      }
    }

    const frequentCategories = Array.from(categoryCount.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, FREQUENT_CATEGORIES_TOP)
      .map(c => ({ categoryId: c.id, name: c.name, nameAr: c.nameAr, orderCount: c.count }));

    const frequentProducts = Array.from(productCount.values())
      .sort((a, b) => b.totalQty - a.totalQty)
      .slice(0, FREQUENT_PRODUCTS_TOP)
      .map(p => ({
        productId: p.productId,
        name: p.name,
        nameAr: p.nameAr,
        priceFils: p.priceFils,
        totalQuantity: p.totalQty,
      }));

    return {
      isReturning: true,
      totalOrders: orders.length,
      totalSpentFils,
      firstName: user.firstName || null,
      preferredLanguage: (user.language === 'ar' ? 'ar' : 'en') as 'en' | 'ar',
      lastOrder,
      frequentCategories,
      frequentProducts,
    };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, storeId },
      '[wa-bridge] buildCustomerHistory failed'
    );
    return null; // caller omits customerHistory key on error
  }
}

const catalogPhoneSchema = z.object({
  phone: z.string().min(8).max(20).optional(),
});

router.get('/store-catalog', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const store = req.bridgeStore!;

    // Phase 4: optional phone query param for personalized history
    const phoneParseResult = catalogPhoneSchema.safeParse(req.query);
    const customerPhone = phoneParseResult.success ? phoneParseResult.data.phone : undefined;

    // Fetch store meta (name, currency, locale, bot copy overrides)
    const storeRow = await prisma.store.findUnique({
      where: { id: store.id },
      select: {
        id: true,
        name: true,
        nameAr: true,
        currency: true,
        settings: true,
        botCopy: true,
      },
    });

    if (!storeRow) {
      res.status(404).json({ success: false, error: 'STORE_NOT_FOUND' });
      return;
    }

    // Fetch all active categories
    const categories = await prisma.category.findMany({
      where: { storeId: store.id, deletedAt: null, isActive: true },
      select: {
        id: true,
        name: true,
        nameAr: true,
        slug: true,
        position: true,
      },
      orderBy: { position: 'asc' },
    });

    // Fetch active products (cap at CATALOG_PRODUCT_CAP)
    const products = await prisma.product.findMany({
      where: {
        storeId: store.id,
        status: 'active',
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        descriptionAr: true,
        slug: true,
        price: true,
        compareAtPrice: true,
        sku: true,
        inventory: true,
        trackInventory: true,
        allowBackorder: true,
        images: {
          select: { url: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
        categories: {
          select: { categoryId: true },
        },
        // All variants WITH `isActive` (issue 2147): `inStock` below reads
        // effectiveInventory, which must see every variant; the disabled ones
        // are dropped from the offered list instead.
        variants: {
          select: {
            id: true,
            title: true,
            price: true,
            inventory: true,
            allowBackorder: true,
            isActive: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: CATALOG_PRODUCT_CAP + 1, // +1 to detect overflow
    });

    const truncated = products.length > CATALOG_PRODUCT_CAP;
    const productSlice = truncated ? products.slice(0, CATALOG_PRODUCT_CAP) : products;

    if (truncated) {
      logger.warn(
        { storeId: store.id, count: products.length },
        '[wa-bridge] store-catalog hit product cap — returning first 1000; paginate in Phase 8.2'
      );
    }

    // Task 10: bundles appear in the catalogue Ebda offers WBS, as siblings
    // of a product entry — `bundles` is in NO plan baseline, so a store
    // without the super-admin override must see this response completely
    // unchanged (no bundle rows queried at all, not just filtered out).
    // WBS needs no change to BUY one: it echoes back whatever id this
    // catalogue handed it, and `POST /wa-bridge/cart/from-wa` now resolves an
    // id that matches no Product as a bundle, behind this same feature gate
    // (Ruling C3 CLOSED, 2026-09-07 — the consumer PR against that repo is no
    // longer a prerequisite for enabling the flag).
    const bundlesEnabled = await featureService.isFeatureEnabled(store.id, 'bundles');
    const bundles = bundlesEnabled
      ? (await listPurchasableBundles(prisma, store.id)).map(b => {
          const { description, descriptionAr } = describeBundleContents(b);
          return { ...b, description, descriptionAr };
        })
      : [];

    const catalog = {
      storeId: storeRow.id,
      storeName: storeRow.name,
      storeNameAr: storeRow.nameAr ?? '',
      currency: storeRow.currency,
      locale: (storeRow.settings as Record<string, unknown>)?.locale ?? 'en',
      categories: categories.map(c => ({
        id: c.id,
        name: c.name,
        nameAr: c.nameAr ?? '',
        slug: c.slug,
        position: c.position,
      })),
      products: [
        ...productSlice.map(p => ({
          id: p.id,
          name: p.name,
          nameAr: p.nameAr ?? '',
          descriptionAr: p.descriptionAr ?? '',
          slug: p.slug,
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? undefined,
          currency: storeRow.currency,
          categoryIds: p.categories.map(pc => pc.categoryId),
          inStock: !p.trackInventory || effectiveInventory(p) > 0 || p.allowBackorder,
          sku: p.sku ?? undefined,
          imageUrl: p.images[0]?.url ?? undefined,
          variants: p.variants
            .filter(v => v.isActive)
            .map(v => ({
              id: v.id,
              name: v.title,
              price: v.price ?? p.price,
              inStock: v.inventory > 0 || v.allowBackorder,
            })),
        })),
        // Bundle entries: only isPurchasable ones (via listPurchasableBundles),
        // never the per-component allocated prices — `price`/`compareAtPrice`
        // are the one advertised total, same as computeBundlePrice/componentSum
        // are used everywhere else a bundle is sold as a single line.
        // `categoryIds`/`variants` are legitimately empty (bundles have
        // neither), never fabricated. `isBundle: true` is the ONLY field a
        // product entry never carries — WBS uses it to tell the two apart.
        ...bundles.map(b => {
          // `price` is the bundle's actual selling price (already the
          // discounted total) — same meaning as `product.price` above.
          // `compareAtPrice` is the reference "full value" (componentSum),
          // shown crossed-out, only when it's actually higher.
          const onSale = b.componentSum > b.price;
          return {
            id: b.id,
            name: b.name,
            nameAr: b.nameAr ?? '',
            descriptionAr: b.descriptionAr ?? '',
            slug: b.slug,
            price: b.price,
            compareAtPrice: onSale ? b.componentSum : undefined,
            currency: storeRow.currency,
            categoryIds: [] as string[],
            inStock: true, // only isPurchasable bundles reach here (available >= 1)
            sku: undefined as string | undefined,
            imageUrl: b.image ?? undefined,
            variants: [] as Array<{ id: string; name: string; price: number; inStock: boolean }>,
            isBundle: true as const,
          };
        }),
      ],
      cachedAt: new Date().toISOString(),
      ...(truncated ? { truncated: true, totalProducts: products.length } : {}),
    };

    // botCopy: per-store merchant overrides for bot wording (Phase 2).
    // WBS reads this alongside the catalog on every 5-min cache refresh.
    // null = merchant hasn't configured any overrides → WBS falls back
    // to canonical defaults in botCopyDefaults.js for every key.
    const botCopy = storeRow.botCopy ?? null;

    // Phase 4: customer history. Only fetched when ?phone= is supplied.
    // Tenant-scoped to this store — cross-store leakage is impossible.
    // null = fetch failed (WBS omits the key, falls back to anonymous greeting).
    let customerHistory: Record<string, unknown> | null | undefined = undefined;
    if (customerPhone) {
      customerHistory = await buildCustomerHistory(customerPhone, store.id, storeRow.currency);
    }

    // 30-day cache-control: the catalog changes infrequently and WBS applies
    // its own 5-min in-memory TTL on top. CDN/Varnish can serve staleness safely.
    // Note: when ?phone= is provided the response is customer-specific — the
    // Cache-Control header is intentionally kept (WBS manages per-customer
    // caching at the botCatalogService layer with a phone-keyed Redis key).
    res.setHeader('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=86400');
    res.json({
      success: true,
      catalog,
      botCopy,
      ...(customerHistory !== undefined ? { customerHistory } : {}),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] store-catalog failed');
    res.status(500).json({ success: false, error: 'CATALOG_FETCH_FAILED' });
  }
});

// ─── POST /cart/from-wa ──────────────────────────────────────────────────────
// Exported so a unit test can prove a `customerHistory.lastOrder` bundle row
// round-trips through this schema without needing a live DB (NEW-P1).
export const cartFromWaSchema = z.object({
  items: z
    .array(
      z
        .object({
          // productId OR productRetailerId (native catalog uses retailer_id = product.id UUID)
          productId: z.string().uuid().optional(),
          productRetailerId: z.string().uuid().optional(),
          quantity: z.number().int().min(1).max(99),
        })
        .refine(i => i.productId || i.productRetailerId, {
          message: 'Each item must have productId or productRetailerId',
        })
    )
    .min(1)
    .max(20),
  customerPhone: z.string().min(8).max(20).optional(),
  waId: z.string().min(8).max(20).optional(), // native catalog alias for customerPhone
  customerId: z.string().min(1).optional(), // Ebda customer ID (native catalog flow)
  customerName: z.string().min(1).max(120).optional(),
  locale: z.enum(['ar', 'en']).optional(),
  waConversationId: z.string().min(1).max(120).optional(),
  // Phase C native catalog fields:
  addressId: z.string().min(1).optional(), // saved CustomerAddress ID
  addressFreeform: z.string().min(1).max(500).optional(), // raw text address
  paymentMethod: z.enum(['cash', 'online']).optional(), // defaults to 'online' (checkout URL)
  storeId: z.string().min(1).optional(), // explicit storeId override
});
router.post('/cart/from-wa', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const parse = cartFromWaSchema.safeParse(req.body);
    if (!parse.success) {
      res
        .status(400)
        .json({ success: false, error: 'INVALID_PAYLOAD', issues: parse.error.issues });
      return;
    }
    const {
      items: rawItems,
      customerPhone: rawCustomerPhone,
      waId: rawWaId,
      customerId,
      customerName,
      locale,
      waConversationId,
      addressId,
      addressFreeform,
      paymentMethod = 'online',
    } = parse.data;

    // Normalize: accept either customerPhone or waId (native catalog sends waId)
    const customerPhone = rawCustomerPhone || rawWaId;
    if (!customerPhone) {
      res.status(400).json({ success: false, error: 'CUSTOMER_PHONE_REQUIRED' });
      return;
    }

    // Normalize items: accept productRetailerId as alias for productId
    const items = rawItems.map(i => ({
      productId: (i.productId || i.productRetailerId) as string,
      quantity: i.quantity,
    }));

    const store = req.bridgeStore!;

    // Verify every product belongs to bridge store + still in stock.
    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, storeId: store.id, status: 'active', deletedAt: null },
      select: {
        id: true,
        name: true,
        nameAr: true,
        price: true,
        // EFFECTIVE_STOCK_SELECT supplies inventory/trackInventory/
        // allowBackorder plus the variants the stock check needs — spread it
        // rather than listing the columns, so a future edit cannot drop
        // `variants` and silently make this check variant-blind again.
        ...EFFECTIVE_STOCK_SELECT,
      },
    });
    const byId = new Map(products.map(p => [p.id, p]));

    // Ids that resolved to a product stay on this existing path unchanged.
    const productItems = items.filter(i => byId.has(i.productId));
    const unresolvedItems = items.filter(i => !byId.has(i.productId));

    // Task 10 (WA-ordering bundle purchase path): an id that isn't a
    // product may be a bundle id — WBS posts back whatever id
    // `/store-catalog` handed it, and that catalogue now includes bundle
    // entries (see the `isBundle` block above) when the store's `bundles`
    // feature is on. Only resolved AFTER an id fails to match a product,
    // AND only when the flag is enabled — a store without it never calls
    // `resolveBundle` at all, so its `PRODUCTS_NOT_FOUND` response (body
    // included) stays byte-identical to the pre-bundle behaviour. This is
    // the server-side resolution that makes the separate WBS consumer PR
    // (Ruling C3) unnecessary — WBS needs zero changes/deploys.
    let bundleLines: Array<{ item: (typeof items)[number]; bundle: ResolvedBundle }> = [];
    let stillMissing = unresolvedItems;

    if (unresolvedItems.length > 0) {
      const bundlesEnabled = await featureService.isFeatureEnabled(store.id, 'bundles');
      if (bundlesEnabled) {
        const attempts = await Promise.all(
          unresolvedItems.map(async item => {
            try {
              // Tenant-scoped: resolveBundle filters by storeId and throws
              // 404 rather than defaulting to another tenant's row — a
              // bundle id belonging to a DIFFERENT store's bridge key stays
              // unresolved here, same as any other unknown id.
              const bundle = await resolveBundle(prisma, store.id, item.productId);
              return { item, bundle };
            } catch (err) {
              if (err instanceof AppError && err.statusCode === 404) return null;
              throw err;
            }
          })
        );
        bundleLines = attempts.filter(
          (a): a is { item: (typeof items)[number]; bundle: ResolvedBundle } => a !== null
        );
        const resolvedIds = new Set(bundleLines.map(({ item }) => item.productId));
        stillMissing = unresolvedItems.filter(i => !resolvedIds.has(i.productId));
      }
    }

    if (stillMissing.length > 0) {
      res.status(400).json({
        success: false,
        error: 'PRODUCTS_NOT_FOUND',
        missing: stillMissing.map(m => m.productId),
      });
      return;
    }

    // Inventory check (allow backorder only when the store-level feature flag
    // AND the per-product flag are both enabled).
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      store.id,
      'inventory.backorder'
    );
    // A WhatsApp order line names a product, not a variant, so its available
    // quantity is the product's EFFECTIVE stock — the variant sum when it has
    // variants. Reading `product.inventory` here rejected every variant
    // product whose parent column had drifted (see lib/effective-inventory.ts).
    const oos = productItems
      .map(i => ({ item: i, product: byId.get(i.productId)! }))
      .filter(({ item, product }) => !isOrderable(product, item.quantity, backorderFeatureEnabled));

    // A bundle refusal joins the SAME `outOfStock` array/shape a product
    // does, so WBS's existing error handling (keyed on `outOfStock[]`)
    // needs no change to understand it. `available` reads 0 for a bundle
    // that fails `isPurchasable` (inactive/expired/zero stock) rather than
    // re-deriving purchasability here — `resolveBundle` already computed
    // it. A bundle whose remaining availability is merely less than the
    // requested quantity also lands here (never PRODUCTS_NOT_FOUND).
    const bundleOos = bundleLines
      .map(({ item, bundle }) => ({
        item,
        bundle,
        available: bundle.isPurchasable ? bundle.available : 0,
      }))
      .filter(({ item, available }) => item.quantity > available);

    if (oos.length > 0 || bundleOos.length > 0) {
      res.status(409).json({
        success: false,
        error: 'INSUFFICIENT_INVENTORY',
        outOfStock: [
          ...oos.map(({ item, product }) => ({
            productId: item.productId,
            requested: item.quantity,
            available: effectiveInventory(product),
            name: product.name,
          })),
          ...bundleOos.map(({ item, bundle, available }) => ({
            productId: item.productId,
            requested: item.quantity,
            available,
            name: bundle.name,
          })),
        ],
      });
      return;
    }

    // Build the cart payload that the checkout JWT carries.
    const cartItems = productItems.map(i => {
      const p = byId.get(i.productId)!;
      return {
        productId: i.productId,
        quantity: i.quantity,
        priceFils: p.price,
        name: p.name,
        nameAr: p.nameAr,
      };
    });
    // Bundle lines price at the BUNDLE price (`resolveBundle`'s
    // `computeBundlePrice` output — already the discounted total), NEVER
    // the component sum — same `priceFils * quantity` shape as `cartItems`
    // so `totalFils` below sums both uniformly.
    const cartBundles = bundleLines.map(({ item, bundle }) => ({
      bundleId: item.productId,
      quantity: item.quantity,
      priceFils: bundle.price,
      name: bundle.name,
      nameAr: bundle.nameAr,
    }));
    const totalFils =
      cartItems.reduce((sum, ci) => sum + ci.priceFils * ci.quantity, 0) +
      cartBundles.reduce((sum, cb) => sum + cb.priceFils * cb.quantity, 0);

    // Sign single-use checkout token. The storefront's checkout page
    // calls /cart/redeem with this token to hydrate the cart.
    const tokenPayload = {
      sub: 'wa-cart',
      storeId: store.id,
      storeSlug: store.slug,
      customerPhone,
      customerId: customerId || null,
      customerName: customerName || null,
      locale: locale || 'auto',
      waConversationId: waConversationId || null,
      items: cartItems,
      // Present ONLY when non-empty — an absent key so a store with no
      // bundle lines (including every store today) produces an
      // unchanged token payload; `WaTokenHydrator`/`wa-token.ts` on the
      // storefront treat a missing key exactly like the pre-bundle shape.
      ...(cartBundles.length > 0 ? { bundles: cartBundles } : {}),
      totalFils,
      currency: store.currency,
      // Phase C native catalog fields (passed through for downstream order creation)
      addressId: addressId || null,
      addressFreeform: addressFreeform || null,
      paymentMethod,
    };
    const checkoutToken = jwt.sign(tokenPayload, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: CHECKOUT_TOKEN_TTL_SECONDS,
      issuer: 'force-api',
      audience: 'force-wa-cart',
    });

    // Compute the storefront checkout URL. Per-store custom domain may
    // be set on the Store row; for now, fall back to slug-based URL.
    const storefrontBase = process.env.STOREFRONT_BASE_URL || BRAND_MARKETING_URL;
    const checkoutUrl = `${storefrontBase}/checkout?waToken=${encodeURIComponent(checkoutToken)}`;

    logger.info(
      {
        storeId: store.id,
        customerPhone: maskPhone(customerPhone),
        totalFils,
        items: items.length,
        paymentMethod,
        hasAddress: !!(addressId || addressFreeform),
      },
      '[wa-bridge] cart token issued'
    );

    // For cash orders, WBS needs an orderId in the response to confirm to the customer.
    // Phase C: token is issued in both cases; cash path returns checkoutUrl too so WBS
    // can use it as a fallback if needed. Full server-side order creation from the bot
    // (without storefront checkout redirect) is deferred to Phase D/E.
    // The `orderId` field in the response for cash = the JWT sub claim from checkoutToken
    // (used as a temp order reference until the storefront redeems + creates the real order).
    const tempOrderId = `wa-${checkoutToken.slice(-8)}`; // short unique handle for confirmation msg

    res.json({
      success: true,
      data: {
        checkoutUrl,
        checkoutToken,
        // Phase C additions: WBS uses these to send appropriate message to customer
        paymentUrl: paymentMethod === 'online' ? checkoutUrl : undefined,
        orderId: tempOrderId,
        paymentMethod,
        expiresAt: new Date(Date.now() + CHECKOUT_TOKEN_TTL_SECONDS * 1000).toISOString(),
        summary: {
          // Bundle quantities count toward itemCount too, same as a loose
          // product's quantity does.
          itemCount:
            productItems.reduce((s, i) => s + i.quantity, 0) +
            bundleLines.reduce((s, { item }) => s + item.quantity, 0),
          totalFils,
          currency: store.currency,
        },
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] cart from-wa failed');
    res.status(500).json({ success: false, error: 'CART_CREATE_FAILED' });
  }
});

// ─── POST /cart/redeem ───────────────────────────────────────────────────────
// Called by the Ebda storefront when the customer opens the checkout URL.
// Decodes the token + returns the cart payload to seed the checkout form.
// Single-use semantics: the token itself is sufficient (short TTL) — we
// don't persist a "redeemed" flag in v1. If single-use is later needed,
// add a Redis SET token marker on first redeem.
const redeemSchema = z.object({ token: z.string().min(20) });
router.post('/cart/redeem', async (req: Request, res: Response) => {
  try {
    const parse = redeemSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: 'INVALID_TOKEN' });
      return;
    }
    const { token } = parse.data;

    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'force-api',
      audience: 'force-wa-cart',
    }) as Record<string, unknown>;
    if (payload.sub !== 'wa-cart') {
      res.status(400).json({ success: false, error: 'WRONG_TOKEN_TYPE' });
      return;
    }

    // Cross-check the store still has the integration enabled. If a
    // merchant disconnected WBS between token issuance and redemption,
    // refuse — they don't want WA-originated traffic anymore.
    const store = await prisma.store.findUnique({
      where: { id: payload.storeId as string },
      select: { id: true, slug: true, wbsEnabled: true },
    });
    if (!store?.wbsEnabled) {
      res.status(403).json({ success: false, error: 'STORE_WBS_DISABLED' });
      return;
    }

    // Unauthenticated-by-key endpoint (the signed token is the credential), so it
    // needs its own feature check: waBridgeAuth does not run here.
    if (!(await isWhatsappEnabled(store.id))) {
      res.status(403).json(FEATURE_DISABLED_BODY);
      return;
    }

    res.json({ success: true, data: payload });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TokenExpiredError') {
      res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
      return;
    }
    if (name === 'JsonWebTokenError') {
      res.status(401).json({ success: false, error: 'TOKEN_INVALID' });
      return;
    }
    logger.error({ err: (err as Error).message }, '[wa-bridge] redeem failed');
    res.status(500).json({ success: false, error: 'REDEEM_FAILED' });
  }
});

// ─── POST /templates/status ──────────────────────────────────────────────────
// Phase 7 store-driven template sync: WBS calls back here when Meta's
// message_template_status_update webhook arrives for a template that
// originated from an store-driven submission. Idempotent — same status
// arriving twice (Meta sometimes redelivers) just refreshes the row.

const templateStatusSchema = z.object({
  fwbStoreId: z.string().min(1),
  sourceKey: z.string().nullable().optional(),
  templateName: z.string().min(1),
  language: z.string().min(1),
  status: z.enum(['draft', 'pending', 'approved', 'rejected', 'paused', 'disabled']),
  rejectionReason: z.string().nullable().optional(),
  metaTemplateId: z.string().nullable().optional(),
});

router.post('/templates/status', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const parsed = templateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'INVALID_BODY' });
      return;
    }
    const {
      fwbStoreId,
      sourceKey,
      language,
      status,
      rejectionReason,
      metaTemplateId,
      templateName,
    } = parsed.data;

    // Bridge-store auth contract: the X-WBS-API-KEY middleware already mapped
    // the caller to a store. Refuse if the body's fwbStoreId disagrees —
    // that would indicate a forged callback from a different merchant's WBS
    // integration trying to mutate this merchant's templates.
    if (req.bridgeStore!.id !== fwbStoreId) {
      logger.warn(
        { authStoreId: req.bridgeStore!.id, bodyStoreId: fwbStoreId, templateName },
        '[wa-bridge] templates/status: store mismatch — refusing'
      );
      res.status(403).json({ success: false, error: 'STORE_MISMATCH' });
      return;
    }

    // sourceKey is mandatory for the upsert path; if WBS didn't include it
    // we can't route to a specific row.
    if (!sourceKey) {
      logger.info(
        { templateName, language, status },
        '[wa-bridge] templates/status: no sourceKey — recording but skipping upsert'
      );
      res.json({ success: true, recorded: false });
      return;
    }

    const existing = await prisma.whatsAppTemplate.findUnique({
      where: {
        storeId_sourceKey_language: {
          storeId: fwbStoreId,
          sourceKey,
          language,
        },
      },
      select: { id: true },
    });

    if (!existing) {
      // Status arrived for a template we don't have a local row for — log
      // and continue. Could be a template submitted directly via the WBS
      // admin (not store-driven) or a stale callback from a deleted store.
      logger.info(
        { fwbStoreId, sourceKey, language, status },
        '[wa-bridge] templates/status: no matching local row — ignored'
      );
      res.json({ success: true, recorded: false });
      return;
    }

    await prisma.whatsAppTemplate.update({
      where: { id: existing.id, storeId: fwbStoreId },
      data: {
        status,
        rejectionReason: status === 'rejected' ? rejectionReason || null : null,
        metaTemplateId: metaTemplateId || undefined,
        lastSyncedAt: new Date(),
      },
    });

    logger.info(
      { fwbStoreId, sourceKey, language, status },
      '[wa-bridge] templates/status: row updated'
    );
    res.json({ success: true, recorded: true });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] templates/status failed');
    res.status(500).json({ success: false, error: 'STATUS_CALLBACK_FAILED' });
  }
});

// ─── GET /store/service-menu?storeId= ───────────────────────────────────────
// Returns the merchant's bot service menu config (or defaults if not configured).
// WBS reads this on every 5-min catalog refresh + caches in Redis.
router.get('/store/service-menu', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    // IDOR fix: scope to the AUTHENTICATED bridge store, never a query storeId
    // (a connected merchant could otherwise read any store's service menu).
    const storeId = req.bridgeStore!.id;
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { botServiceMenu: true },
    });
    if (!store) {
      res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
      return;
    }
    const serviceMenu = store.botServiceMenu ?? DEFAULT_SERVICE_MENU;
    res.status(200).json({ success: true, data: { serviceMenu } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] store/service-menu GET failed');
    res.status(500).json({ success: false, error: { code: 'SERVICE_MENU_FETCH_FAILED' } });
  }
});

// ─── GET /store/meta-catalog-config?storeId= ────────────────────────────────
// Returns catalogId + businessId + hasToken (boolean). NEVER returns the token plain.
router.get('/store/meta-catalog-config', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    // IDOR fix: scope to the AUTHENTICATED bridge store, never a query storeId
    // (a connected merchant could otherwise read any store's catalog config).
    const storeId = req.bridgeStore!.id;
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        metaCatalogId: true,
        metaBusinessId: true,
        credentials: { select: { metaAccessToken: true } },
      },
    });
    if (!store) {
      res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
      return;
    }
    res.status(200).json({
      success: true,
      data: {
        catalogId: store.metaCatalogId ?? null,
        businessId: store.metaBusinessId ?? null,
        // Never return the encrypted token — WBS reads it server-to-server via
        // the inngest-receiver which uses the token stored on the client row.
        hasToken: Boolean(store.credentials?.metaAccessToken),
      },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      '[wa-bridge] store/meta-catalog-config GET failed'
    );
    res.status(500).json({ success: false, error: { code: 'CATALOG_CONFIG_FETCH_FAILED' } });
  }
});

// ─── POST /store/meta-catalog-config ────────────────────────────────────────
// Saves catalog ID + business ID + encrypted access token.
// Called from Ebda admin (Bot Config tab) when merchant saves the Meta IDs.
const metaCatalogConfigSchema = z.object({
  storeId: z.string().min(1),
  catalogId: z.string().min(1).optional(),
  businessId: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
});

router.post('/store/meta-catalog-config', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const parse = metaCatalogConfigSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: { code: 'INVALID_BODY' } });
      return;
    }
    const { storeId: bodyStoreId, catalogId, businessId, accessToken } = parse.data;
    // The tenant is the authenticated bridge store, never the body — a body
    // storeId for a different tenant is rejected outright (no silent override).
    const storeId = req.bridgeStore!.id;
    if (bodyStoreId !== storeId) {
      res.status(403).json({ success: false, error: { code: 'STORE_MISMATCH' } });
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (catalogId !== undefined) updateData.metaCatalogId = catalogId;
    if (businessId !== undefined) updateData.metaBusinessId = businessId;
    // Encrypt the token at the boundary — never store plaintext
    if (accessToken !== undefined) {
      const metaAccessToken = encryption.encrypt(accessToken);
      updateData.credentials = {
        upsert: { create: { metaAccessToken }, update: { metaAccessToken } },
      };
    }

    await prisma.store.update({
      where: { id: storeId },
      data: updateData,
    });

    logger.info(
      { storeId, hasCatalogId: Boolean(catalogId) },
      '[wa-bridge] meta-catalog-config saved'
    );
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      '[wa-bridge] store/meta-catalog-config POST failed'
    );
    res.status(500).json({ success: false, error: { code: 'CATALOG_CONFIG_SAVE_FAILED' } });
  }
});

// ─── GET /customer-addresses?customerId= ────────────────────────────────────
// Returns saved delivery addresses for a customer, default first.
// Called by the WBS bot during checkout to offer the customer's saved addresses.
router.get('/customer-addresses', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const customerId = req.query.customerId as string | undefined;
    if (!customerId) {
      res.status(400).json({ success: false, error: { code: 'CUSTOMER_ID_REQUIRED' } });
      return;
    }
    const addresses = await addressSvc.listForCustomer(customerId, req.bridgeStore!.id);
    res.status(200).json({ success: true, data: { addresses } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] customer-addresses GET failed');
    res.status(500).json({ success: false, error: { code: 'ADDRESS_FETCH_FAILED' } });
  }
});

// ─── POST /customer-addresses ────────────────────────────────────────────────
// Creates a new delivery address for a customer.
// Body: { customerId, street, area, block?, governorate?, buildingNumber?, label?, notes? }
// The first address created is automatically marked isDefault=true.
router.post('/customer-addresses', waBridgeAuth, async (req: Request, res: Response) => {
  try {
    const { customerId, street, area, block, governorate, buildingNumber, label, notes } =
      req.body ?? {};
    if (!customerId || !street || !area) {
      res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS' } });
      return;
    }
    const address = await addressSvc.createForCustomer(customerId, req.bridgeStore!.id, {
      street,
      area,
      block,
      governorate,
      buildingNumber,
      label,
      notes,
    });
    if (!address) {
      res.status(404).json({ success: false, error: { code: 'CUSTOMER_NOT_FOUND' } });
      return;
    }
    res.status(201).json({ success: true, data: { address } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] customer-addresses POST failed');
    res.status(500).json({ success: false, error: { code: 'ADDRESS_CREATE_FAILED' } });
  }
});

export default router;
