import { redeemWaCheckout } from '../lib/wa/bridge/redeem';
import { Router, Request, Response, NextFunction } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod/v3';
import { ProductService } from '../services/product.service';
import { SizeChartService } from '../services/size-chart.service';
import { CartService } from '../services/cart.service';
import { OrderService } from '../services/order.service';
import { redactOrderForCustomer, maskGuestOrderView } from '../services/gold-rate/public';
import { signOrderViewToken, requestHoldsOrderViewToken } from '../lib/order-view-token';
import { CustomerReorderService } from '../services/customer-reorder.service';
import { InvoiceService } from '../services/invoice.service';
import { EmailService } from '../services/email.service';
import { prisma, SlugEntityType, withStore } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { withStoreRead } from '../lib/store-read';
import { storeDb, storeRepo, storeWriter } from '../lib/repo-factory';
import { inDoStoreScope, readInStoreContext } from '../lib/store-scoped-read';
import { resolveSlugRedirectCached } from '../services/slug-redirect.service';
import { recordQrScan, resolveQrScan } from '../services/qr.service';
import { AppError } from '../middleware/error-handler';
import {
  authenticate,
  optionalAuthenticate,
  customerUserId,
  rejectImpersonated,
} from '../middleware/auth';
import { buyerFromRequest } from '../lib/buyer-identity';
import { requireFeature } from '../middleware/feature-gate';
import {
  publicLimiter,
  publicTenantLimiter,
  storeResolveLimiter,
  storeMissLimiter,
  publicSearchLimiter,
  whenSearching,
  cartLimiter,
  writeLimiter,
  couponAttemptLimiter,
  newsletterLimiter,
  whatsappConsentStoreLimiter,
  whatsappConsentUserLimiter,
  auditLog,
  viewIngestLimiter,
} from '../middleware/security';
import { refuseUnknownPublicStore } from '../middleware/tenant-context';
import { catalogueMissRoute } from '../middleware/catalogue-miss';
import {
  queryBudgetSpent,
  queryBudgetSpentUntil,
  searcherFromIp,
} from '../lib/search/embed-budget';
import { semanticSearchEnabled } from '../lib/search/embedding-provider';
import { recordProductView } from '../services/view-ingest.service';
import { claimSearcherSearch, recordSearch } from '../services/search-log.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { getStoreIdFromRequest } from '../utils/store-helpers';
import { assertNotDemoStore } from '../services/plan-limit.service';
import logger from '../lib/logger';
import { featureService } from '../services/feature.service';
import { gateBackorderPayload } from '../lib/effective-inventory';
import { notificationDispatcher } from '../services/notification-dispatcher.service';
import {
  recordCartEmailConsent,
  restoreCartIntoSession,
  cartEmailOptInAvailable,
} from '../services/cart-email-optin.service';
import { isWhatsAppLinked } from '../lib/wa/link';
import { createWhatsAppOptInHandlers, createWhatsAppOptInStateHandlers } from './whatsapp-optin';
import { WhatsAppConsentService } from '../lib/wa/consent';
import {
  boundedCacheKey,
  getCached,
  invalidateStoreProductCachesAfterOrder,
} from '../lib/public-cache';
import { storeLookupForHost } from '../lib/store-host';
import { lookupStore, publicStorePage, type StoreStatusName } from '../lib/definer';
import { lookupStoreCached } from '../lib/store-directory';
import { redis } from '../services/redis.service';
import { previewTokenKey } from '../lib/builder-preview-token';
import {
  isReservedSlug,
  storefrontOrigin,
  CONTACT_HONEYPOT_FIELD,
  normalizeArabicSearch,
  normalizeLegacyTemplate,
  deliveryLineFromNotes,
} from '@ebda/shared';
import {
  assertScalarQuery,
  parseOptionalBooleanQuery,
  parseOptionalSortQuery,
  assertOnSaleQuery,
  PUBLIC_PRODUCT_LIST_QUERY_KEYS,
} from '../lib/query-params';
import { setEdgeCache, setBuyerPrivate } from '../lib/edge-cache';
import { searchQueryFromHeader } from '../lib/search-term';
import { buildProductFeed } from '../lib/product-feed';
import {
  listSellableBundles,
  describeBundleContents,
  withinSaleWindow,
  nextSaleWindowBoundarySeconds,
} from '../services/bundle.service';
import { stripMarketingPixelSecrets } from '../lib/marketing-pixels-secrets';
import { effectiveTaxFields, resolveActiveTaxRate } from '../lib/order-tax';
import { publicStoreSettings } from '../lib/public-store-settings';
import { verifyReviewToken } from '../lib/review-token';
import { inngest } from '../lib/inngest/client';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { confirmPaymentFromProviderStatus } from '../services/payment-confirm.service';
import type { PaymentProvider } from '../services/payment-providers/types';

import { WISHLIST_CARD_VARIANTS_SELECT, wishlistCardProduct } from '../lib/wishlist-card';
import { inParallel } from '../lib/run-in-parallel';
import { publicReadLimit } from '../middleware/public-read-limit';
import { countStoreMiss, storeResolveLimit } from '../middleware/store-resolve-native';
import { prefetchPublicLimits } from '../middleware/public-limit-prefetch';
/**
 * The guest view token for a just-created order, or undefined when it cannot be signed. The order
 * is already committed at this point: a missing signing key must degrade to the masked order view,
 * never turn a placed order into a 500 (SEC-15).
 */
function guestViewTokenFor(orderId: string): string | undefined {
  try {
    return signOrderViewToken(orderId);
  } catch (err) {
    logger.error({ err, orderId }, '[public.orders] could not sign the guest order view token');
    return undefined;
  }
}

const router = Router();

// Apply public rate limiter to all routes — per-IP first, then the
// per-tenant aggregate backstop (see publicTenantLimiter's comment).
// Both counters are independent keyed counters behind a Durable Object hop each; they run
// together (one round trip, not two). Both still count every request and either can answer 429.
// PERF-RL-DO: every limiter hit below is sent first, batched per shard (one round trip); the limiters take their results.
router.use(prefetchPublicLimits);
router.use(publicReadLimit(inParallel(publicLimiter, publicTenantLimiter)));
// LAUNCH-RL: unknown-store 404s only (random slug/host probing), then search/typeahead per IP.
router.use(storeMissLimiter);
// An unknown store id in the path is refused HERE, behind the limiters above, not in `publicStoreContext` in front of them.
router.use(refuseUnknownPublicStore);
router.use('/products', whenSearching(publicSearchLimiter));
router.use('/:storeId/search/suggest', publicSearchLimiter);

// GET /health - Health check endpoint
router.get('/health', async (_req: Request, res: Response) => {
  try {
    // Test database connection
    // A deployed Worker has no Postgres to ping: the platform D1 is the database it stands on (NEON-ZERO-1).
    const d1 = (
      cfBindings() as
        | { PLATFORM_DB?: { prepare(q: string): { first(): Promise<unknown> } } }
        | undefined
    )?.PLATFORM_DB;
    if (d1) await d1.prepare('SELECT 1').first();
    else await prisma.$queryRaw`SELECT 1`;

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
  // Personalisation text. 400 before cleaning; cleanNote caps the stored text at 200.
  note: z.string().max(400).optional(),
});

const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1),
});

// The storefront (apps/web) is a merchant-custom-domain origin, so it can
// only ever call `/public/*` — `restrictPlatformOnlyOrigins` (security.ts)
// blocks a merchant origin from `/stores/:storeId/*` in production (see
// tests/unit/platform-only-origins.test.ts). Task 5 added the bundle cart
// mutation routes ONLY under `/stores/:storeId/cart/bundles[/:id]`
// (cart.routes.ts) — an admin-space path the storefront cannot reach at
// all outside local dev. These two mirror them here, under `/public/cart`,
// exactly like every other cart route in this file.
const addBundleToCartSchema = z.object({
  bundleId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1000).default(1),
});

// Egypt-friendly address schema: see notes in order.routes.ts. State and
// postalCode are optional (Egypt has no postal codes for delivery and the
// "state" field is repurposed to hold the selected delivery area). We trim
// whitespace on required fields so a stray space doesn't trip min(1), and we
// add generous max lengths to bound abuse without rejecting normal Arabic or
// English input.
export const shippingAddressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  address1: z.string().trim().min(1).max(500),
  address2: z.string().max(500).optional(),
  // City is NOT required: the locality is the governorate + area/district, which
  // the storefront sends in `area`/`state`. The checkout form always sends
  // city:'' (Egypt model), so requiring it here 400'd EVERY order
  // ("خطأ في الدفع" → bounce back to the info step). Accept empty.
  city: z.string().trim().max(150).optional().default(''),
  // Governorate (محافظة) — one of the 27 Egyptian governorates (REGION.governorates,
  // e.g. Cairo, Giza, Alexandria). Explicit field added 2026-06-18
  // alongside sub-area; legacy orders used `state` or `area` for this concept.
  governorate: z.string().max(60).optional().default(''),
  governorateAr: z.string().max(60).optional().default(''),
  // Sub-area / district (منطقة) within the governorate, e.g. Maadi, Nasr City.
  // The shipping-fee calculator matches on this value first, then falls back to governorate.
  area: z.string().max(150).optional().default(''),
  areaAr: z.string().max(150).optional().default(''),
  state: z.string().max(150).optional().default(''),
  postalCode: z.string().max(30).optional().default(''),
  // Structured Egyptian delivery details (also folded into address1 by the
  // storefront for display back-compat). Optional so older clients still pass.
  street: z.string().max(200).optional(),
  building: z.string().max(100).optional(),
  floor: z.string().max(50).optional(),
  apartment: z.string().max(50).optional(),
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
  /**
   * The delivery date (store-local `YYYY-MM-DD`) and window the shopper picked, for a store with
   * `checkoutDelivery.daysAhead` (Ruling B4-7). A REQUEST: the server recomputes the offered set
   * from live settings and refuses anything else (422 DELIVERY_SLOT_UNAVAILABLE), then writes the
   * delivery line of the notes itself. Ignored by a store without `daysAhead`.
   */
  deliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  deliveryWindowId: z.string().min(1).max(80).optional(),
  couponCode: z.string().trim().min(1).max(50).optional(),
  /** Loyalty points the customer requests to redeem. A request, not a
   *  trusted discount — the server re-resolves it against the customer's
   *  real balance + store caps. Ignored for guests. Bounded to a sane
   *  integer ceiling so a malformed value can't overflow the math. */
  pointsToRedeem: z.number().int().min(0).max(100_000_000).optional(),
  /** Pay from the customer wallet (D1). A request: the server spends
   *  min(balance, total) only when the store's wallet checkout is available.
   *  Ignored for guests. */
  useWallet: z.boolean().optional(),
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
  /** The total (piastres) the shopper last saw: compared to the server-resolved total, never used to charge. */
  expectedTotal: z.number().int().min(0).optional(),
});

