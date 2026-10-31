import {
  prisma,
  Prisma,
  ProductStatus,
  OrderStatus,
  withMoneyTx,
  SlugEntityType,
  withStore,
} from '@ebda/database';
import { assertBarcodeAvailable, ensureBarcode, parseBarcodeOrThrow } from './barcode.service';
import { AppError } from '../middleware/error-handler';
import { effectiveInventory, enrichStockFlags } from '../lib/effective-inventory';
import {
  slugify,
  slugifyWithFallback,
  cleanSearchTerms,
  AI_AUTOFILL_FIELD_NAMES,
  type ProductFact,
  type PersonalisationConfig,
} from '@ebda/shared';
import { redis } from './redis.service';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import { assertWholesaleEntitled } from '../lib/b2b-invalidate';
import { featureService } from './feature.service';
import logger from '../lib/logger';
import { requestStoreReindex } from '../lib/search/reindex';
import { readInStoreContext } from '../lib/store-scoped-read';
import { sendEventAfterCommit } from '../lib/inngest/send-after-commit';
import { cleanupRemovedImages } from './r2-cleanup.service';
import { LISTING_SWATCH_OPTIONS_SELECT } from '../lib/listing-swatch-select';
import { PUBLIC_MODEL3D_SELECT, toPublicModel3d } from './product-model.service';
import { publicGoldFields } from './gold-rate/public';
import {
  assertSizeChartInStore,
  resolvePdpSizeChart,
  SIZE_CHART_PUBLIC_SELECT,
} from './size-chart.service';
import { stampHumanEdits, enqueueRecommendationsSweepForNewProduct } from './ai-autofill.service';
import { recordSlugRedirect } from './slug-redirect.service';
import { assertWithinLimit } from './plan-limit.service';
import {
  buildProductSearchWhere,
  productSearchFilter,
  rankedSearchWithMode,
  searchNameIds,
  searchProductIds,
} from './product-search.service';
import { semanticSearchEnabled } from '../lib/search/embedding-provider';
import { storeDb, storeRepo, storeStock, storeWriter } from '../lib/repo-factory';

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
 * Fields not in `AI_AUTOFILL_FIELDS` are excluded from that engine's daily
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

// `enrichStockFlags` moved to lib/effective-inventory.ts (2026-10-15, C-01) so the
// recommendation and wishlist projections can share it without importing this
// service; re-exported here so existing callers keep their import path.
export { enrichStockFlags };

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
  /** B2B minimum order quantity (null = none) and audience (Task 4). */
  moq?: number | null;
  audience?: 'public' | 'wholesale_only';
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
  /** BARCODE-1: typed/scanned code; `''`/`null` clears (update), omitted = auto-generate on create. */
  barcode?: string | null;
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
  /** Whole-array replace; `undefined` leaves the stored facts alone. */
  facts?: ProductFact[];
  /** Made-to-order business days; `null` clears, `undefined` leaves alone. */
  leadTimeDays?: number | null;
  /**
   * Extra shopper words (dialect / Franco / English), searched never shown.
   * `null` clears, `undefined` leaves alone. Re-cleaned + capped at 500 chars in
   * create/update so every caller (routes, MCP, bulk, AI fill) hits the same cap.
   */
  searchTerms?: string | null;
  /** PDP personalisation field config; `null` clears, `undefined` leaves alone. */
  personalisation?: PersonalisationConfig | null;
  /** Own size chart (same store, checked); `null` = inherit the category's, `undefined` leaves alone. */
  sizeChartId?: string | null;
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

/** Setting a MOQ or a wholesale-only audience needs b2b.wholesale; clearing / resetting to public never does (B2B-1b). */
async function assertB2bProductFields(storeId: string, data: UpdateProductData): Promise<void> {
  if ((data.moq != null && data.moq > 0) || data.audience === 'wholesale_only') {
    await assertWholesaleEntitled(storeId);
  }
}

interface ListProductsOptions {
  /** 'public' (default) or 'wholesale_only' (the approved-buyer catalogue). Never both in one response. */
  audience?: 'public' | 'wholesale_only';
  page?: number;
  limit?: number;
  status?: string;
  category?: string;
  /**
   * Store tag NAME (Phase B3, Ruling B3-5): the skin-type / concern chips link here. Matched
   * exactly against `Tag.name` inside the same store; an unknown tag yields an empty list.
   */
  tag?: string;
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
  const rows = await (
    await storeDb(storeId)
  ).productOption.findMany({
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
  // Spec rows: PDP table + card chips + compare rows. CACHE CLASS: BOUNDED-stale,
  // rides the listing/PDP caches (busted by invalidateStoreProductCache on update;
  // recommendation lists add their own 5-minute TTL).
  facts: true,
  // Made-to-order days for the PDP delivers-by chip. CACHE CLASS: BOUNDED-stale, rides the
  // PDP cache; invalidateStoreProductCache (called on every product update) busts it.
  leadTimeDays: true,
  // 'fixed' | 'gold_rate' (Phase B5). Public and harmless: it tells llms.txt / feeds that the price follows a
  // rate so they take the short edge window (Ruling B5-21). CACHE CLASS: BOUNDED-stale, rides the listing
  // caches; every pricing-mode change purges them (setProductPricing / bulkSwitchMode).
  pricingMode: true,
  // PDP personalisation field config (label, maxLength, required). CACHE CLASS: BOUNDED-stale,
  // rides the PDP cache; invalidateStoreProductCache (every product update) busts it. Display
  // only: CartService.addItem re-reads the column uncached to enforce required/maxLength.
  personalisation: true,
  updatedAt: true,
  createdAt: true,
} as const satisfies Prisma.ProductSelect;

/**
 * The storefront LISTING row (cards): storefront-safe scalars plus what the cards need. One shape
 * for every `listPublic` path (newest/price, merchant category order, hybrid relevance) so they
 * serialize identically. `lowStockThreshold` and the variants' stock fields are read by
 * `enrichStockFlags` and stripped before the row is returned (T-H1, #1103).
 */
const PUBLIC_LISTING_SELECT = {
  ...STOREFRONT_PRODUCT_SELECT,
  lowStockThreshold: true,
  trackInventory: true,
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
} as const satisfies Prisma.ProductSelect;

/**
 * A store on its Durable Object (Ruling CF-R6B-1): prisma-lite joins no D1 / platform model, so a storefront read drops the
 * `store` relation (the D1 Store row) from its select and puts it back from its own source after the DO read. On Postgres the
 * select is untouched.
 */
const { store: _listingStore, ...PUBLIC_LISTING_SELECT_DO } = PUBLIC_LISTING_SELECT;
void _listingStore;

async function storeRefFor(storeId: string) {
  return readInStoreContext(storeId, () =>
    prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, slug: true },
    })
  );
}

