import {
  prisma,
  Prisma,
  ProductStatus,
  OrderStatus,
  withMoneyTx,
  SlugEntityType,
  withStore,
} from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { activeVariants, effectiveInventory } from '../lib/effective-inventory';
import { slugify, slugifyWithFallback, AI_AUTOFILL_FIELD_NAMES } from '@ebda/shared';
import { redis } from './redis.service';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import logger from '../lib/logger';
import { cleanupRemovedImages } from './r2-cleanup.service';
import { LISTING_SWATCH_OPTIONS_SELECT } from '../lib/listing-swatch-select';
import { PUBLIC_MODEL3D_SELECT, toPublicModel3d } from './product-model.service';
import { inngest } from '../lib/inngest/client';
import { stampHumanEdits, enqueueRecommendationsSweepForNewProduct } from './ai-autofill.service';
import { recordSlugRedirect } from './slug-redirect.service';
import { assertWithinLimit } from './plan-limit.service';

/**
 * Build a Prisma `AND` clause for a free-text product search.
 *
 * Splits the query on whitespace and requires EVERY word to appear (case-
 * insensitive `contains`) in at least one searchable field. This makes the
 * search order-independent and middle-word friendly: searching "بريتزوس مشكلة"
 * matches "مخبوزات بريتزوس مشكلة" because both words are present, and even a
 * reordered "مشكلة بريتزوس" matches. A single-word query behaves exactly as the
 * previous single `contains`. Returns an array suitable for spreading into
 * `where.AND` (empty when the query is blank).
 *
 * TOKEN CAP (adversarial audit P1-3): at most 8 tokens are used. Each token
 * expands into a 4-5 way OR of leading-wildcard ILIKEs, so an unbounded
 * whitespace-separated query string would multiply into hundreds of ILIKE
 * clauses from one crafted request. No legitimate product search needs more
 * than 8 words; extras are ignored.
 *
 * Exported for tests (the cap is otherwise unobservable from the route).
 *
 * @param search   raw query string
 * @param withSku  include the (English-only) SKU column — admin paths only
 */