// GET /products - List all public products (cached 30s)
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, category, tag, featured, sort, minPrice, maxPrice, cursor, ids } =
      req.query;
    // Scalars only (M1): an array or `?x[op]=…` object is a 400, never a Prisma operator or a 500.
    assertScalarQuery(req.query, PUBLIC_PRODUCT_LIST_QUERY_KEYS, ['opt_']);
    // The shopper's term travels in the `X-Search-Query` header (percent-encoded), not the URL: a
    // typed phone or email in a URL is retained in Cloudflare Workers Logs (Ruling SEARCH-URL-1,
    // closing SEARCH-T5-8 for the storefront). The `?search=` form stays accepted for one release
    // for already-deployed storefront bundles, then is removed.
    const headerTerm = searchQueryFromHeader(req);
    const search = headerTerm ?? req.query.search;
    const storeId = await getStoreIdFromRequest(req);
    // Tri-state: absent -> undefined (no filter). `featured === 'true'` used
    // to turn an absent param into `featured: false`, which listPublic applied
    // as `WHERE featured = false` on every non-"Featured" listing.
    const featuredFilter = parseOptionalBooleanQuery(featured, 'featured');

    // Search floor + length cap (adversarial audit P1-3, mirrors the >= 2
    // floor on /:storeId/search/suggest below). The raw term used to pass
    // straight into an unbounded leading-wildcard ILIKE over 4 TEXT columns
    // AND into the cache key — so unique sub-floor terms ('a', 'aa', 'qx'…)
    // bypassed every cache layer and ran a fresh scan per request. A term
    // under the floor short-circuits to an empty page with NO DB or cache
    // touch; longer terms are capped at 100 chars (token count is capped at 8
    // in searchTokens, @ebda/shared) so a crafted query cannot expand into
    // hundreds of LIKE clauses (product-search.service).
    const rawSearch = typeof search === 'string' ? search.trim() : '';
    if (rawSearch.length === 1) {
      const floorPage = page ? parseInt(page as string) || 1 : 1;
      const floorLimit = Math.min(100, Math.max(1, (limit ? parseInt(limit as string) : 20) || 20));
      res.json({
        success: true,
        data: {
          products: [],
          meta: { page: floorPage, limit: floorLimit, total: 0, totalPages: 0 },
        },
      });
      return;
    }
    const effectiveSearch = rawSearch.length >= 2 ? rawSearch.slice(0, 100) : undefined;

    // `relevance` (Task 12) = the hybrid order of a search; the service treats it as no sort
    // whenever semantic search is off or there is no search term. An unknown value is a 400, and
    // `on_sale` refuses the params it cannot honour (assertOnSaleQuery).
    const sortValue = parseOptionalSortQuery(sort);
    if (sortValue === 'on_sale') assertOnSaleQuery(req.query);

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
      }
    }
    const hasOptionFilters = Object.keys(optionFilters).length > 0;

    // The EXACT options the service receives (ids sorted: their order never changes the result).
    const listOptions: Parameters<typeof ProductService.listPublic>[1] = {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      category: category as string,
      // Tag NAME (Ruling B3-5); capped at the column's practical length so a crafted value cannot
      // mint cache keys of unbounded size.
      tag: typeof tag === 'string' && tag.trim() ? tag.trim().slice(0, 120) : undefined,
      search: effectiveSearch,
      featured: featuredFilter,
      sort: sortValue,
      minPrice: minPrice ? parseInt(minPrice as string, 10) : undefined,
      maxPrice: maxPrice ? parseInt(maxPrice as string, 10) : undefined,
      cursor: validCursor,
      ids: idsParam?.sort(),
      optionFilters: hasOptionFilters ? optionFilters : undefined,
    };
    // `on_sale` is a short merchandising row: it ignores page and cursor and caps the limit, so
    // none of them is in its key (a crafted ?page=N, or a negative limit, cannot mint a fresh SQL
    // run + cache entry per value); category and ids are honoured and stay in the key.
    if (sortValue === 'on_sale') {
      listOptions.page = undefined;
      listOptions.cursor = undefined;
      listOptions.limit = Math.min(Math.max(1, parseInt(limit as string, 10) || 12), 12);
    }
    // Cache key (Ruling SEARCH-T12-7) = the store + a JSON encoding of exactly those options + the
    // semantic-search mode. JSON quotes every value, so no value can borrow a delimiter: the old
    // `a:b:…;name=v,v;` join let `?category=x:y&search=z` and `?category=x&search=y:z` (or
    // `opt_A=1;B=2` and `opt_A=1&opt_B=2`) share one entry, i.e. one URL could fill another's
    // cache. The response does not vary by locale (both name and nameAr are returned), so locale
    // is not part of it. CACHE CLASS: BOUNDED-stale 120 s, busted by invalidateStoreProductCaches
    // on every product write (prefix `public:products:<storeId>:` kept). A DEGRADED hybrid list
    // (the vector leg was wanted but unavailable) is never cached under any key (`cacheIf`).
    // The semantic MODE a search runs in (absent for a list without a search: it never ranks, so a
    // mode change must not cold-start every list): off, on, or budget-spent (a daily embed budget
    // is spent until the next Cairo day, SEARCH-T12-10: keyword-only is that mode's full answer).
    const semanticMode = !effectiveSearch
      ? undefined
      : !semanticSearchEnabled()
        ? 'off'
        : queryBudgetSpent(storeId)
          ? 'budget-spent'
          : 'on';
    // Long keys (a 100-char Arabic term + option filters) are hashed under the same prefix so they
    // still fit Workers KV's 512-byte limit and still get busted (`boundedCacheKey`, review M7).
    const cacheKey = boundedCacheKey(
      `public:products:${storeId}:`,
      JSON.stringify({ ...listOptions, semantic: semanticMode })
    );

    const result = await getCached(
      cacheKey,
      120,
      () =>
        readInStoreContext(storeId, () =>
          ProductService.listPublic(storeId, {
            ...listOptions,
            // The query-embed limit is charged inside the service at the provider call (SEARCH-T12-6).
            searcher: searcherFromIp(req.ip),
          })
        ),
      {
        // Never cache a degraded list (transient: race lost, provider/SQL error, searcher limit, or
        // the request that DISCOVERS a spent budget, whose key still says `on`). A budget-spent list
        // is cached for 120 s only while 120 s remain before the next Cairo day (TTL floor), so no
        // entry outlives the budget reset.
        cacheIf: r =>
          (r as { meta?: { degraded?: boolean } }).meta?.degraded !== true &&
          (semanticMode !== 'budget-spent' ||
            queryBudgetSpentUntil(storeId) - Date.now() >= 120_000),
      }
    );
    const ranked = (result as { meta?: { ranked?: boolean } }).meta?.ranked === true;

    // First-party search log (search program P0, Task 5): page 1 of a real query only, so
    // paging does not double count; typeahead (/search/suggest) is not logged (keystrokes,
    // Ruling SEARCH-6). Counted after the request transaction commits, in its own tenant
    // transaction (E2), fail-open. A getCached hit is still counted: it counts searches, not
    // DB reads. No identity is stored and personal-data-shaped terms are dropped.
    if (effectiveSearch && (!page || page === '1') && !validCursor) {
      const total = (result as { meta?: { total?: number } }).meta?.total ?? 0;
      // The FULL raw term: the log folds it, checks it whole for personal data, and only then
      // cuts it to 100 characters (a phone past char 100 is caught, not half-stored).
      // Distinct searchers (Ruling SEARCH-T5-6): a sort/category change or a retry re-fetches
      // page 1; the same searcher counts a term once per window (salted daily HMAC of IP+UA,
      // kept only as a short-lived Redis key; fail-open counts once).
      const searcher = { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') };
      void deferAfterTenantCommit('search-log', async () =>
        (await claimSearcherSearch(storeId, rawSearch, searcher))
          ? recordSearch(storeId, rawSearch, total)
          : false
      );
    }

    // Edge-cacheable: product list is identical for all anonymous
    // visitors of the same store. Per-tenant via the default Vary on
    // x-store-id; per-locale because the storefront ?lang= query
    // surfaces in the URL, so it's already in the cache key without
    // needing Accept-Language Vary.
    // The store's backorder feature is applied AFTER the cache read (an
    // entitlement never rides the cached payload — the product_3d precedent).
    // CACHE CLASS (Ruling FU46-W1b-6): the backorder gate is per request, but the
    // edge copy below is not — after the store's `inventory.backorder` feature flips,
    // an edge-cached listing/PDP can show the old pre-order state for up to
    // sMaxAge 60s + staleWhileRevalidate 300s. BOUNDED-stale by design: the cart and
    // checkout re-read the feature uncached (lineAllowsBackorder) and stay authoritative.
    // Per request and uncached by us (FeatureService has its own cache): read in its own scope so a
    // route that opens no request transaction (Ruling LAZY-TX-1) never touches the DB unscoped.
    const backorderOn = await readInStoreContext(storeId, () =>
      featureService.isFeatureEnabled(storeId, 'inventory.backorder')
    );
    // A hybrid-ranked list (semantic search on) depends on the mode and on the provider's health at
    // that moment, which no edge key can see: never shared-cacheable (SEARCH-T12-7). Every other
    // list keeps the edge policy unchanged.
    // A header-borne term is not part of the URL, and Cloudflare's cache key ignores `Vary`
    // (edge-cache.ts), so a shared cache would serve one shopper's results to another term:
    // never shared-cacheable (Ruling SEARCH-URL-1). `Vary` is set for any cache that honours it.
    if (headerTerm !== undefined) res.vary('X-Search-Query');
    if (ranked || headerTerm !== undefined) res.setHeader('Cache-Control', 'private, no-store');
    else setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300, neverStale: true });
    res.json({
      success: true,
      data: gateBackorderPayload(result, backorderOn),
    });
  } catch (error) {
    next(error);
  }
});