/** The listing select for this store's backend, and the Store ref to put back on each row when it is a DO store. */
async function listingFor(storeId: string) {
  const onDo = (await storeRepo(storeId)).backend === 'do';
  return {
    select: (onDo
      ? PUBLIC_LISTING_SELECT_DO
      : PUBLIC_LISTING_SELECT) as typeof PUBLIC_LISTING_SELECT,
    storeRef: onDo ? await storeRefFor(storeId) : null,
  };
}
const withStoreRef = <T extends object>(rows: T[], storeRef: unknown): T[] =>
  storeRef ? rows.map(r => ({ ...r, store: storeRef }) as T) : rows;

/** Json column write: `null` must become SQL NULL (Prisma.DbNull), `undefined` leaves it alone. */
function personalisationWrite(v: PersonalisationConfig | null | undefined) {
  if (v === undefined) return {};
  return { personalisation: v === null ? Prisma.DbNull : v };
}

/** Longest `sort=on_sale` row (a deals strip, not a catalogue page). */
export const ON_SALE_MAX = 12;

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

    // Arabic-normalised word-AND over names, search terms, descriptions and SKU
    // (product-search.service). `searchTruncated`: more than PRODUCT_SEARCH_ID_CAP
    // products matched, so total + paging cover only the best-ranked of them.
    let searchTruncated = false;
    if (search) {
      const filter = await productSearchFilter(storeId, search, 'admin');
      searchTruncated = filter.truncated;
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...filter.and,
      ];
    }

    if (category) {
      where.categories = {
        some: { categoryId: category },
      };
    }

    const [products, total] = await Promise.all([
      (await storeDb(storeId)).product.findMany({
        where,
        skip,
        take: limit,
        include: {
          images: { orderBy: { position: 'asc' } },
          categories: { include: { category: true } },
          // Every variant row, disabled ones included: the same count the order /
          // payment-link VARIANT_REQUIRED gates key on, so the admin size pickers
          // can never disagree with the API (W1a re-review minor 4).
          _count: { select: { variants: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      (await storeDb(storeId)).product.count({ where }),
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
      const variantGrouped = await (
        await storeDb(storeId)
      ).productVariant.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds }, isActive: true },
        _sum: { inventory: true },
      });
      for (const row of variantGrouped) {
        variantSumByProduct.set(row.productId, row._sum.inventory ?? 0);
      }
    }
    const withTotalInventory = products.map(({ _count, ...p }) => ({
      ...p,
      // Keyed on the real variant rows, not the `hasVariants` column, which can drift.
      totalInventory: _count.variants > 0 ? (variantSumByProduct.get(p.id) ?? 0) : p.inventory,
      variantCount: _count.variants,
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
        truncated: searchTruncated,
      },
    };
  }

  static async getById(storeId: string, productId: string) {
    // On a store served by its Durable Object the `store` relation lives in D1/Postgres (another database), so it is
    // fetched separately and attached; on Postgres the original single query is unchanged (CF-WRITES-2).
    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    const product = await repo.writer.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        ...(onDo ? {} : { store: { select: { id: true, name: true, slug: true } } }),
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
    if (onDo) {
      (product as Record<string, unknown>).store = await readInStoreContext(storeId, () =>
        prisma.store.findUnique({
          where: { id: storeId },
          select: { id: true, name: true, slug: true },
        })
      );
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
    const product = await (
      await storeDb(storeId)
    ).product.findFirst({
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
    const found = await (
      await storeDb(storeId)
    ).category.findMany({
      where: { id: { in: ids }, storeId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found in this store');
    }
  }

  static async create(storeId: string, data: CreateProductData) {
    await assertB2bProductFields(storeId, data);
    // Plan ceiling (SP5): one more product must fit the store's maxProducts.
    await assertWithinLimit(storeId, 'maxProducts');
    await this.assertCategoriesInStore(storeId, data.categories);
    await assertSizeChartInStore(storeId, data.sizeChartId);
    // slugifyWithFallback, never bare slugify: a name that slugifies to '' (no
    // letters/digits, or a product created before its name was filled in) gave
    // baseSlug = '', so the de-duplication loop below produced '', '-1', '-2'.
    // Five products on a live store ended up that way; the '' one was
    // unreachable entirely because its URL collapses to the product listing.
    const baseSlug = slugifyWithFallback(data.slug || data.name, 'product');

    // Auto-deduplicate slug: append -1, -2, etc. if exists
    let slug = baseSlug;
    let suffix = 0;
    const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-2)
    while (await w.product.findFirst({ where: { storeId, slug } })) {
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

    // BARCODE-1: a typed barcode must be valid and unused anywhere in the store.
    const typedBarcode = data.barcode?.trim() ? parseBarcodeOrThrow(data.barcode) : undefined;
    if (typedBarcode) await assertBarcodeAvailable(storeId, typedBarcode);

    const product = await w.product.create({
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
        moq: data.moq ?? null,
        audience: data.audience ?? 'public',
        // Discount input columns — stored verbatim; the admin form pre-derives
        // price/compareAtPrice before sending, so the service just persists.
        discountType: data.discountType ?? null,
        discountValue: data.discountValue ?? null,
        sku: data.sku,
        ...(typedBarcode ? { barcode: typedBarcode } : {}),
        // 0 is the column default; a non-zero opening stock is a stock write (refused on a DO store until D2)
        ...(data.inventory ? { inventory: data.inventory } : {}),
        ...(data.lowStockThreshold !== undefined
          ? { lowStockThreshold: data.lowStockThreshold }
          : {}),
        status: data.status ?? 'draft',
        featured: data.isFeatured ?? false,
        isNew: data.isNew ?? false,
        isBestSeller: data.isBestSeller ?? false,
        badgeLabel: data.badgeLabel ?? null,
        badgeLabelAr: data.badgeLabelAr ?? null,
        searchTerms: cleanSearchTerms(data.searchTerms),
        ...(data.facts !== undefined ? { facts: data.facts } : {}),
        ...(data.leadTimeDays !== undefined ? { leadTimeDays: data.leadTimeDays } : {}),
        ...personalisationWrite(data.personalisation),
        ...(data.sizeChartId !== undefined ? { sizeChartId: data.sizeChartId } : {}),
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

    // BARCODE-1: no barcode typed -> the store's next in-store EAN-13 (when inventory.barcode is on).
    // A product that later gets variants carries its codes on the variants.
    if (!typedBarcode) {
      const auto = await ensureBarcode(storeId, { productId: product.id });
      if (auto) (product as { barcode?: string | null }).barcode = auto;
    }

    await this.invalidateStoreProductCache(storeId);

    // Fire product.upserted for Meta Catalog sync (Phase A — native catalog bot).
    // Fire-and-forget: catalog sync failure must never block the product save.
    // After COMMIT (Ruling SEARCH-T11-20): consumers (Meta sync, autofill, the search indexer)
    // must not read an uncommitted or rolled-back product.
    await sendEventAfterCommit(
      'product.create',
      {
        name: 'product.upserted' as any,
        data: { storeId, productId: product.id, op: 'create', changedFields: [] },
      },
      { ifUnhookable: 'send' }
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
    // BARCODE-1: validate a changed barcode; '' / null clears it.
    let barcodeUpdate: { barcode?: string | null } = {};
    if (data.barcode !== undefined) {
      const raw = data.barcode?.trim();
      if (!raw) barcodeUpdate = { barcode: null };
      else {
        const value = parseBarcodeOrThrow(raw);
        await assertBarcodeAvailable(storeId, value, { productId });
        barcodeUpdate = { barcode: value };
      }
    }
    await assertB2bProductFields(storeId, data);
    await this.assertCategoriesInStore(storeId, data.categories);
    await assertSizeChartInStore(storeId, data.sizeChartId);
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
      const wSlug = await storeWriter(storeId);
      while (
        await wSlug.product.findFirst({
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
    // Write only what THIS save changed in the provenance map (review N1): the map read above
    // can be stale — an AI guarded write may have committed since — and writing it back whole
    // would drop that fresh 'ai' stamp. The delta is merged in SQL below, in the same
    // transaction as the field write.
    const prevSources = (product.aiFieldSources as Record<string, string>) ?? {};
    const setSources = Object.fromEntries(
      Object.entries(nextSources).filter(([k, v]) => prevSources[k] !== v)
    );
    const removedSources = Object.keys(prevSources).filter(k => !(k in nextSources));

    // The product write itself, shared by the Postgres transaction and the Durable Object batch below.
    const updateArgs = {
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
        ...(data.moq !== undefined ? { moq: data.moq } : {}),
        ...(data.audience !== undefined ? { audience: data.audience } : {}),
        // Discount input columns — same undefined/null convention.
        ...(data.discountType !== undefined ? { discountType: data.discountType } : {}),
        ...(data.discountValue !== undefined ? { discountValue: data.discountValue } : {}),
        ...(data.sku !== undefined ? { sku: data.sku } : {}),
        ...barcodeUpdate,
        // Card badge — null clears, an omitted key leaves it alone. Same
        // convention as nameAr / description / excerpt above.
        ...(data.badgeLabel !== undefined ? { badgeLabel: data.badgeLabel } : {}),
        ...(data.badgeLabelAr !== undefined ? { badgeLabelAr: data.badgeLabelAr } : {}),
        ...(data.searchTerms !== undefined
          ? { searchTerms: cleanSearchTerms(data.searchTerms) }
          : {}),
        ...(data.facts !== undefined ? { facts: data.facts } : {}),
        ...(data.leadTimeDays !== undefined ? { leadTimeDays: data.leadTimeDays } : {}),
        ...personalisationWrite(data.personalisation),
        ...(data.sizeChartId !== undefined ? { sizeChartId: data.sizeChartId } : {}),
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
      },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
      },
    } satisfies Prisma.ProductUpdateArgs;

    // Wrap image/category replacement and product update in a transaction
    // so that a failure mid-way does not leave orphaned or missing relations.
    const repoForWrite = await storeRepo(storeId);
    const updatedProduct =
      repoForWrite.backend === 'do'
        ? await this.updateOnDo(repoForWrite.writer, {
            storeId,
            productId,
            data,
            productName: product.name,
            updateArgs,
            setSources,
            removedSources,
            slugChanged: Boolean(data.slug && finalSlug !== product.slug),
            oldSlug: product.slug,
            finalSlug: finalSlug!,
          })
        : await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
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
              const positionByCategory = new Map(
                existingLinks.map(l => [l.categoryId, l.position])
              );
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

            const updated = await tx.product.update(updateArgs);
            if (Object.keys(setSources).length > 0 || removedSources.length > 0) {
              // wa-catalog: not-catalog-data (ai_field_sources is internal; the product update above is observed)
              // Per-key merge on the row as it is NOW (this UPDATE holds its lock): concurrent
              // stamps on other keys survive. store_id keeps the raw statement tenant-keyed.
              const merged = await tx.$queryRaw<Array<{ ai_field_sources: unknown }>>`
          UPDATE products
             SET ai_field_sources =
                 (COALESCE(ai_field_sources, '{}'::jsonb) || ${JSON.stringify(setSources)}::jsonb)
                 - ${removedSources}::text[]
           WHERE id = ${productId} AND store_id = ${storeId}
       RETURNING ai_field_sources`;
              (updated as { aiFieldSources: unknown }).aiFieldSources =
                merged[0]?.ai_field_sources ?? updated.aiFieldSources;
            }

            if (data.slug && finalSlug !== product.slug) {
              await recordSlugRedirect(
                tx,
                storeId,
                SlugEntityType.PRODUCT,
                product.slug,
                finalSlug!
              );
            }

            return updated;
          });

    await this.invalidateStoreProductCache(storeId);

    // Fire product.upserted for Meta Catalog sync. Fire-and-forget.
    await sendEventAfterCommit(
      'product.update',
      {
        name: 'product.upserted' as any,
        data: { storeId, productId, op: 'update', changedFields },
      },
      { ifUnhookable: 'send' }
    );

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

  /**
   * `update`'s write step on a store served by its Durable Object (CF-WRITES-2). The Postgres path is one interactive
   * transaction; a DO section cannot be interactive, so the same steps ship as ONE atomic batch: images replaced,
   * category links replaced (the saved drag-sort positions are read first and carried over), the product row, and the
   * `ai_field_sources` delta merged in-DO (`mergeAiFieldSources`, the twin of the raw jsonb statement). A stock value in
   * the patch is refused by the DO (stock moves only in the locked sections, D2).
   */
  private static async updateOnDo(
    w: Awaited<ReturnType<typeof storeWriter>>,
    a: {
      storeId: string;
      productId: string;
      data: UpdateProductData;
      productName: string;
      updateArgs: any;
      setSources: Record<string, string>;
      removedSources: string[];
      slugChanged: boolean;
      oldSlug: string;
      finalSlug: string;
    }
  ) {
    const { productId, data } = a;
    const ops: PromiseLike<any>[] = [];
    if (data.images !== undefined) {
      ops.push(w.productImage.deleteMany({ where: { productId } }));
      if (data.images.length > 0)
        ops.push(
          w.productImage.createMany({
            data: data.images.map((img, index) => ({
              productId,
              url: img.url,
              alt: img.alt || data.name || a.productName,
              position: index,
            })),
          })
        );
    }
    if (data.categories !== undefined) {
      const existingLinks = await w.productCategory.findMany({
        where: { productId },
        select: { categoryId: true, position: true },
      });
      const positionByCategory = new Map(existingLinks.map(l => [l.categoryId, l.position]));
      ops.push(w.productCategory.deleteMany({ where: { productId } }));
      if (data.categories.length > 0)
        ops.push(
          w.productCategory.createMany({
            data: data.categories.map(categoryId => ({
              productId,
              categoryId,
              position: positionByCategory.get(categoryId) ?? 0,
            })),
          })
        );
    }
    const productAt = ops.length;
    ops.push(w.product.update(a.updateArgs));
    const mergeAt =
      Object.keys(a.setSources).length > 0 || a.removedSources.length > 0 ? ops.length : -1;
    if (mergeAt >= 0)
      ops.push(
        w.$proc('mergeAiFieldSources', {
          productId,
          set: a.setSources,
          remove: a.removedSources,
        })
      );
    const res = await w.$transaction(ops as never);
    const updated = res[productAt] as { aiFieldSources: unknown };
    if (mergeAt >= 0) updated.aiFieldSources = (res[mergeAt] as unknown) ?? updated.aiFieldSources;
    // SlugRedirect is a D1 platform model: it stays on the platform path until the platform client lands (PR A).
    if (a.slugChanged)
      await recordSlugRedirect(prisma, a.storeId, SlugEntityType.PRODUCT, a.oldSlug, a.finalSlug);
    return updated;
  }

  static async delete(storeId: string, productId: string) {
    // Soft-delete keeps the row + child rows around so the deletion
    // is reversible (admin restore flow). DON'T touch R2 here — those
    // images need to survive in case the merchant restores. The
    // hard-delete path (orphan-audit script + future "purge soft-
    // deleted" job) is what cleans up R2 long-term.
    await this.getById(storeId, productId);

    await (
      await storeWriter(storeId)
    ).product.update({
      where: { id: productId, storeId },
      data: { deletedAt: new Date() },
    });

    await this.invalidateStoreProductCache(storeId);
    // A deleted product leaves the search index (its vector is pruned; review M5).
    await requestStoreReindex(storeId, 'product-delete');

    // Fire product.deleted for Meta Catalog sync. Fire-and-forget.
    await sendEventAfterCommit(
      'product.delete',
      { name: 'product.deleted' as any, data: { storeId, productId } },
      { ifUnhookable: 'send' }
    );
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

    const result = await (
      await storeWriter(storeId)
    ).product.updateMany({
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
    const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-2)
    const safeIds = productIds.filter(id => typeof id === 'string' && id.length > 0);
    if (safeIds.length === 0) return { updated: 0, skippedVariantProducts: 0 };

    // Resolve ids that actually belong to this store and are not deleted.
    const existing = await w.product.findMany({
      where: { storeId, id: { in: safeIds }, deletedAt: null },
      // The real variant ROWS, never the `hasVariants` column (it can drift): a
      // bulk price/stock write on a variant product would break the inventory
      // invariant (the parent column stays 0, variant row XOR product row).
      select: {
        id: true,
        price: true,
        inventory: true,
        pricingMode: true,
        _count: { select: { variants: true } },
      },
    });

    if (existing.length === 0) return { updated: 0, skippedVariantProducts: 0 };

    const allIds = existing.map(p => p.id);
    const isVariantProduct = (p: (typeof existing)[number]) => p._count.variants > 0;
    const simpleProducts = existing.filter(p => !isVariantProduct(p));
    const simpleIds = simpleProducts.map(p => p.id);
    // Only count variant products as "skipped" when a price or inventory
    // mutation was requested — a status/flags-only edit isn't skipping anything.
    const variantCount = existing.filter(isVariantProduct).length;
    // Ruling B5-13: a gold-rate product's price is the repricer's, so a bulk price write skips it
    // exactly like a variant product (counted as skipped; the database trigger would refuse it).
    const goldSimple = simpleProducts.filter(p => p.pricingMode === 'gold_rate');
    const skippedVariantProducts =
      fields.price !== undefined
        ? variantCount + goldSimple.length
        : fields.inventory !== undefined
          ? variantCount
          : 0;

    // --- 1. Scalar flags (all products, updateMany) ---
    const scalarData: Record<string, unknown> = {};
    if (fields.status !== undefined) scalarData.status = fields.status;
    if (fields.isFeatured !== undefined) scalarData.featured = fields.isFeatured;
    if (fields.isNew !== undefined) scalarData.isNew = fields.isNew;
    if (fields.isBestSeller !== undefined) scalarData.isBestSeller = fields.isBestSeller;

    if (Object.keys(scalarData).length > 0) {
      await w.product.updateMany({
        where: { storeId, id: { in: allIds }, deletedAt: null },
        data: scalarData,
      });
      // Only active products are indexed: a status change adds or removes vectors (review M5).
      if (scalarData.status !== undefined) await requestStoreReindex(storeId, 'bulk-status');
    }

    // --- 2. Category link (additive, per-product) ---
    if (fields.addCategoryId) {
      const categoryId = fields.addCategoryId;

      // Guard: verify the category belongs to this store before linking.
      // Without this check a store-A admin could supply a store-B categoryId
      // and link their products to a foreign category.
      const categoryExists = await w.category.findFirst({
        where: { id: categoryId, storeId },
        select: { id: true },
      });
      if (!categoryExists) {
        throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found in this store');
      }

      // Fetch current links so we only insert missing ones.
      const existingLinks = await w.productCategory.findMany({
        where: { productId: { in: allIds }, categoryId },
        select: { productId: true },
      });
      const alreadyLinked = new Set(existingLinks.map(l => l.productId));
      const toLink = allIds.filter(id => !alreadyLinked.has(id));

      if (toLink.length > 0) {
        // Max position for this category across all products already in it.
        const top = await w.productCategory.findFirst({
          where: { categoryId },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        const startPos = (top?.position ?? -1) + 1;

        await w.productCategory.createMany({
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
    const priceable = simpleProducts.filter(p => p.pricingMode !== 'gold_rate');
    if (fields.price && priceable.length > 0) {
      const { mode, value } = fields.price;
      if (mode === 'set') {
        const piastres = Math.max(0, Math.round(value));
        await w.product.updateMany({
          where: { storeId, id: { in: priceable.map(p => p.id) }, deletedAt: null },
          data: { price: piastres },
        });
      } else {
        // adjustPct: value is a percentage like -10 (10% off) or +5 (5% up).
        // Clamp the result to [0, MAX_INT4] to prevent Postgres int4 overflow
        // regardless of what percentage or base price is passed.
        const MAX_INT4 = 2_147_483_647;
        const pct = value / 100;
        // Run in chunks of 20 to avoid pool exhaustion (up to 500 items).
        await runChunked(priceable, 20, p => {
          const newPrice = Math.min(MAX_INT4, Math.max(0, Math.round(p.price * (1 + pct))));
          return w.product.update({ where: { id: p.id, storeId }, data: { price: newPrice } });
        });
      }
    }

    // --- 4. Inventory (simple products only) ---
    if (fields.inventory && simpleIds.length > 0) {
      const { mode, value } = fields.inventory;
      const doStock = await storeStock(storeId);
      if (doStock) {
        // Durable Object path (Ruling CF-R7-1): set / adjust, floored at 0, ONE section (no history row, like Postgres).
        await doStock.bulkSetInventory({ productIds: simpleIds, mode, value });
      } else if (mode === 'set') {
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
    const actuallyUpdated = hasScalarOrCategoryField
      ? allIds.length
      : new Set([
          ...(fields.price ? priceable.map(p => p.id) : []),
          ...(fields.inventory ? simpleIds : []),
        ]).size;

    return { updated: actuallyUpdated, skippedVariantProducts };
  }

  // Public methods (no store scope required)
  static async listPublic(
    storeId: string,
    options: ListProductsOptions & {
      /** `relevance` = hybrid ranking for a search (Task 12); without a search it means no sort. */
      sort?: 'newest' | 'price_asc' | 'price_desc' | 'best_seller' | 'relevance' | 'on_sale';
      cursor?: string;
      /**
       * Who is searching (`searcherFromIp`): the identity the query-embed limit charges. Without it
       * a ranked search never embeds (default deny, Ruling SEARCH-T12-6).
       */
      searcher?: string;
    } = {}
  ) {
    const {
      status = 'active',
      category,
      tag,
      search,
      featured,
      minPrice,
      maxPrice,
      ids,
      optionFilters,
    } = options;
    // `relevance` is the default order of a search, so it is the same request as no sort. With
    // SEARCH_SEMANTIC_ENABLED off (or no search) everything below is exactly the pre-Task-12 path.
    const sort = options.sort === 'relevance' ? undefined : options.sort;
    // The deals row is one short first page: a cursor is meaningless there and ignored.
    const cursor = sort === 'on_sale' ? undefined : options.cursor;
    // Hybrid relevance (Task 12): a search with no explicit sort, semantic search on. Ranks
    // keyword + vector hits (RRF) and pages through that order; every other filter still applies.
    const ranked = Boolean(search) && !sort && semanticSearchEnabled();
    const page = Math.max(1, options.page || 1);
    // `on_sale` is a short merchandising row, never a catalogue page (cap 12, first page only).
    const limit = Math.min(
      sort === 'on_sale' ? ON_SALE_MAX : 100,
      Math.max(1, options.limit || 20)
    );

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
    const skip = cursor || sort === 'on_sale' ? 0 : Math.min(requestedSkip, MAX_SKIP);
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
      // B2B-7b: anonymous public listing by default; the approved-buyer catalogue passes 'wholesale_only'.
      audience: options.audience ?? 'public',
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

    let rankedIds: string[] | null = null;
    let rankedDegraded = false;
    if (search && ranked) {
      // The ranked id list replaces the keyword id filter (it already holds every keyword match up
      // to the cap, plus the vector-only hits). ANDed, so an `ids` filter on `where.id` still applies.
      // The search definers take the store ONLY from app.current_store_id: read through
      // readInStoreContext so the storefront path is scoped by construction, not by whichever
      // router happens to mount it (it joins the request's own scope when it is for this store).
      const rankedResult = await readInStoreContext(storeId, () =>
        rankedSearchWithMode(storeId, search, { searcher: options.searcher })
      );
      rankedIds = rankedResult.ids;
      rankedDegraded = rankedResult.degraded;
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { id: { in: rankedIds } },
      ];
    } else if (search) {
      // Arabic-normalised word-AND over names, search terms and descriptions
      // (product-search.service): any subset / reordering of words matches.
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...(await readInStoreContext(storeId, () =>
          buildProductSearchWhere(storeId, search, 'storefront')
        )),
      ];
    }

    // Resolve category slug → ID so we can filter by categoryId and apply the
    // merchant-defined per-category product position. We look up once and reuse
    // the ID in both the where clause and the position-ordered path below.
    let resolvedCategoryId: string | undefined;
    if (category) {
      const cat = await (
        await storeDb(storeId)
      ).category.findFirst({
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

    if (tag) {
      // Tenant-keyed on both sides: the product is already `storeId`-scoped above, and the tag
      // row must belong to the same store, so a foreign store's tag name can never match.
      where.tags = { some: { tag: { storeId, name: tag } } };
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

    if (rankedIds) {
      // Hybrid relevance path: keep the ranked order, drop ids any other filter (category, price,
      // featured, ids, option facets, status) excludes, then page through it in memory like the
      // merchant-ordered category path. The order is deterministic (RRF ties break by id; each leg
      // has an id tie-break), so page N and a cursor walk see the same list. The cursor is the id of
      // the last row the client has; an id no longer in the list yields an empty page.
      const allowed = new Set(
        (await (await storeDb(storeId)).product.findMany({ where, select: { id: true } })).map(
          r => r.id
        )
      );
      const ordered = rankedIds.filter(id => allowed.has(id));
      let pageIdList: string[];
      let nextCursor: string | undefined;
      if (cursor) {
        const at = ordered.indexOf(cursor);
        const after = at === -1 ? [] : ordered.slice(at + 1);
        pageIdList = after.slice(0, limit);
        nextCursor = after.length > limit ? pageIdList[limit - 1] : undefined;
      } else {
        pageIdList = ordered.slice(skip, skip + limit);
      }
      const listing = await listingFor(storeId);
      const [rawRows, facets] = await Promise.all([
        (await storeDb(storeId)).product.findMany({
          where: {
            storeId,
            status: status as ProductStatus,
            deletedAt: null,
            id: { in: pageIdList },
          },
          select: listing.select,
        }),
        computeFacets(storeId, whereForFacets),
      ]);
      const rows = withStoreRef(rawRows, listing.storeRef);
      const byId = new Map(rows.map(r => [r.id, r]));
      const pageRows = pageIdList.flatMap(id => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
      return {
        products: pageRows.map(p => enrichStockFlags(p)),
        facets,
        meta: {
          page: cursor ? undefined : page,
          limit,
          total: ordered.length,
          totalPages: cursor ? undefined : Math.ceil(ordered.length / limit),
          nextCursor,
          skipCapped: skipCapped || undefined,
          /** The order is the hybrid relevance order (the storefront labels it "Most relevant"). */
          ranked: true as const,
          /**
           * The vector leg was wanted but unavailable: keyword order only. The route never caches
           * such a list (Ruling SEARCH-T12-7). Present only when true.
           */
          ...(rankedDegraded ? { degraded: true as const } : {}),
        },
      };
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

    // `sort=on_sale` (Phase B2, the Souq deals row). ON SALE = a product with NO variants whose
    // compare-at price exceeds its price, or a variant product with at least one ACTIVE variant
    // whose own compare-at exceeds its own price (the parent's stale compare-at is ignored, the
    // same rule as getProductPricing). Biggest relative drop first, id as the tiebreaker. The ids
    // come from one store-keyed statement (explicit store_id, active + not deleted) capped at
    // ON_SALE_MAX; the rows are then loaded through the normal storefront select and re-sorted
    // into this order below. CACHE CLASS: BOUNDED-stale. The row reads prices, so it rides the
    // same `public:products:<storeId>:...` Redis key + `products:<storeId>` storefront tag as
    // every listing: a price edit reaches it through invalidateStoreProductCaches (every product
    // write path calls it), residual window <= the 120 s route TTL / 60 s storefront revalidate
    // on a missed purge; checkout reads the authoritative price, never this list.
    // FILTERS ARE APPLIED INSIDE THE STATEMENT, BEFORE THE LIMIT, so `category` / `ids` return the
    // top 12 of the filtered set (not the filtered subset of the store-wide top 12), and `ids`
    // is intersected, never overwritten. The route rejects the params this path cannot honour
    // (search, price range, option filters, featured).
    // B2B visibility (Ruling B2B-7b, B2-28): `p.audience = 'public'` is IN the statement below,
    // before the LIMIT, so a wholesale-only product never consumes one of the 12 slots nor shows in
    // the row (a post-filter would shrink or empty it for retail shoppers).
    let onSaleOrder: string[] | undefined;
    if (sort === 'on_sale') {
      const safeIds = ids?.slice(0, 50).filter(i => typeof i === 'string' && i.length > 0);
      const categorySql = category
        ? resolvedCategoryId
          ? Prisma.sql`EXISTS (SELECT 1 FROM product_categories pc
                                WHERE pc.product_id = p.id AND pc.category_id = ${resolvedCategoryId})`
          : Prisma.sql`FALSE` // an unknown category slug has no products
        : Prisma.sql`TRUE`;
      const idsSql =
        safeIds && safeIds.length > 0
          ? Prisma.sql`p.id = ANY(${safeIds}::text[])`
          : Prisma.sql`TRUE`;
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT p.id
          FROM products p
         WHERE p.store_id = ${storeId}
           AND p.status = 'active'
           AND p.deleted_at IS NULL
           AND p.audience = 'public'
           AND ${categorySql}
           AND ${idsSql}
           AND (
             (NOT EXISTS (SELECT 1 FROM product_variants v0 WHERE v0.product_id = p.id)
               AND p.compare_at_price > p.price)
             OR EXISTS (SELECT 1 FROM product_variants v1
                         WHERE v1.product_id = p.id AND v1.is_active
                           AND v1.compare_at_price > v1.price)
           )
         ORDER BY GREATEST(
                    CASE WHEN NOT EXISTS (SELECT 1 FROM product_variants v2 WHERE v2.product_id = p.id)
                              AND p.compare_at_price > p.price
                         THEN (p.compare_at_price - p.price)::float8 / p.compare_at_price ELSE 0 END,
                    COALESCE((SELECT MAX((v3.compare_at_price - v3.price)::float8 / v3.compare_at_price)
                                FROM product_variants v3
                               WHERE v3.product_id = p.id AND v3.is_active
                                 AND v3.compare_at_price > v3.price), 0)
                  ) DESC, p.id
         LIMIT ${limit}`;
      onSaleOrder = rows.map(r => r.id);
      where.id = { in: onSaleOrder };
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
      const orderedLinks = await (
        await storeDb(storeId)
      ).productCategory.findMany({
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
        select: (await listingFor(storeId)).select,
        orderBy: { createdAt: 'desc' as const },
      };
      const positionStoreRef = (await listingFor(storeId)).storeRef;

      const [allMatchingFetched, total, facets] = await Promise.all([
        (await storeDb(storeId)).product.findMany(positionFindArgs),
        (await storeDb(storeId)).product.count({ where }),
        computeFacets(storeId, whereForFacets),
      ]);

      const allMatchingRaw = withStoreRef(allMatchingFetched, positionStoreRef);
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
      select: (await listingFor(storeId)).select,
      orderBy,
    };
    const listStoreRef = (await listingFor(storeId)).storeRef;

    const findManyArgs = cursor
      ? { ...baseFindManyArgs, cursor: { id: cursor }, skip: 1 }
      : { ...baseFindManyArgs, skip, take: limit };

    // The deals strip has no filter sidebar: skip the facet query on this hot homepage path.
    const [productsFetched, total, facets] = await Promise.all([
      (await storeDb(storeId)).product.findMany(findManyArgs),
      (await storeDb(storeId)).product.count({ where }),
      sort === 'on_sale'
        ? Promise.resolve([] as ProductFacet[])
        : computeFacets(storeId, whereForFacets),
    ]);
    const productsRaw = withStoreRef(productsFetched, listStoreRef);

    // When using cursor we fetched limit+1; slice to limit + extract next cursor.
    // The next cursor is the LAST row returned, because the next request skips
    // the cursor row itself (`skip: 1`). It used to be the extra (limit+1)th
    // row, which the next request then skipped — one product lost per page.
    const saleRank = onSaleOrder ? new Map(onSaleOrder.map((id, i) => [id, i])) : undefined;
    const products = (
      cursor && productsRaw.length > limit ? productsRaw.slice(0, limit) : productsRaw
    ).sort((a, b) => (saleRank ? (saleRank.get(a.id) ?? 0) - (saleRank.get(b.id) ?? 0) : 0));
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
    // B2B: the minimum order quantity is public product data (a restriction, shown even after a plan downgrade).
    moq: true,
    lowStockThreshold: true,
    trackInventory: true,
    images: { orderBy: { position: 'asc' } },
    // Each category carries its size chart so the PDP can inherit it (`resolvePdpSizeChart`);
    // the nested chart is stripped from the payload again in `withSizeChart`.
    categories: {
      include: { category: { include: { sizeChart: { select: SIZE_CHART_PUBLIC_SELECT } } } },
    },
    store: { select: { id: true, name: true, slug: true } },
    // PDP size guide. CACHE CLASS: BOUNDED-stale, rides the PDP cache; every chart write and every
    // product/category write that changes `sizeChartId` calls invalidateStoreProductCaches.
    sizeChart: { select: SIZE_CHART_PUBLIC_SELECT },
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

  /**
   * Flatten the PDP size chart: `sizeChart` = the product's own chart, else its category's, else
   * null. The per-category chart used for the fallback is dropped from `categories` so the
   * payload carries the table once.
   */
  private static withSizeChart<
    T extends {
      sizeChart: unknown;
      categories: Array<{ category: { sizeChart: unknown } & Record<string, unknown> }>;
    },
  >(product: T) {
    const sizeChart = resolvePdpSizeChart(product);
    return {
      ...product,
      sizeChart,
      categories: (product.categories ?? []).map(pc => {
        const { sizeChart: _drop, ...category } = pc.category;
        return { ...pc, category };
      }),
    };
  }

  /**
   * B2B fields of the PUBLIC (anonymous, cacheable) product payload: the MOQ and the PUBLIC quantity tiers only
   * (`group_id IS NULL`). Group tiers and group prices NEVER appear here: a cacheable response must not depend on who asked
   * (Ruling B2B-7b). Tiers are listed only while the store is entitled (benefit), the MOQ always (restriction, B2B-1b), and a
   * stale tier (at or above the current base) is dropped so the page never promises a break the resolver will not give.
   */
  private static async b2bPublicFields(
    storeId: string,
    product: {
      id: string;
      price: number;
      moq?: number | null;
      variants?: ReadonlyArray<{ id: string; price: number | null }>;
    }
  ) {
    const entitled = await featureService.isFeatureEnabled(storeId, 'b2b.wholesale');
    const rows = entitled
      ? await (
          await storeDb(storeId)
        ).productPriceTier.findMany({
          where: { storeId, productId: product.id, groupId: null },
          select: { variantId: true, minQty: true, priceMinor: true },
          orderBy: [{ variantId: 'asc' }, { minQty: 'asc' }],
        })
      : [];
    // A break at or above the price it would apply to is never applied by the resolver (Ruling B2B-3b), so it is not shown:
    // a product-level tier against the product price, a variant-level tier against THAT variant's price (variant.price ??
    // product.price; final review minor 2). A variant tier whose variant is gone is not shown either.
    const variantBase = new Map(
      (product.variants ?? []).map(v => [v.id, v.price ?? product.price] as const)
    );
    return {
      moq: product.moq ?? null,
      priceTiers: rows.filter(t =>
        t.variantId === null
          ? t.priceMinor < product.price
          : variantBase.has(t.variantId) && t.priceMinor < variantBase.get(t.variantId)!
      ),
    };
  }

  /**
   * The storefront detail row. A DO store cannot join the D1 `store` or the Postgres `reviews` (Ruling CF-R6B-1): both are
   * dropped from the DO select and read from their own source, so the row has the same shape on either backend.
   */
  private static async readPublicDetail(storeId: string, where: Prisma.ProductWhereInput) {
    const full = this.PUBLIC_PRODUCT_DETAIL_SELECT;
    if ((await storeRepo(storeId)).backend !== 'do')
      return (await storeDb(storeId)).product.findFirst({ where, select: full });
    // `store` (D1) and the reviewer's `customer` (a User) are the two relations prisma-lite cannot join.
    const { store: _s, reviews, ...rest } = full;
    void _s;
    const { customer: _c, ...reviewSelect } = reviews.select;
    void _c;
    const doSelect = {
      ...rest,
      reviews: { ...reviews, select: { ...reviewSelect, customerId: true } },
    };
    const row = await (
      await storeDb(storeId)
    ).product.findFirst({ where, select: doSelect as unknown as typeof full });
    if (!row) return row;
    const rows = row.reviews as unknown as Array<
      Record<string, unknown> & { customerId?: string | null }
    >;
    const ids = [...new Set(rows.map(r => r.customerId).filter((v): v is string => !!v))];
    const users = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const byId = new Map(users.map(u => [u.id, { firstName: u.firstName, lastName: u.lastName }]));
    const withCustomer = rows.map(({ customerId, ...r }) => ({
      ...r,
      customer: customerId ? (byId.get(customerId) ?? null) : null,
    }));
    return { ...row, store: await storeRefFor(storeId), reviews: withCustomer } as typeof row;
  }

  static async getPublicBySlug(
    storeId: string,
    slug: string,
    opts: { audience?: 'public' | 'wholesale_only' } = {}
  ) {
    // B2B-7b: the public catalogue is anonymous and NEVER returns a wholesale-only product (404, no existence oracle). The
    // approved-buyer route asks for audience 'wholesale_only' explicitly after checking membership.
    const product = await this.readPublicDetail(storeId, {
      storeId,
      slug,
      status: 'active',
      deletedAt: null,
      audience: opts.audience ?? 'public',
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const ratingAggregate = await (
      await storeDb(storeId)
    ).review.aggregate({
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
      ...this.publicDetailWithStock(this.withSizeChart(product)),
      model3d: toPublicModel3d(product.model3d),
      ratingStats,
      ...(await this.b2bPublicFields(storeId, product)),
      // Gold-rate pricing (Ruling B5-13): the storefront-safe view (no margin, no rate id, no source).
      ...(await publicGoldFields(prisma as unknown as Prisma.TransactionClient, storeId, product)),
    };
  }

  static async getPublicById(storeId: string, productId: string) {
    const product = await this.readPublicDetail(storeId, {
      storeId,
      id: productId,
      status: 'active',
      deletedAt: null,
      audience: 'public',
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const ratingAggregate = await (
      await storeDb(storeId)
    ).review.aggregate({
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
      ...this.publicDetailWithStock(this.withSizeChart(product)),
      model3d: toPublicModel3d(product.model3d),
      ratingStats,
      ...(await this.b2bPublicFields(storeId, product)),
      // Gold-rate pricing (Ruling B5-13): the storefront-safe view (no margin, no rate id, no source).
      ...(await publicGoldFields(prisma as unknown as Prisma.TransactionClient, storeId, product)),
    };
  }

  /**
   * The store's skin-type / concern chips (Phase B3, Ruling B3-5): tags with at least one ACTIVE,
   * PUBLIC product, most-used first, at most 12. Every query carries `storeId` (the tag row and
   * the product both), the select is explicit, and a tag with no published product is never
   * returned, so no chip is a dead end.
   */
  static async getPublicTags(storeId: string) {
    const db = await storeDb(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-REPO-1)
    const rows = await db.tag.findMany({
      where: {
        storeId,
        products: {
          some: { product: { storeId, status: 'active', deletedAt: null, audience: 'public' } },
        },
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        _count: {
          select: {
            products: {
              where: {
                product: { storeId, status: 'active', deletedAt: null, audience: 'public' },
              },
            },
          },
        },
      },
      // Rank by use IN the query (a store with more than 60 tags must not drop a popular tag that
      // sorts late in the alphabet); the published-only count below is the final ranking.
      orderBy: [{ products: { _count: 'desc' } }, { name: 'asc' }],
      take: 60,
    });
    return rows
      .map(r => ({ id: r.id, name: r.name, nameAr: r.nameAr, productCount: r._count.products }))
      .filter(r => r.productCount > 0)
      .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name))
      .slice(0, 12);
  }

  /**
   * One tag by NAME with its labels (the PLP's `?tag=` title in the shopper's language, which
   * may be a tag outside the top-12 chips). Same published-only rule as the list, explicit select,
   * `storeId` on the tag row; not cached (one indexed lookup, the name is caller-controlled).
   */
  static async getPublicTagByName(storeId: string, name: string) {
    const db = await storeDb(storeId);
    const row = await db.tag.findFirst({
      where: {
        storeId,
        name,
        products: {
          some: { product: { storeId, status: 'active', deletedAt: null, audience: 'public' } },
        },
      },
      select: { id: true, name: true, nameAr: true },
    });
    return row ? { id: row.id, name: row.name, nameAr: row.nameAr, productCount: 0 } : null;
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
      (await storeDb(storeId)).category.findMany({
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
            select: {
              products: {
                where: { product: { status: 'active', deletedAt: null, audience: 'public' } },
              },
            },
          },
        },
      }),
      (await storeDb(storeId)).product.count({
        where: {
          storeId,
          isBestSeller: true,
          deletedAt: null,
          status: 'active',
          audience: 'public',
        },
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
      // B2B-7b: advanced search is a public surface: wholesale-only products never appear.
      audience: 'public',
    };

    // Text search — Arabic-normalised word-AND (product-search.service), SKU included.
    // No UI consumes this route, so the 1000-id cap is not surfaced here (Ruling SEARCH-T3-6).
    if (query && query.trim()) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...(await buildProductSearchWhere(storeId, query, 'admin')),
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
    const [fetched, total, priceRange] = await Promise.all([
      (await storeDb(storeId)).product.findMany({
        where,
        skip,
        take: limit,
        include: {
          images: { orderBy: { position: 'asc' }, take: 2 },
          categories: { include: { category: { select: { id: true, name: true, slug: true } } } },
          options: LISTING_SWATCH_OPTIONS_SELECT,
          reviews: { where: { status: 'published' }, select: { rating: true } },
          // See listPublic note above — variants are needed for the
          // dual-CTA (View vs Add to Cart) + "From <min>" pricing on
          // the storefront card components.
          variants: {
            select: { id: true, price: true, compareAtPrice: true },
          },
        },
        orderBy,
      }),
      (await storeDb(storeId)).product.count({ where }),
      // Get price range for filters
      (await storeDb(storeId)).product.aggregate({
        where: { storeId, status: 'active', audience: 'public' },
        _min: { price: true },
        _max: { price: true },
      }),
    ]);

    const products = fetched;

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
    if (trimmed.length < 1) return { suggestions: [] as Array<unknown> };

    // 25 is enough to actually scroll inside the typeahead's
    // max-h-[70vh] container — the previous cap of 8 made the
    // dropdown so short the scroll never engaged. 25 also stays
    // well under what's painful to render and is gated by the
    // service limit param so an attacker can't request more.
    const take = Math.min(25, Math.max(1, limit));

    // Arabic-normalised word-AND over names + search terms only (typeahead shows
    // product names, so matching on description would surface confusing results).
    // A multi-word / reordered query still matches (e.g. "بريتزوس مشكلة" →
    // "مخبوزات بريتزوس مشكلة").
    // order 'featured': featured-first, then name, applied in SQL BEFORE the top
    // `take`, so a featured match can never be cut by the id cap.
    const matchIds = await readInStoreContext(storeId, () =>
      searchProductIds(storeId, trimmed, {
        scope: 'storefront',
        field: 'name',
        order: 'featured',
        limit: take,
      })
    );
    if (matchIds.length === 0) return { suggestions: [] as Array<unknown> };
    const products = await (
      await storeDb(storeId)
    ).product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        audience: 'public',
        id: { in: matchIds },
      },
      select: {
        id: true,
        slug: true,
        name: true,
        nameAr: true,
        price: true,
        images: { select: { url: true }, orderBy: { position: 'asc' }, take: 1 },
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

    const products = await (
      await storeDb(storeId)
    ).product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        audience: 'public',
        id: {
          in: await searchProductIds(storeId, query, {
            scope: 'storefront',
            field: 'name',
            limit: 50,
          }),
        },
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

    // Same Arabic folding as the products above; soft-deleted categories never suggest.
    const categoryIds = await searchNameIds('categories', storeId, query);
    const categories = await (
      await storeDb(storeId)
    ).category.findMany({
      where: { storeId, deletedAt: null, id: { in: categoryIds } },
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
      (await storeDb(storeId)).category.findMany({
        where: { storeId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          slug: true,
          _count: {
            select: {
              products: {
                where: { product: { status: 'active', audience: 'public' } },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      (await storeDb(storeId)).tag.findMany({
        where: {
          storeId,
          products: {
            some: {
              product: { storeId, status: 'active', audience: 'public' },
            },
          },
        },
        select: {
          id: true,
          name: true,
          _count: {
            select: {
              products: {
                where: { product: { storeId, status: 'active', audience: 'public' } },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      (await storeDb(storeId)).product.aggregate({
        where: { storeId, status: 'active', audience: 'public' },
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