export function buildProductSearchAnd(
  search: string | undefined | null,
  withSku: boolean
): Prisma.ProductWhereInput[] {
  const tokens = (search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return [];
  return tokens.map(token => {
    const or: Prisma.ProductWhereInput[] = [
      { name: { contains: token, mode: 'insensitive' } },
      { nameAr: { contains: token, mode: 'insensitive' } },
      { description: { contains: token, mode: 'insensitive' } },
      { descriptionAr: { contains: token, mode: 'insensitive' } },
    ];
    if (withSku) or.push({ sku: { contains: token, mode: 'insensitive' } });
    return { OR: or };
  });
}

/**
 * Compute availability flags for a product (and its variants) based on
 * inventory counts. Called on the public list + detail paths only — admin
 * routes return raw Prisma rows without these computed fields.
 *
 * Rules (product level):
 *   effectiveInventory = product has variants ? SUM(variant.inventory) : product.inventory
 *   inStock            = effectiveInventory > 0
 *   acceptsBackorder   = effectiveInventory <= 0 && (allowBackorder || any variant allows it)
 *   lowStock           = inStock && effectiveInventory <= lowStockThreshold
 *   availableQty       = exact qty when (lowStock || acceptsBackorder); null otherwise
 *                        (avoids leaking exact stock counts for normal in-stock products)
 *
 * IMPORTANT — variant aggregation: for a product WITH variants, the stock lives
 * on the variants and the product-level `inventory` column is unused (0). Using
 * it directly made variant products with in-stock variants show as "Sold Out".
 * So we aggregate variant inventory into the product's effective stock and also
 * overwrite the serialized `inventory` with that aggregate, so every storefront
 * surface that reads `p.inventory` (cards, PDP fallback, structured data) is
 * correct without each one needing variant data. This serializer runs on the
 * PUBLIC paths only — admin routes return raw rows.
 *
 * Variants inherit the parent's lowStockThreshold (no per-variant threshold).
 * Variants also inherit the parent's allowBackorder flag when their own is false.
 */
/**
 * Fields not in `AI_AUTOFILL_FIELDS` are excluded from that engine's 3-day
 * sweep + `/ai/reset-field` endpoint by design (same "excluded from v1"
 * treatment documented on the AEO fields) but are still AI-writable via a
 * standalone bulk sweep — currently `excerpt`/`excerptAr` (bulk-ai-excerpt).
 * Track this list here so the provenance map stays accurate.
 */
const MANUAL_PROVENANCE_FIELDS = ['excerpt', 'excerptAr'] as const;

/**
 * Mirrors `stampHumanEdits`' per-field diff for `MANUAL_PROVENANCE_FIELDS`:
 * a manual edit that changes the value stamps 'human' (so the admin
 * `AiFieldBadge` stops showing "✨ AI" after the merchant rewrites an
 * AI-drafted excerpt); clearing the field to empty removes the provenance
 * entry entirely.
 *
 * These fields deliberately keep the drop-on-clear behaviour that
 * `stampHumanEdits` no longer has. There, dropping the key let the autopilot
 * — which fires automatically on every save — undo the merchant's clear.
 * Nothing auto-fills an excerpt: only the merchant-triggered `bulk-ai-excerpt`
 * sweep writes these, and its contract is already "fill products with no
 * excerpt" regardless of provenance, so the stamp changes nothing there.
 */
function stampManualProvenance(
  sources: Record<string, 'ai' | 'human'>,
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, 'ai' | 'human'> {
  const next = { ...sources };
  for (const field of MANUAL_PROVENANCE_FIELDS) {
    if (!(field in incoming)) continue;
    const before = (stored[field] ?? '') as string;
    const after = (incoming[field] ?? '') as string;
    if (after === before) continue;
    if (String(after).trim() === '') {
      delete next[field];
    } else {
      next[field] = 'human';
    }
  }
  return next;
}

/**
 * Availability fields computed by `enrichStockFlags`. Declared explicitly so
 * the function's return type is `P & StockFlags` rather than the input type
 * erased down to its constraint — consumers (e.g. the AI product feed's
 * `buildProductFeed`, which reads `inStock`/`acceptsBackorder`) get compile-
 * time visibility of these fields instead of relying on `listPublic`
 * accidentally returning `any` (which the pre-2026-07-13 inner-cache
 * `JSON.parse` early-return used to cause — see the H1 note in
 * `docs/audits/2026-07-13-cache-stampede.md`).
 */
interface StockFlags {
  /** Variant-aware aggregate (sum of variant inventory for variant products). */
  inventory: number;
  inStock: boolean;
  lowStock: boolean;
  acceptsBackorder: boolean;
  /** Exact qty when (lowStock || acceptsBackorder); null otherwise. */
  availableQty: number | null;
}

export function enrichStockFlags<
  P extends {
    inventory: number;
    allowBackorder: boolean;
    lowStockThreshold: number;
    variants?: Array<{
      inventory: number;
      allowBackorder?: boolean;
      isActive?: boolean;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  },
>(product: P): P & StockFlags {
  const variants = product.variants ?? [];
  const hasVariants = variants.length > 0;
  // A disabled variant is not stock (#1103) — the same rule as
  // lib/effective-inventory.ts, which this must never disagree with.
  const sellable = activeVariants(variants);

  // Variant products: effective stock = sum of ACTIVE variant inventory (0 when
  // every variant is disabled). Single-SKU products keep their own column.
  const effectiveInventory = hasVariants
    ? sellable.reduce((sum, v) => sum + (v.inventory ?? 0), 0)
    : product.inventory;

  // Backorder is allowed when the product flag is set, or (for variant products)
  // any ACTIVE variant permits backorder.
  const productAllowsBackorder =
    product.allowBackorder || (hasVariants && sellable.some(v => v.allowBackorder === true));

  const inStock = effectiveInventory > 0;
  const lowStock = inStock && effectiveInventory <= product.lowStockThreshold;
  const acceptsBackorder = effectiveInventory <= 0 && productAllowsBackorder;
  const availableQty = lowStock || acceptsBackorder ? effectiveInventory : null;

  // `isActive` is read here and stripped: it drives the flags, it is not part
  // of the storefront variant shape.
  const enrichedVariants = variants.map(({ isActive, ...v }) => {
    const sellableVariant = isActive !== false;
    const vInStock = sellableVariant && v.inventory > 0;
    const vLowStock = vInStock && v.inventory <= product.lowStockThreshold;
    const vAcceptsBackorder =
      sellableVariant &&
      v.inventory <= 0 &&
      ((v.allowBackorder ?? false) || product.allowBackorder);
    const vAvailableQty = vLowStock || vAcceptsBackorder ? v.inventory : null;
    return {
      ...v,
      inStock: vInStock,
      lowStock: vLowStock,
      acceptsBackorder: vAcceptsBackorder,
      availableQty: vAvailableQty,
    };
  });

  // lowStockThreshold is only needed above to compute the `lowStock` flag —
  // the raw threshold number itself is never rendered by the storefront, so
  // it's dropped here rather than leaked through the `...product` spread.
  // (Return type stays `P & StockFlags`, not `Omit<P, 'lowStockThreshold'>`:
  // P carries a `[key: string]: unknown` index signature, so TS can't prove
  // Omit actually narrows it — the runtime strip below is what matters.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-discard
  const { lowStockThreshold: _lowStockThreshold, ...productWithoutThreshold } = product;

  return {
    ...productWithoutThreshold,
    // Surface the variant-aware aggregate as `inventory` so storefront cards,
    // structured data, and the PDP fallback all read the correct stock.
    inventory: effectiveInventory,
    inStock,
    lowStock,
    acceptsBackorder,
    availableQty,
    variants: enrichedVariants,
    // `unknown` first: TS can't prove Omit<P, 'lowStockThreshold'> overlaps
    // with the generic P & StockFlags target since P is arbitrary at the
    // call site — the runtime shape is correct (verified by the callers'
    // usage), this is a generic-cast limitation, not a real mismatch.
  } as unknown as P & StockFlags;
}

interface CreateProductData {
  name: string;
  /**
   * Free-text columns the merchant can empty from the edit form. `null`
   * clears, `undefined` leaves the stored value alone — the same convention
   * as `excerpt` / the SEO meta fields below. `name` is required and has no
   * null form.
   */
  nameAr?: string | null;
  slug?: string;
  description?: string | null;
  descriptionAr?: string | null;
  /** Short 1-2 sentence blurb — written by the bulk-ai-excerpt sweep or manually. */
  excerpt?: string | null;
  excerptAr?: string | null;
  price: number;
  /** Original/RRP shown struck-through next to the sale price. `null` clears it. */
  compareAtPrice?: number | null;
  /** Cost-of-goods in piastres. Used for profit reporting. */
  costPrice?: number | null;
  /** Admin-authored discount type — 'percentage' | 'fixed'. null clears. */
  discountType?: 'percentage' | 'fixed' | null;
  /**
   * Discount value:
   *   percentage → basis points (percent×100; 12.5% → 1250)
   *   fixed      → piastres
   * null when no discount.
   */
  discountValue?: number | null;
  /** `null` clears the SKU; `undefined` leaves the stored value alone. */
  sku?: string | null;
  inventory?: number;
  /** Per-product threshold for the LOW STOCK badge / merchant alerts. */
  lowStockThreshold?: number;
  status?: 'draft' | 'active' | 'archived';
  isFeatured?: boolean;
  isNew?: boolean;
  isBestSeller?: boolean;
  /**
   * Merchant-authored free-text card badge, bilingual. `null` clears,
   * `undefined` leaves the stored value alone — same convention as every
   * other nullable free-text column above. Already trimmed and length-checked
   * by `badgeLabelSchema` in product.routes.ts.
   */
  badgeLabel?: string | null;
  badgeLabelAr?: string | null;
  categories?: string[];
  images?: { url: string; alt?: string }[];
  /** SEO meta — set per-product or via the AI sweep. `null` clears. */
  metaTitle?: string | null;
  metaTitleAr?: string | null;
  metaDescription?: string | null;
  metaDescriptionAr?: string | null;
  /** AEO — conversational answer-engine copy. Separate from SEO meta. */
  metaDescriptionAeo?: string | null;
  metaDescriptionAeoAr?: string | null;
}

type UpdateProductData = Partial<CreateProductData>;

interface ListProductsOptions {
  page?: number;
  limit?: number;
  status?: string;
  category?: string;
  search?: string;
  featured?: boolean;
  /** Inclusive lower bound on `Product.price` (in piastres). */
  minPrice?: number;
  /** Inclusive upper bound on `Product.price` (in piastres). */
  maxPrice?: number;
  /** Filter to a specific list of product ids — used by page-builder
   *  ExtraCarousel with `productSource === 'manual'`. Capped at 50.
   *  When provided, all other filters apply on top. */
  ids?: string[];
  /** When true, augment each returned product with `soldQuantity` — the total
   *  units sold (sum of order_items.quantity for realized-sale orders). Used by
   *  the Inventory page's "Sales quantity" column. Computed with a single
   *  groupBy over the page window (no N+1). */
  withSalesQuantity?: boolean;
  /**
   * Variant-option facet filters. Each entry is an option name (e.g. "Size")
   * mapped to an array of selected values (e.g. ["Large", "XL"]).
   * Multiple values for the SAME option = OR (product must have at least one).
   * Multiple different option names = AND (product must satisfy all).
   * Absent = no filtering (identical to before for existing callers).
   */
  optionFilters?: Record<string, string[]>;
}

/** One facet group returned by listPublic alongside the products. */
export interface ProductFacet {
  name: string;
  nameAr?: string | null;
  values: Array<{ value: string; valueAr?: string | null }>;
}

/**
 * Build the Prisma `where` sub-clause for a single option facet filter.
 * A product satisfies the filter when it has a ProductOption with the given
 * `name` AND at least one of the `values` exists as a ProductOptionValue
 * linked to that option.
 *
 * Multiple calls (one per option name) are ANDed in the parent where clause.
 */
function buildOptionFilterClause(optionName: string, values: string[]): Prisma.ProductWhereInput {
  return {
    options: {
      some: {
        name: optionName,
        values: {
          some: {
            value: { in: values },
          },
        },
      },
    },
  };
}

/**
 * Compute available facets for the products matching the given `where` clause.
 * Returns distinct option names (with nameAr) and their distinct values
 * (with valueAr), scoped to products that pass ALL other filters (category,
 * price, search, etc.) but ignoring optionFilters themselves so the
 * unselected values remain visible.
 *
 * One query — aggregate via productOption join — no N+1.
 */
async function computeFacets(
  storeId: string,
  baseWhere: Prisma.ProductWhereInput
): Promise<ProductFacet[]> {
  // Fetch all (optionName, nameAr, value, valueAr) tuples for in-scope products.
  const rows = await prisma.productOption.findMany({
    where: {
      product: { ...baseWhere, storeId },
    },
    select: {
      name: true,
      nameAr: true,
      position: true,
      values: {
        select: { value: true, valueAr: true, position: true },
        orderBy: { position: 'asc' },
      },
    },
    orderBy: { position: 'asc' },
  });

  // Merge duplicate option names (same option may appear on many products).
  const facetMap = new Map<string, ProductFacet>();
  for (const opt of rows) {
    if (!facetMap.has(opt.name)) {
      facetMap.set(opt.name, { name: opt.name, nameAr: opt.nameAr, values: [] });
    }
    const facet = facetMap.get(opt.name)!;
    const existingValues = new Set(facet.values.map(v => v.value));
    for (const v of opt.values) {
      if (!existingValues.has(v.value)) {
        existingValues.add(v.value);
        facet.values.push({ value: v.value, valueAr: v.valueAr });
      }
    }
  }

  return Array.from(facetMap.values()).filter(f => f.values.length > 0);
}

// Order statuses that represent a realized sale (units that actually left
// inventory). pending / cancelled / refunded orders are excluded so "sales
// quantity" reflects net sold units rather than gross order lines.
const SOLD_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.confirmed,
  OrderStatus.processing,
  OrderStatus.shipped,
  OrderStatus.delivered,
];

interface AdvancedSearchOptions {
  page?: number;
  limit?: number;
  query?: string;
  categories?: string[];
  tags?: string[];
  minPrice?: number;
  maxPrice?: number;
  /** Tri-state: undefined = no filter; true / false filter (false = complement). */
  inStock?: boolean;
  onSale?: boolean;
  isNew?: boolean;
  featured?: boolean;
  sortBy?:
    | 'newest'
    | 'oldest'
    | 'price_asc'
    | 'price_desc'
    | 'name_asc'
    | 'name_desc'
    | 'popular'
    | 'rating';
}

/**
 * Storefront-safe scalar fields for Product — the shape unauthenticated
 * visitors (public product endpoints, guest cart, and the customer's own
 * order view) are allowed to see. Deliberately excludes: `costPrice` /
 * `lastCostUpdateAt` (wholesale cost — competitive intel), `aiFieldSources` /
 * `aiBalanceBackup` (internal AI provenance), `barcode` (internal SKU
 * lookup), and merchant-internal fields the storefront never renders
 * (`lowStockThreshold`, `trackInventory`, `weight`, `dimensions`, `featured`,
 * `viewCount`, `isBestSeller`, `newArrivalPosition`, `bestSellerPosition`,
 * `hasVariants`, `metaTitle(Ar)`, `citationCopy(Ar)`, `deletedAt`;
 * `discountType`/`discountValue` are the exception — kept because the
 * storefront discount badge reads them directly). `updatedAt` IS kept —
 * `sitemap.ts`'s `lastModified` and `product-feed.ts`'s `FeedProductInput`
 * both read it from the public products list. Reused by `listPublic`,
 * `getPublicBySlug`/`getPublicById`, `CartService`, and `OrderService` so
 * every surface that serializes a Product to an unauthenticated or
 * customer-facing response narrows the same way.
 */
export const STOREFRONT_PRODUCT_SELECT = {
  id: true,
  storeId: true,
  name: true,
  nameAr: true,
  slug: true,
  description: true,
  descriptionAr: true,
  excerpt: true,
  excerptAr: true,
  price: true,
  compareAtPrice: true,
  discountType: true,
  discountValue: true,
  sku: true,
  inventory: true,
  allowBackorder: true,
  status: true,
  metaDescription: true,
  metaDescriptionAr: true,
  metaDescriptionAeo: true,
  metaDescriptionAeoAr: true,
  isNew: true,
  // Merchant-authored card badge — the storefront renders it on every product
  // card and on the PDP, so it MUST cross the public boundary. Omitting it
  // here is the classic silent failure: the admin saves, the DB has the row,
  // and the card shows nothing.
  badgeLabel: true,
  badgeLabelAr: true,
  updatedAt: true,
  createdAt: true,
} as const satisfies Prisma.ProductSelect;

export class ProductService {
  static async list(storeId: string, options: ListProductsOptions = {}) {
    const { status, category, search, featured, ids, withSalesQuantity } = options;
    const page = Math.max(1, options.page || 1);
    // Cap matches the admin per-page selector's max option (500). 100 was
    // too low — merchants hitting 200/500 in the UI got silently
    // truncated to 100, which looked like "products are missing".
    const limit = Math.min(500, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = { storeId, deletedAt: null };

    if (status) {
      where.status = status as ProductStatus;
    }

    if (featured !== undefined) {
      where.featured = featured;
    }

    if (ids && ids.length > 0) {
      const safeIds = ids.slice(0, 50).filter(id => typeof id === 'string' && id.length > 0);
      if (safeIds.length > 0) where.id = { in: safeIds };
    }

    if (search) {
      // Match against both English and Arabic name/description so admins
      // searching in Arabic find their localized products. SKU stays
      // English-only because SKUs are merchant codes, not localized text.
      // Word-AND so any subset / reordering of words still matches (e.g.
      // "بريتزوس مشكلة" finds "مخبوزات بريتزوس مشكلة").
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...buildProductSearchAnd(search, true),
      ];
    }

    if (category) {
      where.categories = {
        some: { categoryId: category },
      };
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: {
          images: { orderBy: { position: 'asc' } },
          categories: { include: { category: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.product.count({ where }),
    ]);

    // Variant-aware stock total. For variant products the live stock lives on the
    // variants, not on `product.inventory` (which stays 0). One groupBy over the
    // page's product ids sums active-variant inventory — NOT a per-row query (no
    // N+1). `totalInventory` resolves to that sum for variant products, else to
    // the product's own inventory, so the admin list + inventory page show the
    // real on-hand figure.
    const variantSumByProduct = new Map<string, number>();
    if (products.length > 0) {
      const productIds = products.map(p => p.id);
      const variantGrouped = await prisma.productVariant.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds }, isActive: true },
        _sum: { inventory: true },
      });
      for (const row of variantGrouped) {
        variantSumByProduct.set(row.productId, row._sum.inventory ?? 0);
      }
    }
    const withTotalInventory = products.map(p => ({
      ...p,
      totalInventory: p.hasVariants ? (variantSumByProduct.get(p.id) ?? 0) : p.inventory,
    }));

    // Sales quantity = SUM(order_items.quantity) per product, restricted to the
    // products on THIS page and to realized-sale order statuses. One groupBy for
    // the whole page window — NOT a per-row query (no N+1). Off by default so the
    // catalogue list path stays cheap; only the Inventory page opts in.
    let productsOut:
      | typeof withTotalInventory
      | Array<(typeof withTotalInventory)[number] & { soldQuantity: number }> = withTotalInventory;
    if (withSalesQuantity && withTotalInventory.length > 0) {
      const productIds = withTotalInventory.map(p => p.id);
      const grouped = await prisma.orderItem.groupBy({
        by: ['productId'],
        where: {
          productId: { in: productIds },
          order: { storeId, status: { in: SOLD_ORDER_STATUSES } },
        },
        _sum: { quantity: true },
      });
      const soldByProduct = new Map<string, number>();
      for (const row of grouped) {
        soldByProduct.set(row.productId, row._sum.quantity ?? 0);
      }
      productsOut = withTotalInventory.map(p => ({
        ...p,
        soldQuantity: soldByProduct.get(p.id) ?? 0,
      }));
    }

    return {
      products: productsOut,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getById(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        store: { select: { id: true, name: true, slug: true } },
        // The admin detail page only needs the variant-aware total (it has a
        // dedicated /variants page for the rows), but admin_get_product (MCP)
        // maps id/name/sku/price off these same rows — select them too so
        // that mapping isn't silently undefined. Additive, so it doesn't
        // change what the admin detail page renders. `title` is the actual
        // Prisma field (ProductVariant has no `name` column) — the MCP tool
        // maps it to the response's `name` key. `isActive` feeds
        // effectiveInventory: a disabled variant is not stock (#1103).
        variants: {
          select: {
            id: true,
            title: true,
            sku: true,
            price: true,
            inventory: true,
            isActive: true,
          },
        },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Same `totalInventory` contract the admin product LIST already returns
    // (see listForAdmin ~:514): for a variant product `product.inventory` is
    // not stock, so the detail page must not render it. Until 2026-08-30 it
    // did, which is where the merchant saw "-16 in stock".
    return {
      ...product,
      totalInventory: effectiveInventory(product),
    };
  }

  static async getBySlug(storeId: string, slug: string) {
    const product = await prisma.product.findFirst({
      where: { slug, storeId },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    return product;
  }

  /**
   * Invalidate caches related to a store's products and categories.
   * Best-effort: failures are logged but do not throw.
   *
   * Both cache layers are cleared: `invalidateStoreProductCaches` sweeps the
   * product list / detail / suggest keys from Redis (SCAN+UNLINK) AND the
   * in-memory fallback, so a price/stock correction is visible on every
   * replica immediately rather than lingering on other pods until the TTL.
   */
  private static async invalidateStoreProductCache(storeId: string): Promise<void> {
    try {
      await redis.delete(`categories:store:${storeId}`);
      await redis.delete(`public:categories:${storeId}`);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown', storeId },
        '[PRODUCT] Redis cache invalidation failed'
      );
    }
    // Clear product list / detail / suggest caches (both Redis + in-memory,
    // public AND admin). Shared with OrderService's checkout-driven
    // inventory paths so the key definition lives in exactly one place.
    // invalidateStoreProductCaches already clears the category caches and
    // purges the `categories:` tag in the same request, so a second
    // invalidateStoreCategoriesCaches here only sent a duplicate purge (#1220).
    await invalidateStoreProductCaches(storeId);
  }

  /**
   * Verify every supplied categoryId belongs to this store before linking.
   *
   * `bulkUpdate.addCategoryId` has carried this guard (and a comment naming
   * this exact attack) since it shipped; plain create/update never got it, so
   * a store-A admin could link their products to store-B categories straight
   * from the request body.
   */
  private static async assertCategoriesInStore(
    storeId: string,
    categoryIds: string[] | undefined
  ): Promise<void> {
    const ids = [...new Set(categoryIds ?? [])];
    if (ids.length === 0) return;
    const found = await prisma.category.findMany({
      where: { id: { in: ids }, storeId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found in this store');
    }
  }

  static async create(storeId: string, data: CreateProductData) {
    // Plan ceiling (SP5): one more product must fit the store's maxProducts.
    await assertWithinLimit(storeId, 'maxProducts');
    await this.assertCategoriesInStore(storeId, data.categories);
    // slugifyWithFallback, never bare slugify: a name that slugifies to '' (no
    // letters/digits, or a product created before its name was filled in) gave
    // baseSlug = '', so the de-duplication loop below produced '', '-1', '-2'.
    // Five products on a live store ended up that way; the '' one was
    // unreachable entirely because its URL collapses to the product listing.
    const baseSlug = slugifyWithFallback(data.slug || data.name, 'product');

    // Auto-deduplicate slug: append -1, -2, etc. if exists
    let slug = baseSlug;
    let suffix = 0;
    while (await prisma.product.findFirst({ where: { storeId, slug } })) {
      suffix++;
      if (suffix > 100) throw new AppError(409, 'SLUG_COLLISION', 'Too many slug collisions');
      slug = `${baseSlug}-${suffix}`;
    }

    // Any AI-writable field the merchant filled in AT CREATE TIME is their own
    // — stamp it 'human' so the autofill engine never overwrites it. Fields
    // left empty get no entry and remain fillable by the engine.
    const aiFieldSources = stampManualProvenance(
      stampHumanEdits({}, {}, data as unknown as Record<string, unknown>),
      {},
      data as unknown as Record<string, unknown>
    );

    const product = await prisma.product.create({
      data: {
        storeId,
        name: data.name,
        nameAr: data.nameAr,
        aiFieldSources,
        slug,
        description: data.description,
        descriptionAr: data.descriptionAr,
        excerpt: data.excerpt ?? null,
        excerptAr: data.excerptAr ?? null,
        price: data.price,
        compareAtPrice: data.compareAtPrice ?? null,
        costPrice: data.costPrice ?? null,
        // Discount input columns — stored verbatim; the admin form pre-derives
        // price/compareAtPrice before sending, so the service just persists.
        discountType: data.discountType ?? null,
        discountValue: data.discountValue ?? null,
        sku: data.sku,
        inventory: data.inventory ?? 0,
        ...(data.lowStockThreshold !== undefined
          ? { lowStockThreshold: data.lowStockThreshold }
          : {}),
        status: data.status ?? 'draft',
        featured: data.isFeatured ?? false,
        isNew: data.isNew ?? false,
        isBestSeller: data.isBestSeller ?? false,
        badgeLabel: data.badgeLabel ?? null,
        badgeLabelAr: data.badgeLabelAr ?? null,
        images: data.images
          ? {
              create: data.images.map((img, index) => ({
                url: img.url,
                alt: img.alt || data.name,
                position: index,
              })),
            }
          : undefined,
        categories: data.categories
          ? {
              create: data.categories.map(categoryId => ({
                categoryId,
              })),
            }
          : undefined,
      },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
      },
    });

    await this.invalidateStoreProductCache(storeId);

    // Fire product.upserted for Meta Catalog sync (Phase A — native catalog bot).
    // Fire-and-forget: catalog sync failure must never block the product save.
    void inngest
      .send({
        name: 'product.upserted' as any,
        data: { storeId, productId: product.id, op: 'create', changedFields: [] },
      })
      .catch(err =>
        logger.warn({ err, productId: product.id }, '[product.create] inngest send failed')
      );

    // #1937: kick the recommendations sweep HERE, at the one true creation
    // site, rather than in the debounced `product.upserted` Inngest
    // consumer's `op === 'create'` branch (that handler delivers only the
    // LAST event in its 10s window, so a create-then-quick-edit silently
    // dropped the kick). The helper queues itself with
    // `deferAfterTenantCommit`, so inside a request it runs AFTER this
    // create commits (never publishing a jobId for an uncommitted row) and
    // a rolled-back create drops it; awaiting it costs nothing when deferred.
    await enqueueRecommendationsSweepForNewProduct(storeId, product.id);

    return product;
  }

  static async update(storeId: string, productId: string, data: UpdateProductData) {
    await this.assertCategoriesInStore(storeId, data.categories);
    const product = await this.getById(storeId, productId);

    // Money guard: a fixed discount must never exceed the price (would store a
    // negative sale price). The route schema catches this when the PATCH sends
    // both `price` and `discountValue`; this covers the update-only case where
    // the merchant changes the discount alone and `price` is read from the DB.
    const effectiveType =
      data.discountType !== undefined ? data.discountType : product.discountType;
    const effectiveDiscount =
      data.discountValue !== undefined ? data.discountValue : product.discountValue;
    const effectivePrice = data.price !== undefined ? data.price : product.price;
    if (
      effectiveType === 'fixed' &&
      typeof effectiveDiscount === 'number' &&
      typeof effectivePrice === 'number' &&
      effectiveDiscount > effectivePrice
    ) {
      throw new AppError(
        400,
        'INVALID_DISCOUNT',
        'Fixed discount cannot exceed the price (would produce a negative sale price).'
      );
    }

    // Auto-deduplicate slug if changing
    let finalSlug = data.slug;
    if (finalSlug && finalSlug !== product.slug) {
      const baseSlug = finalSlug;
      let suffix = 0;
      while (
        await prisma.product.findFirst({
          where: { storeId, slug: finalSlug, id: { not: productId } },
        })
      ) {
        suffix++;
        if (suffix > 100) throw new AppError(409, 'SLUG_COLLISION', 'Too many slug collisions');
        finalSlug = `${baseSlug}-${suffix}`;
      }
    }

    // Snapshot the URLs we're about to drop so we can run the R2-side
    // cleanup AFTER the transaction commits. Doing the diff up front
    // means we don't have to round-trip back to the DB to figure out
    // what disappeared.
    const previousImageUrls = product.images?.map(i => i.url) ?? [];
    const nextImageUrls = data.images?.map(i => i.url) ?? previousImageUrls;

    // Which fields relevant to AI autofill changed in this PATCH? Include BOTH
    // the AI-writable fields themselves AND their English source fields
    // (`name`/`description`) — when a merchant renames a product the derived
    // Arabic/SEO fields must refresh, and that's keyed off the source changing,
    // not the derived field. Omitting the sources left the refresh path dead.
    const autofillRelevantFields = [...AI_AUTOFILL_FIELD_NAMES, 'name', 'description'];
    const changedFields = autofillRelevantFields.filter(
      f =>
        f in (data as Record<string, unknown>) &&
        ((data as Record<string, unknown>)[f] ?? '') !==
          ((product as Record<string, unknown>)[f] ?? '')
    );
    // Stamp human ownership on the fields they changed so the AI engine never
    // overwrites them.
    const nextSources = stampManualProvenance(
      stampHumanEdits(
        (product.aiFieldSources as Record<string, 'ai' | 'human'>) ?? {},
        product as Record<string, unknown>,
        data as Record<string, unknown>
      ),
      product as Record<string, unknown>,
      data as Record<string, unknown>
    );

    // Wrap image/category replacement and product update in a transaction
    // so that a failure mid-way does not leave orphaned or missing relations.
    const updatedProduct = await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      // If images are provided, replace all existing images
      if (data.images !== undefined) {
        await tx.productImage.deleteMany({ where: { productId } });
        if (data.images.length > 0) {
          await tx.productImage.createMany({
            data: data.images.map((img, index) => ({
              productId,
              url: img.url,
              alt: img.alt || data.name || product.name,
              position: index,
            })),
          });
        }
      }

      // If categories are provided, replace the associations — but PRESERVE the
      // merchant's per-category drag-sort `position`. Previously this blindly
      // deleted + recreated every ProductCategory row with the default position
      // (0), so ANY product save that included `categories` (e.g. toggling a
      // product out of stock) reset its position to 0 → it jumped to the front
      // of every category listing. Re-use the saved position for links that
      // remain; only genuinely-new category links default to 0.
      if (data.categories !== undefined) {
        const existingLinks = await tx.productCategory.findMany({
          where: { productId },
          select: { categoryId: true, position: true },
        });
        const positionByCategory = new Map(existingLinks.map(l => [l.categoryId, l.position]));
        await tx.productCategory.deleteMany({ where: { productId } });
        if (data.categories.length > 0) {
          await tx.productCategory.createMany({
            data: data.categories.map(categoryId => ({
              productId,
              categoryId,
              position: positionByCategory.get(categoryId) ?? 0,
            })),
          });
        }
      }

      const updated = await tx.product.update({
        where: { id: productId, storeId },
        data: {
          name: data.name,
          slug: finalSlug,
          // Free text the merchant can empty — accept only when present in
          // the patch: `null` clears the column, an omitted key leaves it
          // alone. Same convention as excerpt / SEO meta below.
          ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.descriptionAr !== undefined ? { descriptionAr: data.descriptionAr } : {}),
          // Excerpt — null clears (bulk-sweep/manual clear), undefined leaves
          // the existing value alone, same convention as SEO meta below.
          ...(data.excerpt !== undefined ? { excerpt: data.excerpt } : {}),
          ...(data.excerptAr !== undefined ? { excerptAr: data.excerptAr } : {}),
          price: data.price,
          // Pass through only when present in the patch — undefined leaves
          // the existing value, explicit null clears it. Same convention
          // as the curated flags below.
          ...(data.compareAtPrice !== undefined ? { compareAtPrice: data.compareAtPrice } : {}),
          ...(data.costPrice !== undefined ? { costPrice: data.costPrice } : {}),
          // Discount input columns — same undefined/null convention.
          ...(data.discountType !== undefined ? { discountType: data.discountType } : {}),
          ...(data.discountValue !== undefined ? { discountValue: data.discountValue } : {}),
          ...(data.sku !== undefined ? { sku: data.sku } : {}),
          // Card badge — null clears, an omitted key leaves it alone. Same
          // convention as nameAr / description / excerpt above.
          ...(data.badgeLabel !== undefined ? { badgeLabel: data.badgeLabel } : {}),
          ...(data.badgeLabelAr !== undefined ? { badgeLabelAr: data.badgeLabelAr } : {}),
          inventory: data.inventory,
          ...(data.lowStockThreshold !== undefined
            ? { lowStockThreshold: data.lowStockThreshold }
            : {}),
          status: data.status,
          // Curated flags driven by the admin product edit form. We accept
          // them only when explicitly present in the patch so callers that
          // omit them don't accidentally clear the existing value.
          ...(data.isFeatured !== undefined ? { featured: data.isFeatured } : {}),
          ...(data.isNew !== undefined ? { isNew: data.isNew } : {}),
          ...(data.isBestSeller !== undefined ? { isBestSeller: data.isBestSeller } : {}),
          // SEO — accept only when present so omitting them doesn't clear.
          ...(data.metaTitle !== undefined ? { metaTitle: data.metaTitle } : {}),
          ...(data.metaTitleAr !== undefined ? { metaTitleAr: data.metaTitleAr } : {}),
          ...(data.metaDescription !== undefined ? { metaDescription: data.metaDescription } : {}),
          ...(data.metaDescriptionAr !== undefined
            ? { metaDescriptionAr: data.metaDescriptionAr }
            : {}),
          // AEO — separate conversational copy column.
          ...(data.metaDescriptionAeo !== undefined
            ? { metaDescriptionAeo: data.metaDescriptionAeo }
            : {}),
          ...(data.metaDescriptionAeoAr !== undefined
            ? { metaDescriptionAeoAr: data.metaDescriptionAeoAr }
            : {}),
          aiFieldSources: nextSources,
        },
        include: {
          images: { orderBy: { position: 'asc' } },
          categories: { include: { category: true } },
        },
      });

      if (data.slug && finalSlug !== product.slug) {
        await recordSlugRedirect(tx, storeId, SlugEntityType.PRODUCT, product.slug, finalSlug!);
      }

      return updated;
    });

    await this.invalidateStoreProductCache(storeId);

    // Fire product.upserted for Meta Catalog sync. Fire-and-forget.
    void inngest
      .send({
        name: 'product.upserted' as any,
        data: { storeId, productId, op: 'update', changedFields },
      })
      .catch(err => logger.warn({ err, productId }, '[product.update] inngest send failed'));

    // Fire-and-forget R2 cleanup for any image URL that disappeared
    // during this update. Runs AFTER the transaction commits so a
    // transient R2 hiccup can't roll back legitimate DB edits, and
    // so isStillReferenced() sees the post-write state. We don't
    // await — the merchant's save shouldn't pay R2 round-trip
    // latency.
    if (data.images !== undefined) {
      void cleanupRemovedImages(previousImageUrls, nextImageUrls).catch(err =>
        logger.warn({ err, productId }, '[product.update] r2 cleanup failed')
      );
    }

    return updatedProduct;
  }

  static async delete(storeId: string, productId: string) {
    // Soft-delete keeps the row + child rows around so the deletion
    // is reversible (admin restore flow). DON'T touch R2 here — those
    // images need to survive in case the merchant restores. The
    // hard-delete path (orphan-audit script + future "purge soft-
    // deleted" job) is what cleans up R2 long-term.
    await this.getById(storeId, productId);

    await prisma.product.update({
      where: { id: productId, storeId },
      data: { deletedAt: new Date() },
    });

    await this.invalidateStoreProductCache(storeId);

    // Fire product.deleted for Meta Catalog sync. Fire-and-forget.
    void inngest
      .send({ name: 'product.deleted' as any, data: { storeId, productId } })
      .catch(err => logger.warn({ err, productId }, '[product.delete] inngest send failed'));
  }

  static async updateInventory(storeId: string, productId: string, quantity: number) {
    await this.getById(storeId, productId);

    const updated = await prisma.product.update({
      where: { id: productId, storeId },
      data: { inventory: quantity },
    });

    await this.invalidateStoreProductCache(storeId);

    return updated;
  }

  /**
   * Bulk-set the low-stock threshold for a set of products in a store.
   * A single store-scoped updateMany so a tenant can only ever touch its own
   * products. Returns the affected count.
   */
  static async bulkSetLowStockThreshold(storeId: string, productIds: string[], threshold: number) {
    const safeIds = productIds.filter(id => typeof id === 'string' && id.length > 0);
    if (safeIds.length === 0) {
      return { count: 0 };
    }

    const result = await prisma.product.updateMany({
      where: { storeId, id: { in: safeIds }, deletedAt: null },
      data: { lowStockThreshold: threshold },
    });

    await this.invalidateStoreProductCache(storeId);

    return result;
  }

  /**
   * Bulk-update a set of products in a single store.
   *
   * Fields:
   *   status / isFeatured / isNew / isBestSeller → updateMany (all products)
   *   addCategoryId → upsert ProductCategory link per product (append-only)
   *   price.set → updateMany on SIMPLE products only (variant products skipped)
   *   price.adjustPct → read each then update (simple products only), rounded to integer piastres, ≥0
   *   inventory.set / adjust → same simple-product-only rule
   *
   * Returns { updated, skippedVariantProducts }.
   */
  static async bulkUpdate(
    storeId: string,
    productIds: string[],
    fields: {
      status?: 'draft' | 'active' | 'archived';
      addCategoryId?: string;
      isFeatured?: boolean;
      isNew?: boolean;
      isBestSeller?: boolean;
      price?: { mode: 'set' | 'adjustPct'; value: number };
      inventory?: { mode: 'set' | 'adjust'; value: number };
    }
  ): Promise<{ updated: number; skippedVariantProducts: number }> {
    const safeIds = productIds.filter(id => typeof id === 'string' && id.length > 0);
    if (safeIds.length === 0) return { updated: 0, skippedVariantProducts: 0 };

    // Resolve ids that actually belong to this store and are not deleted.
    const existing = await prisma.product.findMany({
      where: { storeId, id: { in: safeIds }, deletedAt: null },
      select: { id: true, hasVariants: true, price: true, inventory: true },
    });

    if (existing.length === 0) return { updated: 0, skippedVariantProducts: 0 };

    const allIds = existing.map(p => p.id);
    const simpleProducts = existing.filter(p => !p.hasVariants);
    const simpleIds = simpleProducts.map(p => p.id);
    // Only count variant products as "skipped" when a price or inventory
    // mutation was requested — a status/flags-only edit isn't skipping anything.
    const variantCount = existing.filter(p => p.hasVariants).length;
    const skippedVariantProducts =
      fields.price !== undefined || fields.inventory !== undefined ? variantCount : 0;

    // --- 1. Scalar flags (all products, updateMany) ---
    const scalarData: Record<string, unknown> = {};
    if (fields.status !== undefined) scalarData.status = fields.status;
    if (fields.isFeatured !== undefined) scalarData.featured = fields.isFeatured;
    if (fields.isNew !== undefined) scalarData.isNew = fields.isNew;
    if (fields.isBestSeller !== undefined) scalarData.isBestSeller = fields.isBestSeller;

    if (Object.keys(scalarData).length > 0) {
      await prisma.product.updateMany({
        where: { storeId, id: { in: allIds }, deletedAt: null },
        data: scalarData,
      });
    }

    // --- 2. Category link (additive, per-product) ---
    if (fields.addCategoryId) {
      const categoryId = fields.addCategoryId;

      // Guard: verify the category belongs to this store before linking.
      // Without this check a store-A admin could supply a store-B categoryId
      // and link their products to a foreign category.
      const categoryExists = await prisma.category.findFirst({
        where: { id: categoryId, storeId },
        select: { id: true },
      });
      if (!categoryExists) {
        throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found in this store');
      }

      // Fetch current links so we only insert missing ones.
      const existingLinks = await prisma.productCategory.findMany({
        where: { productId: { in: allIds }, categoryId },
        select: { productId: true },
      });
      const alreadyLinked = new Set(existingLinks.map(l => l.productId));
      const toLink = allIds.filter(id => !alreadyLinked.has(id));

      if (toLink.length > 0) {
        // Max position for this category across all products already in it.
        const maxPos = await prisma.productCategory.aggregate({
          where: { categoryId },
          _max: { position: true },
        });
        const startPos = (maxPos._max.position ?? -1) + 1;

        await prisma.productCategory.createMany({
          data: toLink.map((productId, idx) => ({
            productId,
            categoryId,
            position: startPos + idx,
          })),
          skipDuplicates: true,
        });
      }
    }

    // Chunked sequential execution helper — avoids flooding the connection
    // pool with up to 500 concurrent Prisma calls (P2024 connection starvation).
    async function runChunked<T>(
      items: T[],
      chunkSize: number,
      fn: (item: T) => Promise<unknown>
    ): Promise<void> {
      for (let i = 0; i < items.length; i += chunkSize) {
        await Promise.all(items.slice(i, i + chunkSize).map(fn));
      }
    }

    // --- 3. Price (simple products only) ---
    if (fields.price && simpleIds.length > 0) {
      const { mode, value } = fields.price;
      if (mode === 'set') {
        const piastres = Math.max(0, Math.round(value));
        await prisma.product.updateMany({
          where: { storeId, id: { in: simpleIds }, deletedAt: null },
          data: { price: piastres },
        });
      } else {
        // adjustPct: value is a percentage like -10 (10% off) or +5 (5% up).
        // Clamp the result to [0, MAX_INT4] to prevent Postgres int4 overflow
        // regardless of what percentage or base price is passed.
        const MAX_INT4 = 2_147_483_647;
        const pct = value / 100;
        // Run in chunks of 20 to avoid pool exhaustion (up to 500 items).
        await runChunked(simpleProducts, 20, p => {
          const newPrice = Math.min(MAX_INT4, Math.max(0, Math.round(p.price * (1 + pct))));
          return prisma.product.update({ where: { id: p.id, storeId }, data: { price: newPrice } });
        });
      }
    }

    // --- 4. Inventory (simple products only) ---
    if (fields.inventory && simpleIds.length > 0) {
      const { mode, value } = fields.inventory;
      if (mode === 'set') {
        const qty = Math.max(0, Math.round(value));
        await prisma.product.updateMany({
          where: { storeId, id: { in: simpleIds }, deletedAt: null },
          data: { inventory: qty },
        });
      } else {
        // adjust: add delta, floor at 0.
        // Run in chunks of 20 to avoid pool exhaustion.
        await runChunked(simpleProducts, 20, p => {
          const newQty = Math.max(0, p.inventory + Math.round(value));
          return prisma.product.update({
            where: { id: p.id, storeId },
            data: { inventory: newQty },
          });
        });
      }
    }

    await this.invalidateStoreProductCache(storeId);

    // `updated` = products that received at least one mutation. Any scalar / flag
    // / category field runs an updateMany over ALL matched ids (variant products
    // included), so when one of those is present the count is allIds.length. Only
    // when the request is price/inventory-ONLY do we report the simple-product
    // count (variant products are skipped for price/inventory). The previous
    // formula wrongly returned 0 for e.g. {status, price} on all-variant products.
    const hasScalarOrCategoryField =
      fields.status !== undefined ||
      fields.isFeatured !== undefined ||
      fields.isNew !== undefined ||
      fields.isBestSeller !== undefined ||
      fields.addCategoryId !== undefined;
    const actuallyUpdated = hasScalarOrCategoryField ? allIds.length : simpleIds.length;

    return { updated: actuallyUpdated, skippedVariantProducts };
  }

  // Public methods (no store scope required)
  static async listPublic(
    storeId: string,
    options: ListProductsOptions & {
      sort?: 'newest' | 'price_asc' | 'price_desc' | 'best_seller';
      cursor?: string;
    } = {}
  ) {
    const {
      status = 'active',
      category,
      search,
      featured,
      minPrice,
      maxPrice,
      sort,
      cursor,
      ids,
      optionFilters,
    } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));

    // Scaling-cliff guard (CLAUDE.md rule 3): offset pagination is O(n) at the
    // DB level — `?page=10000&limit=100` would force Postgres to scan the
    // first 1M rows. A bot or crawler probing the catalog endpoint at that
    // depth would burn the DB. Hard-cap the effective skip at 10000 rows so
    // even adversarial query strings can't trigger the cliff. Legitimate
    // pagination tops out around ~50 pages at any realistic catalog size;
    // beyond that the storefront UX should switch to cursor anyway (see
    // `cursor` param below).
    const MAX_SKIP = 10_000;
    const requestedSkip = (page - 1) * limit;
    const skip = cursor ? 0 : Math.min(requestedSkip, MAX_SKIP);
    const skipCapped = requestedSkip > MAX_SKIP;

    // NOTE: no per-call Redis cache here. `listPublic`'s only caller
    // (`/public/products` in `public.routes.ts`) already wraps this whole
    // method in `getCached()` under `public:products:<storeId>:...`, which
    // is single-flight-safe AND correctly swept by `invalidateStoreProductCaches`
    // on every product/price/stock mutation. A second, redundant cache layer
    // used to live here under a DIFFERENT key prefix (`products:store:*`) that
    // `invalidateStoreProductCaches` never touched — so a merchant's price/stock
    // edit would correctly bust the outer cache, then the very next request would
    // read this inner cache's stale value and write it straight back into the
    // freshly-busted outer cache, silently resurrecting stale data for another
    // TTL window. Removed rather than added to the invalidation sweep: it was
    // pure double-caching with no caller that needed the extra layer. See
    // `docs/audits/2026-07-13-cache-stampede.md` (H1).
    const where: Prisma.ProductWhereInput = {
      storeId,
      status: status as ProductStatus,
      deletedAt: null,
    };

    if (featured !== undefined) {
      where.featured = featured;
    }

    if (ids && ids.length > 0) {
      // Cap at 50 to match the zod max on layout.extracarousels[].manualProductIds.
      // Prevents accidental over-fetch via a crafted ?ids=… with hundreds of values.
      const safeIds = ids.slice(0, 50).filter(id => typeof id === 'string' && id.length > 0);
      if (safeIds.length > 0) {
        where.id = { in: safeIds };
      }
    }

    if (search) {
      // Mirror admin list(): match both English + Arabic so storefront
      // shoppers searching in either language find the right products.
      // Word-AND so any subset / reordering of words still matches.
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...buildProductSearchAnd(search, false),
      ];
    }

    // Resolve category slug → ID so we can filter by categoryId and apply the
    // merchant-defined per-category product position. We look up once and reuse
    // the ID in both the where clause and the position-ordered path below.
    let resolvedCategoryId: string | undefined;
    if (category) {
      const cat = await prisma.category.findFirst({
        where: { storeId, slug: category, deletedAt: null },
        select: { id: true },
      });
      if (cat) {
        resolvedCategoryId = cat.id;
        where.categories = {
          some: { categoryId: resolvedCategoryId },
        };
      } else {
        // Unknown slug — fall back to the slug-match path (handles future
        // virtual categories or slug changes) so nothing regresses.
        where.categories = {
          some: { category: { slug: category } },
        };
      }
    }

    if (minPrice !== undefined) {
      where.price = { ...((where.price as object) || {}), gte: minPrice };
    }
    if (maxPrice !== undefined) {
      where.price = { ...((where.price as object) || {}), lte: maxPrice };
    }

    // Snapshot the where clause BEFORE option filters for facet computation.
    // Facets are scoped to category/price/search context (so "Size" shows all
    // sizes available in that category) but ignore active option selections
    // (standard faceted-search UX: deselected values remain visible).
    const whereForFacets = { ...where };

    // Variant-option facet filters: each option name → selected values.
    // Multiple values within one option = OR; multiple option names = AND.
    if (optionFilters) {
      const optionEntries = Object.entries(optionFilters).filter(([, vals]) => vals.length > 0);
      if (optionEntries.length > 0) {
        const optionClauses = optionEntries.map(([name, vals]) =>
          buildOptionFilterClause(name, vals)
        );
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          ...optionClauses,
        ];
      }
    }

    // `sort=best_seller` is curator-driven: filter to manually-flagged items
    // so the storefront's Best Sellers carousel reflects the merchant's
    // explicit picks rather than algorithmic guesses.
    if (sort === 'best_seller') {
      where.isBestSeller = true;
    }

    // `sort=newest` is used by the New Arrivals homepage carousel — filter to
    // isNew=true so the carousel only shows products the merchant has explicitly
    // flagged as new arrivals.
    if (sort === 'newest') {
      where.isNew = true;
    }

    let orderBy: Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[] =
      {
        createdAt: 'desc',
      };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    else if (sort === 'price_desc') orderBy = { price: 'desc' };
    // Best Sellers: order by merchant-set bestSellerPosition ASC, then createdAt
    // DESC as a stable tiebreaker for products that share the default position (0).
    // `featured` was the old tiebreaker but position is more predictable.
    else if (sort === 'best_seller')
      orderBy = [{ bestSellerPosition: 'asc' }, { createdAt: 'desc' }];
    // New Arrivals: order by merchant-set newArrivalPosition ASC, then createdAt
    // DESC so newly-flagged products appear naturally until the merchant reorders.
    else if (sort === 'newest') orderBy = [{ newArrivalPosition: 'asc' }, { createdAt: 'desc' }];
    // When no explicit sort is requested AND we're filtering by a known single
    // category, use the merchant-defined per-category product order. Prisma
    // cannot order Product rows by a join-table column directly, so we query
    // from ProductCategory (ordered by position ASC, then createdAt DESC as a
    // stable tiebreaker) and collect product IDs in that order. The main
    // findMany is then an `id IN (...)` query with post-sort by the id-order
    // array. This is a two-round-trip approach but the category page is
    // already cached for 120 s, so the extra query is cold-path only.
    else if (!sort && resolvedCategoryId) {
      // Fast path: fetch only the ordered IDs from the tiny join table.
      const orderedLinks = await prisma.productCategory.findMany({
        where: { categoryId: resolvedCategoryId },
        orderBy: [{ position: 'asc' }, { product: { createdAt: 'desc' } }],
        select: { productId: true },
      });
      const orderedIds = orderedLinks.map(l => l.productId);
      // Narrow the product WHERE to IDs that match all the other filters too.
      // The final sort preserves the position order via a JS re-sort after
      // the DB returns results so offset pagination stays correct.
      if (orderedIds.length > 0) {
        where.id = { in: orderedIds };
        // null orderBy so Prisma uses whatever index it wants; we sort in JS.
        orderBy = { createdAt: 'desc' };
      }

      // Override the baseFindManyArgs below to re-sort by position after fetch.
      const positionFindArgs = {
        where,
        // Explicit select (not include) — storefront-safe scalars only, plus
        // lowStockThreshold which enrichStockFlags needs for its lowStock
        // computation but strips before the row is returned. See T-H1.
        select: {
          ...STOREFRONT_PRODUCT_SELECT,
          lowStockThreshold: true,
          images: { orderBy: { position: 'asc' } as const, take: 2 }, // 2 images: primary + hover-reveal second on cards
          categories: { include: { category: true } },
          options: LISTING_SWATCH_OPTIONS_SELECT,
          store: { select: { id: true, name: true, slug: true } },
          variants: {
            select: {
              id: true,
              price: true,
              compareAtPrice: true,
              inventory: true,
              allowBackorder: true,
              // Stock only — enrichStockFlags reads and strips it (#1103).
              isActive: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' as const },
      };

      const [allMatchingRaw, total, facets] = await Promise.all([
        prisma.product.findMany(positionFindArgs),
        prisma.product.count({ where }),
        computeFacets(storeId, whereForFacets),
      ]);

      // Re-sort by the orderedIds position array so the DB result order is
      // irrelevant. Products not in orderedIds (new, added after the sort was
      // set) fall to the end.
      const posMap = new Map(orderedIds.map((id, i) => [id, i]));
      const allSorted = allMatchingRaw.sort((a, b) => {
        const pa = posMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const pb = posMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return pa - pb;
      });

      // Page mode: the offset window. Cursor mode (#1371): real keyset paging
      // over the merchant-ordered list — the cursor is the id of the LAST row
      // the client already has, so the page starts right after it. This used
      // to be `allSorted.slice(1, limit + 1)` whatever the cursor said, so
      // every cursor request (and its 120s cache entry) got the same wrong
      // window. An id that is no longer in the list (product removed from the
      // category, or not in it at all) yields an empty page rather than a
      // silent restart from the top.
      let page_products: typeof allSorted;
      let nextCursor: string | undefined;
      if (cursor) {
        const at = allSorted.findIndex(p => p.id === cursor);
        const after = at === -1 ? [] : allSorted.slice(at + 1);
        page_products = after.slice(0, limit);
        nextCursor = after.length > limit ? page_products[limit - 1].id : undefined;
      } else {
        page_products = allSorted.slice(skip, skip + limit);
      }

      const result = {
        // No type-erasing cast here: keeping the precise Prisma payload type
        // means `listPublic`'s return carries id/name/slug/images/categories
        // etc. for consumers like the AI product feed to typecheck against.
        products: page_products.map(p => enrichStockFlags(p)),
        facets,
        meta: {
          page: cursor ? undefined : page,
          limit,
          total,
          totalPages: cursor ? undefined : Math.ceil(total / limit),
          nextCursor,
          skipCapped: skipCapped || undefined,
        },
      };

      return result;
    }

    // Cursor pagination path — when caller passes ?cursor=<id>, use
    // keyset pagination instead of offset. O(1) at the DB level regardless
    // of how deep into the catalog. The cursor is an opaque product id;
    // the frontend never constructs one, only forwards what we returned in
    // the previous response's `meta.nextCursor`.
    //
    // Trade-off: cursor pagination supports "Next page" navigation but NOT
    // arbitrary jumps. The storefront's page-number UI keeps using `page`
    // for the first ~10000 rows (capped above); the cursor path is for
    // "Load more" + crawler-safe deep scans.
    // Append `id` as the final tiebreaker. The query below is served with
    // `cursor: { id }`, and keyset pagination is only stable when the ORDER BY
    // uniquely identifies the cursor row. (The merchant-ordered category path
    // above returns early and pages in memory instead — see #1371.)
    // None of the sorts resolved above are
    // unique on their own — price, bestSellerPosition and newArrivalPosition
    // all repeat freely, and createdAt ties across products imported in the
    // same batch, which is how most catalogues are seeded. A page boundary
    // landing inside a tied group silently drops products from the storefront
    // listing or serves the same one twice.
    orderBy = [...(Array.isArray(orderBy) ? orderBy : [orderBy]), { id: 'desc' }];

    const baseFindManyArgs = {
      where,
      take: limit + 1, // fetch one extra to know if there's a next page
      // Explicit select (not include) — storefront-safe scalars only, plus
      // lowStockThreshold which enrichStockFlags needs for its lowStock
      // computation but strips before the row is returned. See T-H1.
      select: {
        ...STOREFRONT_PRODUCT_SELECT,
        lowStockThreshold: true,
        images: { orderBy: { position: 'asc' } as const, take: 2 }, // 2 images: primary + hover-reveal second on cards
        categories: { include: { category: true } },
        options: LISTING_SWATCH_OPTIONS_SELECT,
        store: { select: { id: true, name: true, slug: true } },
        // Variants are needed by the storefront card components to (a)
        // pick between the inline "Add to cart" and "View" CTAs, and
        // (b) compute the "From <min>" pricing for multi-variant
        // products. Without this include, every product looks variant-
        // less to the storefront and the View CTA never appears
        // regardless of how many variants the merchant created.
        // Light select (price + compareAtPrice + stock fields) so the join
        // stays cheap while supplying what enrichStockFlags needs.
        variants: {
          select: {
            id: true,
            price: true,
            compareAtPrice: true,
            inventory: true,
            allowBackorder: true,
            // Stock only — enrichStockFlags reads and strips it (#1103).
            isActive: true,
          },
        },
      },
      orderBy,
    };

    const findManyArgs = cursor
      ? { ...baseFindManyArgs, cursor: { id: cursor }, skip: 1 }
      : { ...baseFindManyArgs, skip, take: limit };

    const [productsRaw, total, facets] = await Promise.all([
      prisma.product.findMany(findManyArgs),
      prisma.product.count({ where }),
      computeFacets(storeId, whereForFacets),
    ]);

    // When using cursor we fetched limit+1; slice to limit + extract next cursor.
    // The next cursor is the LAST row returned, because the next request skips
    // the cursor row itself (`skip: 1`). It used to be the extra (limit+1)th
    // row, which the next request then skipped — one product lost per page.
    const products =
      cursor && productsRaw.length > limit ? productsRaw.slice(0, limit) : productsRaw;
    const nextCursor =
      cursor && productsRaw.length > limit
        ? (productsRaw[limit - 1] as { id: string }).id
        : undefined;

    const result = {
      // No type-erasing cast (see the position-ordered path above).
      products: products.map(p => enrichStockFlags(p)),
      facets,
      meta: {
        page: cursor ? undefined : page,
        limit,
        total,
        totalPages: cursor ? undefined : Math.ceil(total / limit),
        nextCursor,
        skipCapped: skipCapped || undefined,
      },
    };

    return result;
  }

  /**
   * Shared select shape for the public product detail endpoints. Pulls the
   * options + variants graph alongside the base product so the storefront's
   * VariantSelector + per-variant image swap have everything they need in
   * one round trip. Variants/options are ordered by their stored `position`
   * so admin reordering is preserved on the storefront.
   *
   * Explicit `select` (not `include`) at both the product AND variant level —
   * ProductVariant carries the same wholesale-cost/margin fields as Product
   * (`costPrice`, `barcode`); an `include` there would leak them exactly like
   * the top-level Product row (see STOREFRONT_PRODUCT_SELECT above).
   */
  private static readonly PUBLIC_PRODUCT_DETAIL_SELECT = {
    ...STOREFRONT_PRODUCT_SELECT,
    lowStockThreshold: true,
    images: { orderBy: { position: 'asc' } },
    categories: { include: { category: true } },
    store: { select: { id: true, name: true, slug: true } },
    faqs: {
      select: {
        id: true,
        question: true,
        questionAr: true,
        answer: true,
        answerAr: true,
      },
    },
    options: {
      orderBy: { position: 'asc' },
      include: {
        values: { orderBy: { position: 'asc' } },
      },
    },
    // ALL variants, with `isActive` — NOT pre-filtered (issue 2147). A
    // `where: { isActive: true }` here made a product whose variants are all
    // disabled read as variant-less, so `enrichStockFlags` fell back to the
    // parent `inventory` column and the PDP advertised stock checkout refuses.
    // The helper computes stock from active variants; `publicDetailWithStock`
    // then drops the disabled ones from the display list.
    variants: {
      orderBy: { position: 'asc' },
      select: {
        id: true,
        title: true,
        titleAr: true,
        sku: true,
        price: true,
        compareAtPrice: true,
        inventory: true,
        allowBackorder: true,
        isActive: true,
        imageUrl: true,
        options: {
          include: {
            value: {
              include: { option: true },
            },
          },
        },
      },
    },
    // JSON-LD reviews: only published + verified-purchase, capped at 20.
    // Defense-in-depth — AI-generated or unverified reviews cannot appear
    // in structured data even if inserted through another code path.
    reviews: {
      where: { status: 'published', verifiedPurchase: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        rating: true,
        title: true,
        body: true,
        bodyTranslated: true,
        language: true,
        createdAt: true,
        ownerResponse: true,
        ownerResponseAr: true,
        ownerResponseAt: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    },
    // Product 3D model (docs/plans/2026-10-07-product-3d-viewer.md). Reshaped
    // into `PublicModel3d` by `toPublicModel3d`; the public route strips it
    // when `product_3d` is off for the store.
    model3d: { select: PUBLIC_MODEL3D_SELECT },
  } as const satisfies Prisma.ProductSelect;

  /**
   * Reshape a Prisma product (with the include above) into the storefront
   * payload shape: variants get a flat `options: { [optionName]: value }`
   * map (what `VariantSelector` matches against) and options get a flat
   * `values: string[]` array. Image URL is surfaced as-is so the gallery
   * can swap when a variant with `imageUrl` is selected.
   */
  private static reshapePublicProductDetail<
    T extends {
      options?: Array<{
        id: string;
        name: string;
        nameAr: string | null;
        values: Array<{
          id: string;
          value: string;
          valueAr: string | null;
          swatchHex: string | null;
          swatchImageUrl: string | null;
        }>;
      }>;
      variants?: Array<{
        id: string;
        title: string;
        sku: string | null;
        price: number | null;
        compareAtPrice: number | null;
        inventory: number;
        imageUrl: string | null;
        options: Array<{
          value: { value: string; option: { name: string } };
        }>;
      }>;
      price: number;
    },
  >(product: T) {
    // Each option value now ships both its English `value` and the
    // Arabic `valueAr` (when set) so the storefront can render the
    // size/color/etc picker in the merchant's chosen language. Without
    // valueAr the picker always shows the English label even on the
    // Arabic storefront — the issue Demo Shop hit on its olive-oil
    // page where size pills read "2-liter / 4-liter / 16-liter" in
    // Arabic mode.
    const reshapedOptions = (product.options ?? []).map(o => ({
      id: o.id,
      name: o.name,
      nameAr: o.nameAr,
      values: o.values.map(v => ({
        id: v.id,
        value: v.value,
        valueAr: v.valueAr ?? undefined,
        swatchHex: v.swatchHex,
        swatchImageUrl: v.swatchImageUrl,
      })),
    }));

    const reshapedVariants = (
      product.variants as Array<{
        id: string;
        title: string;
        titleAr: string | null;
        sku: string | null;
        price: number | null;
        compareAtPrice: number | null;
        inventory: number;
        allowBackorder: boolean;
        isActive: boolean;
        imageUrl: string | null;
        options: Array<{
          value: {
            value: string;
            valueAr: string | null;
            option: { name: string; nameAr: string | null };
          };
        }>;
      }>
    ).map(v => {
      // Two parallel maps — `options` keys variants by the English
      // axis name (so the existing matching logic keeps working), and
      // `optionsAr` keys by the Arabic axis name with Arabic values
      // for the customer-visible label resolution in VariantSelector.
      const options: Record<string, string> = {};
      const optionsAr: Record<string, string | undefined> = {};
      for (const vo of v.options) {
        options[vo.value.option.name] = vo.value.value;
        optionsAr[vo.value.option.name] = vo.value.valueAr ?? undefined;
      }
      return {
        id: v.id,
        name: v.title,
        nameAr: v.titleAr ?? undefined,
        sku: v.sku ?? undefined,
        // Variants without their own price fall back to the parent product
        // price so the storefront never displays "0" for a variant that
        // shares the base price.
        price: v.price ?? product.price,
        compareAtPrice: v.compareAtPrice ?? undefined,
        inventory: v.inventory,
        allowBackorder: v.allowBackorder,
        isActive: v.isActive,
        imageUrl: v.imageUrl ?? undefined,
        options,
        optionsAr,
      };
    });

    return {
      ...product,
      options: reshapedOptions,
      variants: reshapedVariants,
    };
  }

  /**
   * Reshape a PDP row and compute its stock flags from ALL its variants (a
   * disabled one counts for nothing — `enrichStockFlags`), THEN drop the
   * disabled variants from what the shopper is shown. Filtering before the
   * computation is exactly what issue 2147 was: an all-disabled product
   * looked variant-less and inherited the parent column's stock.
   */
  private static publicDetailWithStock<
    T extends Parameters<typeof ProductService.reshapePublicProductDetail>[0],
  >(product: T) {
    const disabled = new Set(
      ((product.variants ?? []) as Array<{ id: string; isActive?: boolean }>)
        .filter(v => v.isActive === false)
        .map(v => v.id)
    );
    const enriched = enrichStockFlags(
      this.reshapePublicProductDetail(product) as unknown as Parameters<typeof enrichStockFlags>[0]
    );
    return {
      ...enriched,
      variants: (enriched.variants as Array<{ id: string }> | undefined)?.filter(
        v => !disabled.has(v.id)
      ),
    };
  }

  static async getPublicBySlug(storeId: string, slug: string) {
    const product = await prisma.product.findFirst({
      where: { storeId, slug, status: 'active', deletedAt: null },
      select: this.PUBLIC_PRODUCT_DETAIL_SELECT,
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const ratingAggregate = await prisma.review.aggregate({
      where: { productId: product.id, storeId, status: 'published', verifiedPurchase: true },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const ratingStats = {
      ratingAverage: ratingAggregate._avg.rating
        ? Math.round(ratingAggregate._avg.rating * 10) / 10
        : null,
      ratingCount: ratingAggregate._count.rating,
    };

    return {
      ...this.publicDetailWithStock(product),
      model3d: toPublicModel3d(product.model3d),
      ratingStats,
    };
  }

  static async getPublicById(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { storeId, id: productId, status: 'active', deletedAt: null },
      select: this.PUBLIC_PRODUCT_DETAIL_SELECT,
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const ratingAggregate = await prisma.review.aggregate({
      where: { productId: product.id, storeId, status: 'published', verifiedPurchase: true },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const ratingStats = {
      ratingAverage: ratingAggregate._avg.rating
        ? Math.round(ratingAggregate._avg.rating * 10) / 10
        : null,
      ratingCount: ratingAggregate._count.rating,
    };

    return {
      ...this.publicDetailWithStock(product),
      model3d: toPublicModel3d(product.model3d),
      ratingStats,
    };
  }

  static async getCategories(storeId: string) {
    // Try Redis cache first (best-effort)
    const cacheKey = `categories:store:${storeId}`;
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        return typeof cached === 'string' ? JSON.parse(cached) : cached;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PRODUCT] Redis cache read failed for getCategories'
      );
    }

    // Three queries in parallel: real categories + the count of products
    // flagged as best-sellers + the store's bestSellersImage cover.
    // We expose Best Sellers as a VIRTUAL category alongside the real
    // ones so the storefront's nav, grid, and listing pages all treat
    // it identically to a real category — but the underlying product
    // membership is the per-product `isBestSeller` flag, NOT a
    // ProductCategory link. This lets a product live in its real
    // bucket (Palestinian / Spices / etc.) AND simultaneously appear
    // in Best Sellers without the merchant having to double-tag.
    //
    // The virtual entry uses `slug: 'best-sellers'`; the storefront
    // ProductsClient special-cases that slug into `sort=best_seller`
    // when fetching products.
    const [categories, bestSellerCount, store] = await Promise.all([
      prisma.category.findMany({
        where: {
          storeId,
          deletedAt: null,
          isActive: true,
          // Hide any pre-existing physical "best-sellers" category — the
          // virtual entry below replaces it. Older stores that had a
          // real category by this slug get its products treated as
          // regular tagged products (no fold required); the slug just
          // resolves to the virtual page now.
          slug: { not: 'best-sellers' },
        },
        // Merchant-defined order (Category.position) wins; name is the stable
        // tiebreaker so un-reordered stores keep their A→Z look. The virtual
        // Best Sellers tile is prepended after this with position -1.
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        take: 100, // Guard against stores with unbounded category growth
        include: {
          // Storefront "X items" badge = only products a customer can actually
          // see, so archived / draft / deleted products don't inflate the count.
          _count: {
            select: { products: { where: { product: { status: 'active', deletedAt: null } } } },
          },
        },
      }),
      prisma.product.count({
        where: { storeId, isBestSeller: true, deletedAt: null, status: 'active' },
      }),
      // Defensive: bestSellersImage was added in migration
      // 20260501000000. Until that lands on every environment, treat a
      // P2022 ("column does not exist") as a missing image and keep
      // serving the categories list. Without this guard a fresh deploy
      // ahead of the migration takes the whole endpoint down with a
      // 500.
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: { bestSellersImage: true },
        })
      ).catch(err => {
        logger.warn(
          { err, storeId },
          '[getCategories] bestSellersImage read failed — column missing?'
        );
        return null;
      }),
    ]);

    const realCategories = categories.map(c => ({
      ...c,
      productCount: c._count.products,
      _count: undefined,
    }));

    // Virtual Best Sellers entry. Always first in the list — that's the
    // merchant's flagship surface and where shoppers expect to land
    // first. Hidden when the merchant hasn't flagged any product yet
    // so an empty section doesn't clutter the nav.
    const result =
      bestSellerCount > 0
        ? [
            {
              id: 'virtual:best-sellers',
              storeId,
              slug: 'best-sellers',
              name: 'Best Sellers',
              nameAr: 'الأكثر مبيعاً',
              description: null,
              descriptionAr: null,
              // Store-level cover for the Best Sellers tile. Falls
              // back to null (text-only treatment) when the merchant
              // hasn't uploaded one.
              image: store?.bestSellersImage ?? null,
              isActive: true,
              position: -1,
              isVirtual: true as const,
              productCount: bestSellerCount,
            },
            ...realCategories,
          ]
        : realCategories;

    // Write to cache (best-effort, 120s TTL — invalidated when
    // categories or product status changes).
    try {
      await redis.set(cacheKey, JSON.stringify(result), 120);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PRODUCT] Redis cache write failed for getCategories'
      );
    }

    return result;
  }

  /**
   * Advanced product search with filters
   */
  static async advancedSearch(storeId: string, options: AdvancedSearchOptions = {}) {
    const {
      query,
      categories,
      tags,
      minPrice,
      maxPrice,
      inStock,
      onSale,
      isNew,
      featured,
      sortBy = 'newest',
    } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.ProductWhereInput = {
      storeId,
      status: 'active',
      deletedAt: null,
    };

    // Text search — word-AND so any subset / reordering of words still matches.
    if (query && query.trim()) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...buildProductSearchAnd(query, true),
      ];
    }

    // Category filter
    if (categories && categories.length > 0) {
      where.categories = {
        some: {
          OR: [{ categoryId: { in: categories } }, { category: { slug: { in: categories } } }],
        },
      };
    }

    // Tag filter
    if (tags && tags.length > 0) {
      where.tags = {
        some: {
          OR: [{ tagId: { in: tags } }, { tag: { name: { in: tags, mode: 'insensitive' } } }],
        },
      };
    }

    // Price range filter
    if (minPrice !== undefined) {
      where.price = { ...((where.price as object) || {}), gte: minPrice };
    }
    if (maxPrice !== undefined) {
      where.price = { ...((where.price as object) || {}), lte: maxPrice };
    }

    // In stock filter — variant-aware. A variant product's stock lives on its
    // variants and its own `inventory` column is unused (and had drifted
    // negative), so filtering on that column alone excluded EVERY variant
    // product from in-stock results, permanently. Expressed as relation
    // filters so this stays one query. See lib/effective-inventory.ts.
    //
    // Tri-state (issues 2318 / 2325): the route forwards `undefined | true |
    // false` and documents `false` as a filter, so every flag below honours
    // `false` as the exact complement of its `true` branch — never as "no
    // filter", which answered `?featured=false` with every product.
    const inStockBranches: Prisma.ProductWhereInput[] = [
      // No variants: the product column is the stock.
      { variants: { none: {} }, inventory: { gt: 0 } },
      // Has variants: at least one ACTIVE one carries stock (#1103).
      { variants: { some: { isActive: true, inventory: { gt: 0 } } } },
    ];
    const and = (extra: Prisma.ProductWhereInput) => {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), extra];
    };
    if (inStock === true) {
      where.OR = [...(where.OR || []), { trackInventory: false }, ...inStockBranches];
    } else if (inStock === false) {
      // Complement of the OR above: tracked, and neither stock branch holds.
      and({ trackInventory: true, NOT: inStockBranches });
    }

    // On sale filter (has a compare-at price)
    if (onSale === true) {
      where.compareAtPrice = { not: null };
      and({ compareAtPrice: { gt: 0 } });
    } else if (onSale === false) {
      and({ OR: [{ compareAtPrice: null }, { compareAtPrice: { lte: 0 } }] });
    }

    // New arrivals filter
    if (isNew !== undefined) {
      where.isNew = isNew;
    }

    // Featured filter
    if (featured !== undefined) {
      where.featured = featured;
    }

    // Build order by clause
    const orderBy: Prisma.ProductOrderByWithRelationInput = (() => {
      switch (sortBy) {
        case 'newest':
          return { createdAt: 'desc' };
        case 'oldest':
          return { createdAt: 'asc' };
        case 'price_asc':
          return { price: 'asc' };
        case 'price_desc':
          return { price: 'desc' };
        case 'name_asc':
          return { name: 'asc' };
        case 'name_desc':
          return { name: 'desc' };
        case 'popular':
          return { viewCount: 'desc' };
        default:
          return { createdAt: 'desc' };
      }
    })();

    // Execute query
    const [products, total, priceRange] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: {
          images: { orderBy: { position: 'asc' }, take: 2 },
          categories: { include: { category: { select: { id: true, name: true, slug: true } } } },
          options: LISTING_SWATCH_OPTIONS_SELECT,
          reviews: {
            where: { status: 'published' },
            select: { rating: true },
          },
          // See listPublic note above — variants are needed for the
          // dual-CTA (View vs Add to Cart) + "From <min>" pricing on
          // the storefront card components.
          variants: {
            select: { id: true, price: true, compareAtPrice: true },
          },
        },
        orderBy,
      }),
      prisma.product.count({ where }),
      // Get price range for filters
      prisma.product.aggregate({
        where: { storeId, status: 'active' },
        _min: { price: true },
        _max: { price: true },
      }),
    ]);

    // Calculate average ratings
    const productsWithRatings = products.map(product => {
      const ratings = product.reviews.map(r => r.rating);
      const avgRating =
        ratings.length > 0
          ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
          : null;
      return {
        ...product,
        reviews: undefined,
        avgRating,
        reviewCount: ratings.length,
      };
    });

    return {
      products: productsWithRatings,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        priceRange: {
          min: priceRange._min.price || 0,
          max: priceRange._max.price || 0,
        },
      },
    };
  }

  /**
   * Lightweight typeahead suggestions for the storefront header search.
   * Returns at most `limit` (≤8) products as a flat array, sorted by
   * `featured` desc + `name` asc so curated picks bubble up first.
   * Matches both English and Arabic names so RTL shoppers see results
   * for their query immediately.
   */
  static async getSuggestSuggestions(storeId: string, query: string, limit = 25) {
    const trimmed = (query ?? '').trim();
    if (trimmed.length < 2) return { suggestions: [] as Array<unknown> };

    // 25 is enough to actually scroll inside the typeahead's
    // max-h-[70vh] container — the previous cap of 8 made the
    // dropdown so short the scroll never engaged. 25 also stays
    // well under what's painful to render and is gated by the
    // service limit param so an attacker can't request more.
    const take = Math.min(25, Math.max(1, limit));

    // Word-AND across name + nameAr only (typeahead shows product names, so
    // matching on description would surface confusing results). Each query word
    // must appear in name or nameAr, so a multi-word / reordered query still
    // matches (e.g. "بريتزوس مشكلة" → "مخبوزات بريتزوس مشكلة").
    const suggestTokens = trimmed.split(/\s+/).filter(Boolean);
    const products = await prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        AND: suggestTokens.map(token => ({
          OR: [
            { name: { contains: token, mode: 'insensitive' as const } },
            { nameAr: { contains: token, mode: 'insensitive' as const } },
          ],
        })),
      },
      select: {
        id: true,
        slug: true,
        name: true,
        nameAr: true,
        price: true,
        images: {
          select: { url: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
      },
      orderBy: [{ featured: 'desc' }, { name: 'asc' }],
      take,
    });

    return {
      suggestions: products.map(p => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        nameAr: p.nameAr,
        price: p.price,
        image: p.images[0]?.url ?? null,
      })),
    };
  }

  /**
   * Get search suggestions based on query
   */
  static async getSearchSuggestions(storeId: string, query: string, limit = 5) {
    if (!query || query.trim().length < 2) {
      return { suggestions: [] };
    }

    const products = await prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { nameAr: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        slug: true,
        price: true,
        images: { take: 1, orderBy: { position: 'asc' } },
      },
      take: limit,
      orderBy: { viewCount: 'desc' },
    });

    const categories = await prisma.category.findMany({
      where: {
        storeId,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { nameAr: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        slug: true,
      },
      take: 3,
    });

    return {
      suggestions: {
        products,
        categories,
      },
    };
  }

  /**
   * Get filter options for a store
   */
  static async getFilterOptions(storeId: string) {
    const [categories, tags, priceRange] = await Promise.all([
      prisma.category.findMany({
        where: { storeId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          slug: true,
          _count: {
            select: {
              products: {
                where: { product: { status: 'active' } },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.tag.findMany({
        where: {
          storeId,
          products: {
            some: {
              product: { storeId, status: 'active' },
            },
          },
        },
        select: {
          id: true,
          name: true,
          _count: {
            select: {
              products: {
                where: { product: { storeId, status: 'active' } },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.product.aggregate({
        where: { storeId, status: 'active' },
        _min: { price: true },
        _max: { price: true },
      }),
    ]);

    return {
      categories: categories.filter(c => c._count.products > 0),
      tags: tags.filter(t => t._count.products > 0),
      priceRange: {
        min: priceRange._min.price || 0,
        max: priceRange._max.price || 0,
      },
    };
  }
}