// GET /products/:slugOrId - Get a product by slug or ID
// LAUNCH-RL-MISS-3: its 404 inside a verified store is a dead link, not a store-miss (middleware/catalogue-miss.ts).
router.get('/products/:slugOrId', catalogueMissRoute('GET /public/products/:slugOrId'));
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
          readInStoreContext(storeId, () =>
            isUuid
              ? ProductService.getPublicById(storeId, slugOrId)
              : ProductService.getPublicBySlug(storeId, slugOrId)
          )
        );

    // `product_3d` (every plan; a super-admin override can switch it off per
    // store) is checked AFTER the Redis read, so the cached product never
    // decides an entitlement — FeatureService's own cache is busted on every
    // override write. Residual: the edge cache below, same as every field.
    const payload =
      product && (product as { model3d?: unknown }).model3d
        ? (await readInStoreContext(storeId, () =>
            featureService.isFeatureEnabled(storeId, 'product_3d')
          ))
          ? product
          : { ...product, model3d: null }
        : product;

    // Backorder feature after the cache read, like product_3d above (X-02 fix round).
    // CACHE CLASS (Ruling FU46-W1b-6): the backorder gate is per request, but the
    // edge copy below is not — after the store's `inventory.backorder` feature flips,
    // an edge-cached listing/PDP can show the old pre-order state for up to
    // sMaxAge 60s + staleWhileRevalidate 300s. BOUNDED-stale by design: the cart and
    // checkout re-read the feature uncached (lineAllowsBackorder) and stay authoritative.
    const backorderOn = await readInStoreContext(storeId, () =>
      featureService.isFeatureEnabled(storeId, 'inventory.backorder')
    );
    setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300, neverStale: true });
    res.json({
      success: true,
      data: { product: gateBackorderPayload(payload, backorderOn) },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /public/size-charts — every size chart of the resolved store, for the storefront
 * `/size-guide` page (B0 Task 9). The PDP gets its own resolved chart inside the product payload.
 * CACHE CLASS: BOUNDED-stale display content. No Redis layer: one indexed query, fronted by the
 * storefront's `products:<store>` data-cache tag, which every chart write purges through
 * invalidateStoreProductCaches; the 60s edge cache is the same residual as the PDP.
 */
router.get('/size-charts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = await getStoreIdFromRequest(req);
    const sizeCharts = await readInStoreContext(storeId, () =>
      SizeChartService.listPublic(storeId)
    );
    setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300 });
    res.json({ success: true, data: { sizeCharts } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /public/feed/products.json — AI Product Feed (agent_feed; all paid plans).
 * Fail-closed: 404 when the feature is not enabled for the store, so the
 * URL does not reveal the add-on's existence on stores that didn't buy it.
 * Response is the raw feed JSON (no {success,data} envelope) — this is a
 * public, machine-readable document consumed directly by AI shopping
 * agents, not an internal API response.
 */
router.get('/feed/products.json', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = await getStoreIdFromRequest(req);
    const enabled = await featureService.isFeatureEnabled(storeId, 'agent_feed');
    if (!enabled) {
      throw new AppError(404, 'NOT_FOUND', 'Not found');
    }
    const store = await (
      await storeDb(storeId)
    ).store.findUniqueOrThrow({
      where: { id: storeId },
      select: { id: true, name: true, slug: true, currency: true, domain: true },
    });
    // P1-2 — feed poisoning. `baseUrl` used to fall back to
    // `req.get('x-original-host') ?? req.get('host')`, and NOTHING in the chain
    // strips inbound headers (`trust proxy` is a hop COUNT, not a filter). An
    // attacker-supplied `X-Original-Host` therefore landed in every `link` of a
    // feed built for whichever store `X-Store-ID`/`x-store-domain` named, then
    // sat in Redis for 600s (the cache key has no host in it) AND at the CDN —
    // so ONE request poisoned every subsequent agent's product links.
    //
    // The fallback is now the same derivation `order.tools.ts`'s
    // `storefrontBaseUrl` and `payment.routes.ts` already use — custom domain
    // wins, else the store's own `<slug>.ebda.app` origin (`storefrontOrigin`).
    // This is also a live BUG fix, not only a hardening: `apps/web` never
    // forwards `x-original-host` to the API (its feed passthrough sends only
    // `x-store-domain`/`X-Store-ID`, and `apps/web/middleware.ts` sets that
    // header on the web app's OWN inbound request headers, which never leave
    // it), so a platform-hosted store's feed was falling through to
    // `req.get('host')` = the API host and emitting `https://api.../products/<slug>`
    // links that point at the API, not the storefront. No request-supplied
    // header can influence the output any more.
    //
    // Cache tail after deploy: the old value survives in
    // `public:products:<storeId>:feed:v2` (v1 before issue 2327) for up to 600s and at the CDN for
    // 600s + 86400s stale-while-revalidate. "Fixed" and "visible" are not the
    // same instant.
    const baseUrl = storefrontOrigin(store);
    // `bundles` is in NO plan baseline (super-admin override only) — a
    // store without it must see this feed completely unchanged, so the
    // bundle listing query below is skipped entirely rather than run and
    // discarded. Checked alongside `agent_feed` so both flags are read in
    // one round trip (featureService coalesces concurrent per-store reads).
    const bundlesEnabled = await featureService.isFeatureEnabled(storeId, 'bundles');
    // Cache key under public:products:<storeId>:* so invalidateStoreProductCaches busts it on product writes.
    //
    // v2 (issues 2327 / 2328): the cached value holds the feed's INPUTS with
    // each bundle's sale window, not the built feed. A window boundary is not
    // a write and busts no cache, so the window is applied per request below
    // and the edge lifetime is capped at the next boundary. A v1 entry (a
    // built feed) must be a miss for the v2 reader.
    const inputs = await getCached(`public:products:${storeId}:feed:v2`, 600, async () => {
      // listPublic() internally caps limit at 100 (Math.min(100, ...)) — the
      // feed is bounded to a store's first 100 active products until a
      // dedicated paginated/full-catalog feed path is built.
      //
      // Deliberately omit `sort` here: passing sort: 'newest' would filter
      // to where.isNew = true (the "New Arrivals" carousel flag), silently
      // excluding the rest of the catalog from the feed. No `sort` uses the
      // service default (createdAt desc across ALL active products), which
      // is what an AI product feed needs.
      const { products } = await ProductService.listPublic(storeId, {
        status: 'active',
        limit: 100,
      });
      // Task 10: bundles appear as sibling feed entries (see
      // buildProductFeed's `is_bundle` field) so AI shopping agents can
      // recommend them — only when purchasable, and only for a store with
      // the override. Empty array when disabled reproduces the pre-Task-10
      // feed byte-for-byte (buildProductFeed's `bundles` param defaults to
      // `[]` too — the explicit `[]` here just makes the branch visible).
      const bundles = bundlesEnabled
        ? (
            await listSellableBundles((await storeDb(storeId)) as unknown as typeof prisma, storeId)
          ).map(b => {
            const { description, descriptionAr } = describeBundleContents(b);
            return { ...b, description, descriptionAr };
          })
        : [];
      // Ruling B5-21 (item 9): does this store sell gold-rate products? Cached WITH the feed inputs (same
      // key, same purge), so a rate write that clears this key also re-reads the flag.
      const hasGold =
        (await (
          await storeDb(storeId)
        ).product.count({
          where: {
            storeId,
            status: 'active',
            audience: 'public',
            pricingMode: 'gold_rate',
            deletedAt: null,
          },
          take: 1,
        })) > 0;
      return { products, bundles, hasGold };
    });
    const now = new Date();
    const live = inputs.bundles.filter(b => withinSaleWindow(b, now));
    // Same backorder gate as the storefront (X-02 fix round): availability in the
    // AI feed must agree with what the cart accepts.
    // CACHE CLASS (Ruling FU46-W1b-6): the gated feed rides its own edge window (set
    // below); an AI agent can read the old pre-order state until it expires.
    // BOUNDED-stale: a cart built from it is re-checked by the cart and checkout.
    const backorderOn = await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
    const feed = buildProductFeed(
      store,
      gateBackorderPayload(inputs.products, backorderOn),
      baseUrl,
      live
    );
    // Never let the edge serve this body past the next window boundary: the
    // fresh window AND the stale-while-revalidate tail both end before it.
    const nextBoundarySec = nextSaleWindowBoundarySeconds(inputs.bundles, now);
    // Ruling B5-21 (item 9), the one documented BOUNDED-stale residual of gold pricing: this feed is held
    // by third-party caches (crawlers, shopping feeds, the CDN) that a rate write cannot purge. For a
    // store that sells gold-rate products the window is at most 60 s and there is NO stale-while-revalidate
    // tail, so a shopping feed can show the previous price for up to a minute. Checkout re-prices from the
    // database and shows "السعر اتحدّث", so no one is charged it. `X-Gold-Pricing` tells the storefront's
    // feed passthrough to apply the same window.
    if (inputs.hasGold) {
      res.setHeader('X-Gold-Pricing', '1');
      setEdgeCache(res, {
        sMaxAge: Math.max(1, Math.min(60, nextBoundarySec)),
        staleWhileRevalidate: 0,
      });
    } else {
      const sMaxAge = Math.max(1, Math.min(600, nextBoundarySec));
      setEdgeCache(res, {
        sMaxAge,
        staleWhileRevalidate: Math.min(86400, Math.max(0, nextBoundarySec - sMaxAge)),
      });
    }
    res.json(feed);
  } catch (err) {
    next(err);
  }
});

// GET /categories - List all categories (cached 120s)
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = await getStoreIdFromRequest(req);
    // No request transaction on this route (middleware/tenant-context.ts, Ruling LAZY-TX-1): the
    // fill reads in its OWN short tenant transaction; a KV hit opens none.
    const categories = await getCached(`public:categories:${storeId}`, 120, () =>
      readInStoreContext(storeId, () => ProductService.getCategories(storeId))
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

// GET /tags - the skin-type / concern chips (Phase B3, Ruling B3-5): tags that have at least one
// published product, most-used first, at most 12. CACHE CLASS: BOUNDED-stale 120 s (a chip count
// is display content), cached under the `public:products:<storeId>:` prefix so every product write
// (invalidateStoreProductCaches) busts it; the 60 s edge copy is the same residual as the list.
router.get('/tags', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = await getStoreIdFromRequest(req);
    // `?name=` answers ONE tag (the PLP title label for a tag beyond the top-12 chips).
    const byName = typeof req.query.name === 'string' ? req.query.name.slice(0, 120) : '';
    if (byName) {
      const one = await readInStoreContext(storeId, () =>
        ProductService.getPublicTagByName(storeId, byName)
      );
      setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300 });
      res.json({ success: true, data: { tags: one ? [one] : [] } });
      return;
    }
    const tags = await getCached(`public:products:${storeId}:tags`, 120, () =>
      readInStoreContext(storeId, () => ProductService.getPublicTags(storeId))
    );
    setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300 });
    res.json({ success: true, data: { tags } });
  } catch (error) {
    next(error);
  }
});

// GET /redirects/resolve - Resolve a renamed slug to its current one (301 lookup)
const SLUG_REDIRECT_TYPE_MAP: Record<string, SlugEntityType> = {
  product: SlugEntityType.PRODUCT,
  category: SlugEntityType.CATEGORY,
  page: SlugEntityType.PAGE,
  blog: SlugEntityType.BLOG,
};

// Rate limiting is covered by the router-level `router.use(publicLimiter)` above;
// no per-route limiter here (an inline publicLimiter would double-count the bucket).
router.get('/redirects/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entityType = SLUG_REDIRECT_TYPE_MAP[String(req.query.type)];
    const slug = typeof req.query.slug === 'string' ? req.query.slug : '';

    if (!entityType || !slug) {
      res.status(400).json({ error: 'bad request' });
      return;
    }

    const storeId = await getStoreIdFromRequest(req);
    // Cached 60s, hits AND misses (#904) — see resolveSlugRedirectCached.
    const toSlug = await resolveSlugRedirectCached(storeId, entityType, slug);
    // "No redirect for this slug" is an answer about a store that exists, so it is a 200 with `toSlug: null`, not a 404:
    // the storefront asks this after every unknown product/category/page/blog slug, and a 404 here made one dead link cost
    // the shopper's IP TWO misses of the per-IP store-miss budget (the product 404 plus this one; since LAUNCH-RL-MISS-3
    // the product 404 of a verified store is no longer counted, a 404 here still would be). A store that
    // does not resolve is still refused (400 STORE_NOT_RESOLVED, getStoreIdFromRequest), exactly as before. The storefront
    // reads only `toSlug` and treats null and a non-2xx the same (apps/web/src/lib/slug-redirect.ts).
    res.json({ toSlug: toSlug ?? null });
  } catch (err) {
    next(err);
  }
});

// GET /qr/scan?kind=&slug= - resolve a printed QR code and count the scan (QR-1). Called
// server-to-server by the storefront `/q/*` redirect with the shopper's store host in
// x-store-domain. Unknown store, unknown/foreign slug, or a WhatsApp code with no number is a
// 404 and writes nothing. Never cacheable: a cached answer would skip the count.
const QR_NON_SHOPPER_UA =
  /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|telegram|twitter|embed|curl|wget/i;
const qrScanQuery = z.object({
  kind: z.enum(['store', 'product', 'category', 'whatsapp']),
  slug: z.string().min(1).max(200).optional(),
});
router.get('/qr/scan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { kind, slug } = qrScanQuery.parse(req.query);
    const storeId = await getStoreIdFromRequest(req);
    const resolved = await readInStoreContext(storeId, () => resolveQrScan(storeId, kind, slug));
    // Link-preview fetchers (WhatsApp, Facebook, Slack...), crawlers and HEAD probes are not shoppers.
    const ua = String(req.headers['user-agent'] ?? '');
    if (req.method !== 'HEAD' && !QR_NON_SHOPPER_UA.test(ua)) {
      await recordQrScan(storeId, resolved.kind, resolved.ref);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { target: resolved.target, kind: resolved.kind } });
  } catch (err) {
    next(err);
  }
});

// Cart endpoints (using default store)
// GET /cart - Get current cart
router.get(
  '/cart',
  cartLimiter,
  optionalAuthenticate,
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
      setBuyerPrivate(res);
      const cart = await CartService.getOrCreate(
        storeId,
        sessionId,
        undefined,
        buyerFromRequest(req)
      );

      res.json({
        success: true,
        data: { cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /cart/items - Add item to cart
router.post(
  '/cart/items',
  cartLimiter,
  optionalAuthenticate,
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

      const { productId, quantity, variantId, note } = addCartItemSchema.parse(req.body);
      const storeId = await getStoreIdFromRequest(req);
      const cart = await CartService.addItem(
        storeId,
        sessionId,
        productId,
        quantity,
        undefined,
        variantId,
        note,
        buyerFromRequest(req)
      );

      res.json({
        success: true,
        data: { cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /cart/acknowledge-prices - "متابعة" on the gold "السعر اتحدّث" notice (Ruling B5-17). The body is an
// EMPTY strict object: each gold line's quote becomes the server's CURRENT price, never a client value.
router.post(
  '/cart/acknowledge-prices',
  cartLimiter,
  optionalAuthenticate,
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
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const storeId = await getStoreIdFromRequest(req);
      setBuyerPrivate(res);
      const result = await CartService.acknowledgePrices(storeId, sessionId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

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
        note: z.string().max(400).optional(),
      })
    )
    .max(100),
});
router.post(
  '/cart/sync',
  cartLimiter,
  optionalAuthenticate,
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
      const { items } = syncCartSchema.parse(req.body);
      const storeId = await getStoreIdFromRequest(req);
      const cart = await CartService.addItems(
        storeId,
        sessionId,
        items,
        undefined,
        buyerFromRequest(req)
      );
      res.json({ success: true, data: { cart } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /cart/email-optin - the checkout box "Email me about my cart" (ticked or unticked).
// Stores the address on this session's cart with a consent time and upserts the store's
// newsletter subscriber (source 'checkout', scope 'cart_reminders'). Never re-activates an
// unsubscribed address (CART-CONSENT-1).
const cartEmailOptInSchema = z.object({
  email: z.string().trim().max(254),
  consent: z.boolean(),
  language: z.enum(['en', 'ar']).optional(),
});
router.post(
  '/cart/email-optin',
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
      const body = cartEmailOptInSchema.parse(req.body);
      const storeId = await getStoreIdFromRequest(req);
      const { status } = await recordCartEmailConsent(storeId, sessionId, body);
      if (status === 'invalid_email') {
        res
          .status(400)
          .json({ success: false, error: { code: 'INVALID_EMAIL', message: 'Invalid email' } });
        return;
      }
      res.json({ success: true, data: { status } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /cart/whatsapp-optin - the checkout box "Send me offers and reminders on WhatsApp" (Ruling
// WA-CONSENT-1). Cart reminders are marketing: the box is UNTICKED by default, nothing is recorded
// until the shopper ticks it, and unticking withdraws it. SECURITY: the body carries NO phone. The
// caller must be a logged-in customer with a cart in THIS session; consent is recorded against the
// number on their own account (the number the reminder goes to), source 'checkout', audited with the
// cart id. A guest, another session or a body-supplied phone cannot opt anyone in or out. Rate-limited
// per IP+session and per store. Only offered on a store that has Ebda Chat linked.
/** Show the WhatsApp marketing box only where Ebda Chat is linked; a lookup failure fails CLOSED (hidden). */
async function whatsappOptInAvailable(storeId: string): Promise<boolean> {
  try {
    return await isWhatsAppLinked(storeId);
  } catch (err) {
    logger.warn({ err, storeId }, '[public] whatsapp link lookup failed, opt-in box hidden');
    return false;
  }
}
router.post(
  '/cart/whatsapp-optin',
  ...createWhatsAppOptInHandlers({
    authenticate: (req, res, next) => optionalAuthenticate(req, res, next),
    userLimiter: (req, res, next) => whatsappConsentUserLimiter(req, res, next),
    storeLimiter: (req, res, next) => whatsappConsentStoreLimiter(req, res, next),
    storeIdFor: getStoreIdFromRequest,
    isLinked: isWhatsAppLinked,
    record: (...a) => WhatsAppConsentService.recordForCart(...a),
    state: (s, u) => WhatsAppConsentService.stateForUser(s, u),
    audit: e => auditLog(e as Parameters<typeof auditLog>[0]),
  })
);
router.get(
  '/cart/whatsapp-optin',
  ...createWhatsAppOptInStateHandlers({
    authenticate: (req, res, next) => optionalAuthenticate(req, res, next),
    userLimiter: (req, res, next) => whatsappConsentUserLimiter(req, res, next),
    storeLimiter: (req, res, next) => whatsappConsentStoreLimiter(req, res, next),
    storeIdFor: getStoreIdFromRequest,
    isLinked: isWhatsAppLinked,
    record: (...a) => WhatsAppConsentService.recordForCart(...a),
    state: (s, u) => WhatsAppConsentService.stateForUser(s, u),
    audit: e => auditLog(e as Parameters<typeof auditLog>[0]),
  })
);

// POST /cart/restore - the recovery email's button: copy the emailed cart's lines into THIS
// session's cart. The signed, expiring, store-scoped token is the only capability; the source
// cart's session id is never returned.
router.post(
  '/cart/restore',
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
      const { token } = z.object({ token: z.string().max(200) }).parse(req.body);
      const storeId = await getStoreIdFromRequest(req);
      const result = await restoreCartIntoSession(storeId, token, sessionId);
      if (!result.restored) {
        res
          .status(result.reason === 'invalid' ? 400 : 404)
          .json({ success: false, error: { code: 'CART_LINK_INVALID', message: 'Link expired' } });
        return;
      }
      res.json({ success: true, data: { added: result.added } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /cart/from-wa - the Ebda Chat checkout link (Ruling WA-RPC-3): copy the signed token's lines into THIS session's cart.
router.post(
  '/cart/from-wa',
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
      const { token } = z.object({ token: z.string().max(4000) }).parse(req.body);
      const storeId = await getStoreIdFromRequest(req);
      const result = await redeemWaCheckout(storeId, token, sessionId);
      if (!result.redeemed) {
        res
          .status(400)
          .json({ success: false, error: { code: 'CART_LINK_INVALID', message: 'Link expired' } });
        return;
      }
      res.json({ success: true, data: { added: result.added, unavailable: result.unavailable } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /cart/items/:itemId - Update cart item
router.put(
  '/cart/items/:itemId',
  cartLimiter,
  optionalAuthenticate,
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
      const cart = await CartService.updateItem(
        storeId,
        sessionId,
        itemId,
        quantity,
        undefined,
        buyerFromRequest(req)
      );

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
  optionalAuthenticate,
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
      const cart = await CartService.removeItem(
        storeId,
        sessionId,
        itemId,
        undefined,
        buyerFromRequest(req)
      );

      res.json({
        success: true,
        data: { cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /cart/bundles - Add a bundle to the cart (its own CartBundle row —
// see cart.service.ts; a bundle is NEVER expanded into cart_items here).
//
// A refusal for a business rule (bundle inactive/expired/sold out, or not
// enough component stock for the requested quantity) is a flat
// `{ error: '<code>' }` 422 — the same convention as the identical route
// in cart.routes.ts, independent of bundle.routes.ts's admin-CRUD errors
// (which moved onto the standard AppError envelope in RULING T9-a; this
// storefront-facing shape is unaffected). A genuine 404 (unknown bundle /
// wrong store) flows through `resolveBundle` -> `next(error)` -> the
// normal error handler.
router.post(
  '/cart/bundles',
  cartLimiter,
  requireFeature('bundles'),
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
      const customerId = customerUserId(req);
      const data = addBundleToCartSchema.parse(req.body);

      const result = await CartService.addBundle(
        storeId,
        sessionId,
        data.bundleId,
        data.quantity,
        customerId,
        buyerFromRequest(req)
      );

      if (!result.ok) {
        res.status(422).json({ error: result.error });
        return;
      }

      res.status(201).json({
        success: true,
        data: { cart: result.cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /cart/bundles/:cartBundleId - Remove a bundle from the cart.
// `:cartBundleId` is the CartBundle row id (mirrors `:itemId` on
// /cart/items/:itemId being the CartItem row id, not the bundleId).
//
// Deliberately NOT named `:id`: `requireFeature`'s storeId resolution reads
// `req.params.storeId || req.params.id || ... || x-store-id header` — a
// param literally named `id` on THIS route (which has no `:storeId` param
// at all, unlike its `/stores/:storeId/cart/bundles/:id` sibling in
// cart.routes.ts, where `:storeId` always wins first) would have been
// picked up as the "storeId" instead of the CartBundle row id, sending a
// random UUID into the feature-flag lookup and 403ing `FEATURE_DISABLED`
// on every real removal. Caught by the HTTP-level test that exercises this
// route with only headers, no route param, for the store id (fix-round-2,
// Finding 1) — every existing bundle-cart test called `CartService`
// directly or hit the OTHER route, so none of them could have found this.
router.delete(
  '/cart/bundles/:cartBundleId',
  cartLimiter,
  requireFeature('bundles'),
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

      const { cartBundleId } = req.params;
      const storeId = await getStoreIdFromRequest(req);
      const customerId = customerUserId(req);
      const cart = await CartService.removeBundle(
        storeId,
        sessionId,
        cartBundleId,
        customerId,
        buyerFromRequest(req)
      );

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
router.delete(
  '/cart',
  cartLimiter,
  optionalAuthenticate,
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
      const cart = await CartService.clear(storeId, sessionId, undefined, buyerFromRequest(req));

      res.json({
        success: true,
        data: { cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

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
  // Design review I5 / I-4: an impersonation session (support, platform super_admin) must not place a real order as the
  // impersonated customer, least of all at that account's wholesale price.
  rejectImpersonated,
  writeLimiter,
  couponAttemptLimiter,
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
      // and storefront origins (api.ebda.app host), so a merchant
      // signed into store.ebda.app sends the SAME cookie to
      // /public/orders on ebda.app. Without this guard
      // we'd attach the merchant's super_admin/store_admin userId as
      // `Order.customerId` — downstream loyalty / abandoned-cart /
      // analytics code assumes that ID points to a customer record and
      // throws when it points at an admin instead. Mirror is in
      // apps/web/src/contexts/AuthContext.tsx (refreshUser).
      const orderCustomerId = req.user?.role === 'customer' ? req.user.userId : undefined;
      const order = await OrderService.create(
        storeId,
        orderCustomerId,
        sessionId,
        orderData,
        undefined,
        {
          checkoutIp: ipKeyGenerator(req.ip ?? '') || null,
          buyer: buyerFromRequest(req),
          idempotencyKey: req.header('idempotency-key') ?? null,
        }
      );

      res.status(201).json({
        success: true,
        // The shopper's own order without the merchant's cost and the gold margin (Ruling B5-36).
        // A guest also gets the signed view token for it (SEC-15): the only credential, beside the
        // order id, that `GET /orders/:id` accepts for the unmasked address and phone.
        data: {
          order: redactOrderForCustomer(order),
          ...(order.customerId ? {} : { viewToken: guestViewTokenFor(order.id) }),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /orders/quote - the EXACT total POST /orders would charge for this cart, buyer and inputs (design review I-1).
// Computed by OrderService.create in dry-run mode, so pricing, MOQ, coupon / promotion eligibility, loyalty, shipping, COD
// fee and VAT can never drift from the order. Nothing is written and no stock moves. The checkout displays `total` and sends
// it back as `expectedTotal`, so a buyer who is repriced between this quote and the order (revoked approval, edited tier)
// gets a 409 PRICE_CHANGED and confirms the new total instead of being charged a number they never saw.
const quoteOrderSchema = z.object({
  shippingAddress: z
    .object({
      area: z.string().max(120).optional(),
      governorate: z.string().max(120).optional(),
      city: z.string().max(120).optional(),
      state: z.string().max(120).optional(),
      country: z.string().max(60).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(255).optional(),
    })
    .default({}),
  paymentMethod: z.string().min(1),
  couponCode: z.string().trim().min(1).max(50).optional(),
  pointsToRedeem: z.number().int().min(0).max(100_000_000).optional(),
});
router.post(
  '/orders/quote',
  optionalAuthenticate,
  cartLimiter,
  couponAttemptLimiter,
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
      const body = quoteOrderSchema.parse(req.body);
      const quote = await OrderService.quote(
        storeId,
        customerUserId(req),
        sessionId,
        {
          shippingAddress: {
            firstName: '',
            lastName: '',
            address1: '',
            city: '',
            state: '',
            postalCode: '',
            country: 'EG',
            ...body.shippingAddress,
          },
          paymentMethod: body.paymentMethod,
          couponCode: body.couponCode,
          pointsToRedeem: body.pointsToRedeem,
        } as never,
        buyerFromRequest(req)
      );
      setBuyerPrivate(res);
      res.json({ success: true, data: { quote } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /customers/me/reorder - "Order again" (Phase B4, Ruling B4-8): the signed-in customer's
// last distinct products (ids only, newest first, <= 12). Per customer, so NEVER cached
// (`private, no-store`); the storefront resolves current price and stock through the cached
// public product read. Anonymous: 401 (the storefront row then renders nothing).
router.get(
  '/customers/me/reorder',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = await getStoreIdFromRequest(req);
      const customerId = customerUserId(req);
      setBuyerPrivate(res);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }
      const productIds = await CustomerReorderService.productIds(storeId, customerId);
      res.json({ success: true, data: { productIds } });
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
// from store.ebda.app doesn't reject a guest's success page; the
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

      // A guest (customerId null) sees the unmasked address and phone only with the signed view
      // token issued when the order was created (SEC-15 / M-137). The order UUID alone is not
      // enough: it leaks through history, screenshots and shared links.
      const guestMayViewPii = isCustomer || requestHoldsOrderViewToken(req, order.id);
      // Never shown to a shopper, token or not: the checkout IP, the merchant's internal note and the
      // idempotency key (the schema marks checkoutIp as shown to no one).
      const {
        checkoutIp: _ip,
        notes: _notes,
        idempotencyKey: _idem,
        ...shopperOrder
      } = redactOrderForCustomer(order) as Record<string, unknown>;
      void _ip;
      void _notes;
      void _idem;
      // The delivery pick, alone: `notes` stays hidden, but the receipt must show when it arrives.
      const visible = { ...shopperOrder, deliveryLine: deliveryLineFromNotes(order.notes) };
      // The answer differs by token: never cache it shared.
      res.setHeader('Cache-Control', 'private, no-store');
      res.vary('X-Order-View-Token');

      res.json({
        success: true,
        // The shopper's own order without the merchant's cost and the gold margin (Ruling B5-23).
        data: { order: guestMayViewPii ? visible : maskGuestOrderView(visible) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /orders/:id/verify-payment — GUEST-SAFE verify-on-return.
//
// THE PRIMARY payment-confirmation path. A gateway's webhook can be late,
// lost, or never wired by the merchant (a Fawry reference code is paid hours
// later, at an outlet), so the storefront success page actively asks the
// provider "is this payment paid?" on return and reconciles our DB. The webhook
// path remains as the other half.
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
//      the gateway independently reports that payment as paid. The
//      optional `paymentId` from the redirect URL is recorded for the
//      audit trail but is never trusted as proof of payment on its own.
//
// IDEMPOTENT: safe to call on every page load / retry. The shared
// confirmPaymentFromProviderStatus helper only writes + fans out on a
// real transition, so a later webhook (or a second verify) is a no-op.
const verifyPaymentSchema = z.object({
  // A gateway may append its own payment id to the success URL.
  // Optional + recorded for audit only — authorization rides on the
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

      const order = await (
        await storeDb(storeId)
      ).order.findFirst({
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

      // A Durable Object store's order and payment rows live in its DO; the confirmation below claims and writes them in
      // Postgres, where they do not exist (a failed claim there used to read as "paid", a completed one threw). Until N-11 /
      // N-12 port that money path, report the DO order's own state and let the webhook settle it. Never derive "paid" here.
      if ((await storeRepo(storeId)).backend === 'do') {
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

    assertScalarQuery(req.query, ['q']);
    // Header first (Ruling SEARCH-URL-1); the deprecated `?q=` stays accepted for one release.
    const headerQ = searchQueryFromHeader(req);
    const q = headerQ ?? (typeof req.query.q === 'string' ? req.query.q : '');
    // Length-cap alongside the >= 2 floor (same class as /products' search:
    // the term is part of the cache key, so an unbounded term is unbounded
    // cache-key cardinality AND an unbounded ILIKE pattern).
    const trimmed = q.trim().slice(0, 100);
    if (trimmed.length < 1) {
      res.json({ success: true, data: { suggestions: [] } });
      return;
    }

    // Keyed by exactly what the result depends on: the suggestions are computed from the
    // Arabic-normalised term only (searchProductIds folds it), so two raw spellings that fold the
    // same share an entry, and two that fold differently never do (Ruling SEARCH-T12-7: the old
    // `toLowerCase()` key also folded non-ASCII letters the search does not, e.g. É and é).
    const cacheKey = `public:suggest:${storeId}:${normalizeArabicSearch(trimmed)}`;
    const result = await getCached(cacheKey, 120, () =>
      ProductService.getSuggestSuggestions(storeId, trimmed, 25)
    );

    if (headerQ !== undefined) {
      res.vary('X-Search-Query');
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      res.setHeader('Cache-Control', 'private, max-age=120');
    }
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
      const store = await (
        await storeDb(storeId)
      ).store.findFirst({
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

      const wishlist = await (
        await storeDb(storeId)
      ).wishlist.findFirst({
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
                  // The shared list's button is "choose options" for a sized
                  // product, never a one-tap add (C-01).
                  variants: WISHLIST_CARD_VARIANTS_SELECT,
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
        product: wishlistCardProduct(item.product),
      }));

      const backorderOn = await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
      res.json({
        success: true,
        data: { items: gateBackorderPayload(items, backorderOn), isPublic: wishlist.isPublic },
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
      const product = await (
        await storeDb(storeId)
      ).product.findFirst({
        where: { id: productId, storeId, deletedAt: null, audience: 'public' },
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

    // `stores` is under RLS (R-EBDA-005): the page of active store ids (newest first) and
    // the total come from a definer; each store's public fields are read in its own scope.
    const storePage = await publicStorePage(skip, limitNum);
    const total = storePage.total;
    const stores = (
      await Promise.all(
        storePage.ids.map(id =>
          withStoreRead(id, tx =>
            tx.store.findUnique({
              where: { id },
              select: {
                id: true,
                name: true,
                slug: true,
                logo: true,
                settings: true,
                createdAt: true,
              },
            })
          )
        )
      )
    ).filter((s): s is NonNullable<typeof s> => s !== null);

    setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 });
    res.json({
      success: true,
      data: stores.map(store => ({ ...store, settings: publicStoreSettings(store.settings) })),
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

/**
 * The store's active FAQs + how-tos for the public store payloads below.
 *
 * `store_faqs` / `store_howtos` carry STRICT RLS policies — `store_id =
 * app.current_store_id OR app.bypass_rls` — with no allowance for a query that
 * sets no context. These public routes run outside `tenantContext`, so under
 * the non-bypass `ebda_app` role a nested `store.faqs` select silently
 * returned `[]` for every store. That is what emptied demo-store's 24 FAQs and
 * 9 how-tos during the 2026-09-25 cutover attempt, with no error anywhere.
 *
 * The store has already been resolved from the unscoped `stores` table, so
 * read its rows inside ITS tenant context: correct under RLS and still scoped
 * to that one store. Identical result on the owner role. The keys stay last
 * in the payload, where the nested select used to put them.
 */
/**
 * The store's active FAQs and HowTos AND its unpublished CMS page slugs in ONE round trip.
 * They were three sequential queries on the store-resolve fill (about 100 ms each from the Worker
 * to Postgres); the shapes, filters and ordering are exactly the three Prisma reads they replace
 * (pinned byte-for-byte by tests/integration/store-resolve-parity.test.ts). Runs inside the store
 * scope (`readInStoreContext`), so RLS still filters every table.
 */
async function fetchStoreExtras(storeId: string) {
  // A store on its Durable Object reads the same three sets from its own tables, in one DO round trip batch (NEON-ZERO-1 N-5).
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') {
    const db = repo.db;
    const [faqs, howtos, disabled] = await Promise.all([
      db.storeFaq.findMany({
        where: { storeId, isActive: true },
        orderBy: { orderIndex: 'asc' },
        select: { id: true, question: true, questionAr: true, answer: true, answerAr: true },
      }),
      db.storeHowto.findMany({
        where: { storeId, isActive: true },
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
      }),
      db.storePage.findMany({
        where: { storeId, isPublished: false },
        select: { slug: true },
      }),
    ]);
    return { faqs, howtos, disabledCmsSlugs: disabled.map(p => p.slug) };
  }
  return readInStoreContext(storeId, async () => {
    const rows = await prisma.$queryRaw<
      Array<{ faqs: unknown; howtos: unknown; disabled: unknown }>
    >`
      SELECT
        COALESCE((
          SELECT json_agg(json_build_object(
                   'id', f.id, 'question', f.question, 'questionAr', f.question_ar,
                   'answer', f.answer, 'answerAr', f.answer_ar) ORDER BY f.order_index ASC)
          FROM public.store_faqs f
          WHERE f.store_id = ${storeId} AND f.is_active = true
        ), '[]'::json) AS faqs,
        COALESCE((
          SELECT json_agg(json_build_object(
                   'id', h.id, 'title', h.title, 'titleAr', h.title_ar,
                   'description', h.description, 'descriptionAr', h.description_ar,
                   'steps', h.steps, 'stepsAr', h.steps_ar) ORDER BY h.order_index ASC)
          FROM public.store_howtos h
          WHERE h.store_id = ${storeId} AND h.is_active = true
        ), '[]'::json) AS howtos,
        COALESCE((
          SELECT json_agg(json_build_object('slug', p.slug))
          FROM public.store_pages p
          WHERE p.store_id = ${storeId} AND p.is_published = false
        ), '[]'::json) AS disabled
    `;
    const row = rows[0];
    return {
      faqs: (row?.faqs ?? []) as Array<{
        id: string;
        question: string;
        questionAr: string | null;
        answer: string;
        answerAr: string | null;
      }>,
      howtos: (row?.howtos ?? []) as Array<{
        id: string;
        title: string;
        titleAr: string | null;
        description: string;
        descriptionAr: string | null;
        steps: unknown;
        stepsAr: unknown;
      }>,
      disabledCmsSlugs: ((row?.disabled ?? []) as Array<{ slug: string }>).map(p => p.slug),
    };
  });
}

async function fetchStoreFaqsAndHowtos(storeId: string) {
  const { faqs, howtos } = await fetchStoreExtras(storeId);
  return { faqs, howtos };
}

/**
 * Public projection of a store's published Locations, threaded onto the
 * store-resolve payloads below for the opt-in storefront-footer "Branches"
 * column (B3, 2026-09-25). Gated on BOTH `locationsEnabled` (the existing
 * Locations feature) AND `theme.showBranchesInFooter` (the new footer
 * opt-in), so a store with Locations enabled for its /locations page but no
 * footer opt-in — e.g. demo-store's 8 locations — pays no extra query and its
 * footer is unaffected until it explicitly turns this on. Narrower select
 * than `LocationsService.listPublished` (drops country/whatsapp/hours/
 * mapsEmbedUrl) since this rides EVERY page's store-resolve payload — the
 * dedicated `/public/:storeId/locations` endpoint still returns the full row.
 */
async function fetchFooterLocations(store: {
  id: string;
  locationsEnabled: boolean | null;
  theme: unknown;
}): Promise<
  | Array<{
      id: string;
      name: string;
      nameAr: string | null;
      address: string;
      addressAr: string | null;
      phone: string | null;
      mapsUrl: string | null;
    }>
  | undefined
> {
  const theme =
    store.theme && typeof store.theme === 'object'
      ? (store.theme as Record<string, unknown>)
      : null;
  if (!store.locationsEnabled || theme?.showBranchesInFooter !== true) return undefined;
  return readInStoreContext(store.id, async () =>
    (await storeDb(store.id)).storeLocation.findMany({
      where: { storeId: store.id, isPublished: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        nameAr: true,
        address: true,
        addressAr: true,
        phone: true,
        mapsUrl: true,
      },
    })
  );
}

// GET /stores/:slugOrId - Get store by slug or ID (public, cached 120s)
router.get('/stores/:slugOrId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Lowercased so `Amelia` and `amelia` share ONE cache entry (slugs are
    // stored lowercase; the by-slug match below is case-sensitive).
    const slugOrId = req.params.slugOrId.toLowerCase();

    // Check if it's a UUID (ID) or slug
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);

    // A reserved label (`app`, `api`, `www`, …) is never a store: answer 404
    // without touching the cache or the database.
    if (!isUuid && isReservedSlug(slugOrId)) {
      res.status(404).json({
        success: false,
        error: { code: 'STORE_NOT_FOUND', message: 'Store not found' },
      });
      return;
    }

    // A miss throws out of the fetcher (below) so it is never written to the
    // cache — a store created a moment later must resolve immediately.
    const result = await getCached(`public:store:${slugOrId}`, 120, async () => {
      // Return active OR suspended stores (so the storefront can render a
      // branded "we'll be back soon" page for suspended stores instead of
      // 404'ing). Inactive stores stay hidden — `inactive` is reserved for
      // archived/draft stores merchants haven't published. Soft-deleted
      // stores (`deletedAt` set) are also excluded.
      // `stores` is under RLS (R-EBDA-005): resolve through the lookup definer, then read
      // the row inside that store's own scope.
      const hit = await lookupStoreCached(isUuid ? { id: slugOrId } : { slug: slugOrId }, [
        'active',
        'suspended',
      ]);
      if (!hit) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
      // A Durable Object store runs the rest of the fill in a bare store scope, so the settings, tax, features and
      // entitlement reads below open no Postgres transaction for it (NEON-ZERO-1 N-2); a Postgres store is unchanged.
      return inDoStoreScope(hit.id, async () => {
        const store = hit
          ? await readInStoreContext(hit.id, async () =>
              (await storeDb(hit.id)).store.findUnique({
                where: { id: hit.id },
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
                  look: true,
                  isDemo: true,
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
                  returnWindowDays: true,
                  returnFeesPaidBy: true,
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
                },
              })
            )
          : null;

        if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

        // RESOLVE-PARALLEL-1: the reads below depend only on `store`; run together, not eight round trips in a row
        // (see the same fill in /store/resolve).
        const [
          taxRate,
          faqsAndHowtos,
          smsMarketingOptIn,
          cartEmailOptIn,
          whatsappMarketingOptIn,
          enabledFeatures,
          disabledPages,
          locations,
        ] = await Promise.all([
          resolveActiveTaxRate(store.id),
          fetchStoreFaqsAndHowtos(store.id),
          notificationDispatcher.isSmsMarketingAvailable(store.id),
          cartEmailOptInAvailable(store.id),
          whatsappOptInAvailable(store.id),
          featureService.getEnabledFeatureKeys(store.id),
          // Mirror the /store/resolve endpoint: surface explicitly-disabled
          // CMS pages so the storefront footer can hide their links rather
          // than rendering a "Page unavailable" landing on click.
          readInStoreContext(store.id, async () =>
            (await storeDb(store.id)).storePage.findMany({
              where: { storeId: store.id, isPublished: false },
              select: { slug: true },
            })
          ),
          fetchFooterLocations(store),
        ]);

        // Strip server-only marketing-pixel secrets (Meta CAPI / TikTok Events
        // access tokens) before this store object reaches the public storefront
        // (and the edge cache). The browser pixel snippets only use the public
        // pixel IDs — the tokens must never be exposed to anonymous visitors.
        const publicStore = {
          ...store,
          // A store still holding a retired Force skin renders as its mapped Ebda template, at
          // read time, with no database write (Ruling SKIN-DEL-8).
          template: normalizeLegacyTemplate(store.template),
          marketingPixels: stripMarketingPixelSecrets(store.marketingPixels),
          settings: publicStoreSettings(store.settings),
          // The checkout/cart tax line needs the rate, not just the enabled/included booleans already on the Store row.
          // The SAME resolver order creation charges against (ruling M3-9), so it carries the VAT gate (ruling TAX-2):
          // an unverified store is never shown a VAT line NOR charged one, even with `taxEnabled` set and old TaxRate
          // rows still `isActive: true`. `taxEnabled` is overwritten with the EFFECTIVE value so no storefront code can
          // key on the merchant's wish.
          ...effectiveTaxFields(taxRate),
          ...faqsAndHowtos,
          // Issue 206: the storefront renders the SMS-offers opt-in ONLY when this is true (sms feature on + provider
          // configured + a promotional event enabled), so a store without SMS marketing shows no new UI.
          // BOUNDED-stale: rides this 120s cache + the edge s-maxage 120 / SWR 600; a provider switched on/off shows up
          // within that window. It is display-only: the send gate re-checks everything live.
          smsMarketingOptIn,
          cartEmailOptIn,
          whatsappMarketingOptIn,
        };

        const disabledCmsSlugs = disabledPages.map(p => p.slug);
        return { store: publicStore, enabledFeatures, disabledCmsSlugs, locations };
      });
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

/** Header the storefront forwards (server-to-server) from the editor canvas `?_builder=` token. */
export const BUILDER_PREVIEW_TOKEN_HEADER = 'x-builder-preview-token';

/**
 * The store id an editor preview token unlocks for THIS host, or null.
 *
 * The token (minted by the authenticated admin route, Redis-stored under
 * `builder-preview:<storeId>:<token>`) is verified SERVER-SIDE here: the host is
 * resolved to its store id through the lookup definer (any status), then the
 * Redis entry for exactly (that store, that token) must exist. A token minted
 * for store A therefore cannot unlock store B's host, and an expired/forged
 * token finds no entry. A bare query flag is never trusted. Any failure returns
 * null and the caller serves the unchanged public (active/suspended only) path.
 */
async function resolveBuilderPreviewStoreId(
  rawToken: string | string[] | undefined,
  lookup: NonNullable<ReturnType<typeof storeLookupForHost>>
): Promise<string | null> {
  const token = typeof rawToken === 'string' ? rawToken : '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const hit = await lookupStore(
    lookup.by === 'slug' ? { slug: lookup.slug } : { domain: lookup.domain },
    ['active', 'suspended', 'inactive']
  );
  if (!hit) return null;
  const entry = await redis.get<{ pageKey?: string }>(previewTokenKey(hit.id, token), true);
  return entry && typeof entry.pageKey === 'string' ? hit.id : null;
}

// GET /store/resolve - Resolve store by domain header (for multi-tenant)
router.get(
  '/store/resolve',
  storeResolveLimit(storeResolveLimiter),
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

      // Host → store (design cloudflare-backend §4): `<slug>.ebda.app` resolves
      // by slug, any other well-formed host by custom domain. Reserved labels,
      // platform hosts, IPs, `localhost` and malformed values never reach the
      // database — they are a 404, and there is NO default-store fallback.
      const lookup = storeLookupForHost(rawDomain);
      if (!lookup) {
        if (await countStoreMiss(req, res)) return;
        res.status(404).json({
          success: false,
          error: { code: 'STORE_NOT_FOUND', message: 'No store found for the specified domain' },
        });
        return;
      }

      // Redis-cached (120s, same shape/TTL as /stores/:slugOrId above) —
      // this is the host→store lookup every storefront page load depends
      // on, so it must not hit Postgres on every request. The key carries the
      // canonical HOST (`<slug>.ebda.app` or the custom domain), so two stores
      // can never share an entry. A MISS throws out of the fetcher: getCached
      // only stores what the fetcher returns, so an unknown host is never
      // cached (a store created a second later must resolve immediately).
      // Builder-preview bypass (see resolveBuilderPreviewStoreId): a VALID,
      // store-bound editor token lets the canvas resolve a store that is not
      // active yet. Never cached, never indexable. No/invalid token -> falls
      // through to the unchanged public path below.
      const previewStoreId = await resolveBuilderPreviewStoreId(
        req.headers[BUILDER_PREVIEW_TOKEN_HEADER],
        lookup
      );

      const loadPayload = async (
        statuses: readonly StoreStatusName[],
        expectedStoreId?: string
      ) => {
        // Find store by domain. Suspended stores are returned with their
        // `status` so the storefront can render the branded maintenance page
        // for that store. Inactive (archived/draft) and soft-deleted stores
        // stay hidden — those should still 404.
        // `stores` is under RLS (R-EBDA-005): resolve through the lookup definer, then read
        // the row inside that store's own scope.
        // The public path (no expected id) reads the cached directory (Ruling NZ-D1: reads only); the editor preview is
        // never cached and always asks D1.
        const resolve = expectedStoreId ? lookupStore : lookupStoreCached;
        const hit = await resolve(
          lookup.by === 'slug' ? { slug: lookup.slug } : { domain: lookup.domain },
          statuses
        );
        // Preview only: the row must be the exact store the token was bound to.
        if (hit && expectedStoreId && hit.id !== expectedStoreId) {
          throw new AppError(404, 'STORE_NOT_FOUND', 'No store found for the specified domain');
        }
        const store = hit
          ? await readInStoreContext(hit.id, async () =>
              (await storeDb(hit.id)).store.findUnique({
                where: { id: hit.id },
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
                  look: true,
                  isDemo: true,
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
                  returnWindowDays: true,
                  returnFeesPaidBy: true,
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
                },
              })
            )
          : null;

        if (!store)
          throw new AppError(404, 'STORE_NOT_FOUND', 'No store found for the specified domain');

        // Durable Object store: the rest of the fill runs in a bare store scope (no Postgres transaction), see /stores/:slugOrId.
        return inDoStoreScope(store.id, async () => {
          // RESOLVE-PARALLEL-1: every read below depends only on `store`, so they run together. They used to be eight
          // awaits in a row, each a Durable Object / D1 round trip: on a cache miss (the first visit after the 120 s
          // entry expired, and every external probe at a 5 min cadence) the fill was the SUM of them, 4-8 s measured on
          // 2026-11-15 (p90 5.1 s, max 8.2 s for `/store/resolve`), which the storefront page waits on before it can
          // start its own layout/products calls. Now it is the slowest single read.
          const [
            enabledFeatures,
            extras,
            taxRate,
            smsMarketingOptIn,
            cartEmailOptIn,
            whatsappMarketingOptIn,
            locations,
          ] = await Promise.all([
            featureService.getEnabledFeatureKeys(store.id),
            // Surface CMS pages that the merchant has explicitly turned off ("Show on storefront" toggle in /content).
            // The storefront uses this to hide footer links pointing at those slugs: a customer must not click
            // "Privacy" and land on "Page unavailable". Only rows that exist AND are unpublished are reported; a
            // missing row falls back to the built-in copy and the link still works.
            fetchStoreExtras(store.id),
            resolveActiveTaxRate(store.id),
            notificationDispatcher.isSmsMarketingAvailable(store.id),
            cartEmailOptInAvailable(store.id),
            whatsappOptInAvailable(store.id),
            fetchFooterLocations(store),
          ]);
          const disabledCmsSlugs = extras.disabledCmsSlugs;

          // Strip server-only marketing-pixel secrets before the store reaches the
          // public storefront + edge cache (browser pixels use public IDs only).
          const publicStore = {
            ...store,
            template: normalizeLegacyTemplate(store.template),
            marketingPixels: stripMarketingPixelSecrets(store.marketingPixels),
            settings: publicStoreSettings(store.settings),
            // Keep in lock-step with the /stores/:slugOrId select above (VAT gate, ruling TAX-2).
            ...effectiveTaxFields(taxRate),
            faqs: extras.faqs,
            howtos: extras.howtos,
            // Keep in lock-step with /stores/:slugOrId (issue 206, same staleness).
            smsMarketingOptIn,
            cartEmailOptIn,
            whatsappMarketingOptIn,
          };

          return { store: publicStore, enabledFeatures, disabledCmsSlugs, locations };
        });
      };

      if (previewStoreId) {
        // Fresh read, any lifecycle status, bound to the token's store. NOT
        // routed through the public cache helper (the shared `public:store:resolve:<host>`
        // key public requests hit) and never edge-cacheable.
        const previewResult = await loadPayload(
          ['active', 'suspended', 'inactive'],
          previewStoreId
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.vary(BUILDER_PREVIEW_TOKEN_HEADER);
        res.json({ success: true, data: previewResult });
        return;
      }

      const result = await getCached(`public:store:resolve:${lookup.cacheHost}`, 120, () =>
        loadPayload(['active', 'suspended'])
      );

      if (!result) {
        if (await countStoreMiss(req, res)) return;
        res.status(404).json({
          success: false,
          error: { code: 'STORE_NOT_FOUND', message: 'No store found for the specified domain' },
        });
        return;
      }

      // This response is keyed on x-store-domain, NOT x-store-id (which this
      // route never reads). setEdgeCache now Varies on BOTH tenant selectors
      // by default (audit-followup #1145/#1160 — the same always-absent-header
      // shape existed on 4 sibling routes), so no per-call varyOn is needed.
      setEdgeCache(res, { sMaxAge: 120, staleWhileRevalidate: 600 });
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      // An unknown store surfaces as an AppError 404 out of the fill: count it (native limiters only) before it is answered.
      if (error instanceof AppError && error.statusCode === 404 && (await countStoreMiss(req, res)))
        return;
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
        // `section`: the visual builder's newsletter section (Phase 2).
        source: z.enum(['footer', 'popup', 'manual', 'section']).optional(),
      });

      const data = subscribeSchema.parse(req.body);
      const storeId = await getStoreIdFromRequest(req);
      // Ruling B1-13: the demo showroom keeps no subscriber list.
      await assertNotDemoStore(storeId);
      const normalizedEmail = data.email.trim().toLowerCase();

      // the list lives on the store's own backend (Ruling CF-R4-4)
      const subscribers = await storeDb(storeId);
      const subscriberWriter = await storeWriter(storeId);
      const existing = await subscribers.newsletterSubscriber.findUnique({
        where: {
          storeId_email: { storeId, email: normalizedEmail },
        },
      });

      if (existing) {
        // If they had previously unsubscribed, re-activate the row so the
        // admin's send count stays correct.
        if (!existing.isActive) {
          await subscriberWriter.newsletterSubscriber.update({
            where: { id: existing.id, storeId },
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

      await subscriberWriter.newsletterSubscriber.create({
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
      const storeId = await getStoreIdFromRequest(req);

      const order = await (
        await storeDb(storeId)
      ).order.findUnique({
        where: { id: orderId, storeId },
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
      const existing = await (
        await storeDb(storeId)
      ).review.findUnique({
        where: { orderId_productId: { orderId, productId }, storeId },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({ ok: false, error: 'ALREADY_REVIEWED', reviewId: existing.id });
        return;
      }

      // Load product + store info for the form
      const product = await (
        await storeDb(storeId)
      ).product.findUnique({
        where: { id: productId, storeId },
        select: { id: true, name: true, nameAr: true, images: true, storeId: true },
      });
      if (!product || product.storeId !== order.storeId) {
        res.status(404).json({ ok: false, error: 'PRODUCT_NOT_FOUND' });
        return;
      }

      const store = await (
        await storeDb(order.storeId)
      ).store.findUnique({
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
      const storeId = await getStoreIdFromRequest(req);

      // Re-validate token + order state — never trust the form's prior check
      const order = await (
        await storeDb(storeId)
      ).order.findUnique({
        where: { id: data.orderId, storeId },
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
      const orderItem = await (
        await storeDb(storeId)
      ).orderItem.findFirst({
        where: { orderId: data.orderId, productId: data.productId },
        select: { id: true },
      });
      if (!orderItem) {
        res.status(400).json({ ok: false, error: 'PRODUCT_NOT_IN_ORDER' });
        return;
      }

      // Create the review — status 'pending' until AI spam-check + moderation
      const review = await (
        await storeWriter(order.storeId)
      ).review.create({
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

const CONTACT_STORE_WINDOW_SECONDS = 3600; // >= the repo's 120s TTL floor
const CONTACT_STORE_MAX_PER_WINDOW = 20;

// POST /contact - a shopper's storefront contact-page message, for THIS store (Ruling FU46-1).
//
// Resolved from X-Store-ID / x-store-domain like every /public write; a request that names no
// store is refused (400 STORE_NOT_RESOLVED) instead of landing in a platform inbox. A demo store
// (the looks showroom) refuses like its checkout does. A filled honeypot is answered as success
// and dropped. #645: the send is queued on Inngest and the ENQUEUE is awaited, so a visitor is
// never told "sent" for a message nothing will act on.
router.post('/contact', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contactSchema = z.object({
      name: z.string().min(1, 'Name is required').max(100),
      email: z.string().email('Invalid email address'),
      subject: z.string().min(1, 'Subject is required').max(200),
      message: z.string().min(1, 'Message is required').max(5000),
      // Any type/length: a bot stuffing the trap must get the silent success, never a 400.
      [CONTACT_HONEYPOT_FIELD]: z.unknown().optional(),
    });

    const data = contactSchema.parse(req.body);
    const storeId = await getStoreIdFromRequest(req);

    const trap = data[CONTACT_HONEYPOT_FIELD];
    if (trap !== undefined && trap !== null && String(trap).trim() !== '') {
      logger.info({ storeId }, '[CONTACT] honeypot tripped; dropped');
      res.json({ success: true, data: { message: 'Message sent successfully' } });
      return;
    }

    const store = await (
      await storeDb(storeId)
    ).store.findUnique({
      where: { id: storeId },
      select: { isDemo: true },
    });
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    if (store.isDemo) {
      throw new AppError(403, 'DEMO_STORE', 'This is a demo store; messages are disabled', {
        messageEn: 'This is a demo store: messages are disabled',
        messageAr: 'ده متجر تجريبي — الرسائل مقفولة',
      });
    }

    // Per-STORE cap on top of the per-IP writeLimiter (FU46-1 review I1): a store UUID is public,
    // so distributed callers could otherwise flood one merchant from its own verified sender.
    // Over the cap: identical success to the shopper (no oracle), message dropped, store id logged.
    // FIXED window: the TTL is set when the key is created and dropped hits never extend it (a
    // sliding window would let a trickle lock the form forever). Returns 0 when Redis is down:
    // fail-open like writeLimiter (Ruling FU46-1b).
    const sent = await redis.incrementFixedWindow(
      `contact:${storeId}`,
      CONTACT_STORE_WINDOW_SECONDS
    );
    if (sent > CONTACT_STORE_MAX_PER_WINDOW) {
      // First over-cap hit of the window = the one merchant-visible signal: logged at error
      // level (Sentry/pino alerting) once; the rest stay warn.
      if (sent === CONTACT_STORE_MAX_PER_WINDOW + 1) {
        logger.error({ storeId }, '[CONTACT] per-store cap hit; contact form is dropping messages');
      } else {
        logger.warn({ storeId }, '[CONTACT] per-store cap reached; message dropped');
      }
      res.json({ success: true, data: { message: 'Message sent successfully' } });
      return;
    }

    await inngest.send({
      name: 'contact/form.submitted',
      data: {
        storeId,
        name: data.name,
        email: data.email,
        subject: data.subject,
        message: data.message,
      },
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
