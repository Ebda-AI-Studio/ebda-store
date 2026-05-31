import { prisma, Prisma, ProductStatus, OrderStatus, withMoneyTx } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';
import { redis } from './redis.service';
import { invalidateCached, invalidateCachedPrefix } from '../lib/public-cache';
import logger from '../lib/logger';
import { cleanupRemovedImages } from './r2-cleanup.service';
import { inngest } from '../lib/inngest/client';

/**
 * Compute availability flags for a product (and its variants) based on
 * inventory counts. Called on the public list + detail paths only — admin
 * routes return raw Prisma rows without these computed fields.
 *
 * Rules:
 *   inStock          = inventory > 0
 *   acceptsBackorder = inventory <= 0 && allowBackorder
 *   lowStock         = inStock && inventory <= lowStockThreshold
 *   availableQty     = exact qty when (lowStock || acceptsBackorder); null otherwise
 *                      (avoids leaking exact stock counts for normal in-stock products)
 *
 * Variants inherit the parent's lowStockThreshold (no per-variant threshold).
 * Variants also inherit the parent's allowBackorder flag when their own is false.
 */
function enrichStockFlags<
  P extends {
    inventory: number;
    allowBackorder: boolean;
    lowStockThreshold: number;
    variants?: Array<{
      inventory: number;
      allowBackorder?: boolean;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  },
>(product: P): P {
  const inStock = product.inventory > 0;
  const lowStock = inStock && product.inventory <= product.lowStockThreshold;
  const acceptsBackorder = product.inventory <= 0 && product.allowBackorder;
  const availableQty = lowStock || acceptsBackorder ? product.inventory : null;

  const enrichedVariants = (product.variants ?? []).map(v => {
    const vInStock = v.inventory > 0;
    const vLowStock = vInStock && v.inventory <= product.lowStockThreshold;
    const vAcceptsBackorder =
      v.inventory <= 0 && ((v.allowBackorder ?? false) || product.allowBackorder);
    const vAvailableQty = vLowStock || vAcceptsBackorder ? v.inventory : null;
    return {
      ...v,
      inStock: vInStock,
      lowStock: vLowStock,
      acceptsBackorder: vAcceptsBackorder,
      availableQty: vAvailableQty,
    };
  });

  return {
    ...product,
    inStock,
    lowStock,
    acceptsBackorder,
    availableQty,
    variants: enrichedVariants,
  };
}

interface CreateProductData {
  name: string;
  nameAr?: string;
  slug?: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  /** Original/RRP shown struck-through next to the sale price. `null` clears it. */
  compareAtPrice?: number | null;
  /** Cost-of-goods in fils. Used for profit reporting. */
  costPrice?: number | null;
  sku?: string;
  inventory?: number;
  /** Per-product threshold for the LOW STOCK badge / merchant alerts. */
  lowStockThreshold?: number;
  status?: 'draft' | 'active' | 'archived';
  isFeatured?: boolean;
  isNew?: boolean;
  isBestSeller?: boolean;
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
  /** Inclusive lower bound on `Product.price` (in fils). */
  minPrice?: number;
  /** Inclusive upper bound on `Product.price` (in fils). */
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
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { nameAr: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { descriptionAr: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
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

    // Sales quantity = SUM(order_items.quantity) per product, restricted to the
    // products on THIS page and to realized-sale order statuses. One groupBy for
    // the whole page window — NOT a per-row query (no N+1). Off by default so the
    // catalogue list path stays cheap; only the Inventory page opts in.
    let productsOut:
      | typeof products
      | Array<(typeof products)[number] & { soldQuantity: number }> = products;
    if (withSalesQuantity && products.length > 0) {
      const productIds = products.map(p => p.id);
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
      productsOut = products.map(p => ({ ...p, soldQuantity: soldByProduct.get(p.id) ?? 0 }));
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
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    return product;
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
   * Invalidate Redis caches related to a store's products and categories.
   * Best-effort: failures are logged but do not throw.
   *
   * The Redis side of `public:products:<storeId>:...` keys we let expire
   * naturally on their 30s TTL — pattern delete would require SCAN and
   * the staleness window is small. The in-memory mirror IS swept here
   * via prefix delete because it has no per-key TTL when Redis is
   * unavailable (a sale-price update in admin used to stay invisible
   * until the API process restarted).
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
    // Synchronous in-memory clear so the failover cache doesn't
    // outlive the Redis row.
    invalidateCachedPrefix(`public:products:${storeId}:`);
    invalidateCachedPrefix(`public:suggest:${storeId}:`);
    // Invalidate per-product detail cache entries (keyed by storeId prefix).
    // Redis keys expire naturally on their TTL; in-memory entries are swept here.
    invalidateCachedPrefix(`public:product:${storeId}:`);
    await invalidateCached(`public:categories:${storeId}`);
  }

  static async create(storeId: string, data: CreateProductData) {
    const baseSlug = data.slug || slugify(data.name);

    // Auto-deduplicate slug: append -1, -2, etc. if exists
    let slug = baseSlug;
    let suffix = 0;
    while (await prisma.product.findFirst({ where: { storeId, slug } })) {
      suffix++;
      if (suffix > 100) throw new AppError(409, 'SLUG_COLLISION', 'Too many slug collisions');
      slug = `${baseSlug}-${suffix}`;
    }

    const product = await prisma.product.create({
      data: {
        storeId,
        name: data.name,
        nameAr: data.nameAr,
        slug,
        description: data.description,
        descriptionAr: data.descriptionAr,
        price: data.price,
        compareAtPrice: data.compareAtPrice ?? null,
        costPrice: data.costPrice ?? null,
        sku: data.sku,
        inventory: data.inventory ?? 0,
        ...(data.lowStockThreshold !== undefined
          ? { lowStockThreshold: data.lowStockThreshold }
          : {}),
        status: data.status ?? 'draft',
        featured: data.isFeatured ?? false,
        isNew: data.isNew ?? false,
        isBestSeller: data.isBestSeller ?? false,
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
      .send({ name: 'product.upserted' as any, data: { storeId, productId: product.id } })
      .catch(err =>
        logger.warn({ err, productId: product.id }, '[product.create] inngest send failed')
      );

    return product;
  }

  static async update(storeId: string, productId: string, data: UpdateProductData) {
    const product = await this.getById(storeId, productId);

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

      // If categories are provided, replace all existing categories
      if (data.categories !== undefined) {
        await tx.productCategory.deleteMany({ where: { productId } });
        if (data.categories.length > 0) {
          await tx.productCategory.createMany({
            data: data.categories.map(categoryId => ({
              productId,
              categoryId,
            })),
          });
        }
      }

      return tx.product.update({
        where: { id: productId, storeId },
        data: {
          name: data.name,
          nameAr: data.nameAr,
          slug: finalSlug,
          description: data.description,
          descriptionAr: data.descriptionAr,
          price: data.price,
          // Pass through only when present in the patch — undefined leaves
          // the existing value, explicit null clears it. Same convention
          // as the curated flags below.
          ...(data.compareAtPrice !== undefined ? { compareAtPrice: data.compareAtPrice } : {}),
          ...(data.costPrice !== undefined ? { costPrice: data.costPrice } : {}),
          sku: data.sku,
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
      });
    });

    await this.invalidateStoreProductCache(storeId);

    // Fire product.upserted for Meta Catalog sync. Fire-and-forget.
    void inngest
      .send({ name: 'product.upserted' as any, data: { storeId, productId } })
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

    return prisma.product.update({
      where: { id: productId, storeId },
      data: { inventory: quantity },
    });
  }

  /**
   * Bulk-set the low-stock threshold for a set of products in a store.
   * A single store-scoped updateMany so a tenant can only ever touch its own
   * products. Returns the affected count.
   */
  static async bulkSetLowStockThreshold(
    storeId: string,
    productIds: string[],
    threshold: number
  ) {
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

    // Build a stable cache key from params (best-effort cache, 30s TTL)
    const cacheParams = JSON.stringify({
      status,
      category,
      search,
      featured,
      minPrice,
      maxPrice,
      sort,
      page,
      limit,
      cursor,
    });
    const cacheKey = `products:store:${storeId}:${cacheParams}`;
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        return typeof cached === 'string' ? JSON.parse(cached) : cached;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PRODUCT] Redis cache read failed for listPublic'
      );
    }

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
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { nameAr: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { descriptionAr: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (category) {
      where.categories = {
        some: { category: { slug: category } },
      };
    }

    if (minPrice !== undefined) {
      where.price = { ...((where.price as object) || {}), gte: minPrice };
    }
    if (maxPrice !== undefined) {
      where.price = { ...((where.price as object) || {}), lte: maxPrice };
    }

    // `sort=best_seller` is curator-driven: filter to manually-flagged items
    // so the storefront's Best Sellers carousel reflects the merchant's
    // explicit picks rather than algorithmic guesses.
    if (sort === 'best_seller') {
      where.isBestSeller = true;
    }

    let orderBy: Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[] =
      {
        createdAt: 'desc',
      };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    else if (sort === 'price_desc') orderBy = { price: 'desc' };
    else if (sort === 'best_seller') orderBy = [{ featured: 'desc' }, { updatedAt: 'desc' }];

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
    const baseFindManyArgs = {
      where,
      take: limit + 1, // fetch one extra to know if there's a next page
      include: {
        images: { orderBy: { position: 'asc' } as const, take: 1 },
        categories: { include: { category: true } },
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
          },
        },
      },
      orderBy,
    };

    const findManyArgs = cursor
      ? { ...baseFindManyArgs, cursor: { id: cursor }, skip: 1 }
      : { ...baseFindManyArgs, skip, take: limit };

    const [productsRaw, total] = await Promise.all([
      prisma.product.findMany(findManyArgs),
      prisma.product.count({ where }),
    ]);

    // When using cursor we fetched limit+1; slice to limit + extract next cursor.
    const products =
      cursor && productsRaw.length > limit ? productsRaw.slice(0, limit) : productsRaw;
    const nextCursor =
      cursor && productsRaw.length > limit ? (productsRaw[limit] as { id: string }).id : undefined;

    const result = {
      products: products.map(p => enrichStockFlags(p as Parameters<typeof enrichStockFlags>[0])),
      meta: {
        page: cursor ? undefined : page,
        limit,
        total,
        totalPages: cursor ? undefined : Math.ceil(total / limit),
        nextCursor,
        skipCapped: skipCapped || undefined,
      },
    };

    // Write to cache (best-effort, 120s TTL — invalidated on product
    // mutations via `invalidateCachedPrefix('public:products:<storeId>:')`).
    try {
      await redis.set(cacheKey, JSON.stringify(result), 120);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PRODUCT] Redis cache write failed for listPublic'
      );
    }

    return result;
  }

  /**
   * Shared include shape for the public product detail endpoints. Pulls the
   * options + variants graph alongside the base product so the storefront's
   * VariantSelector + per-variant image swap have everything they need in
   * one round trip. Variants/options are ordered by their stored `position`
   * so admin reordering is preserved on the storefront.
   */
  private static readonly PUBLIC_PRODUCT_DETAIL_INCLUDE = {
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
    variants: {
      orderBy: { position: 'asc' },
      where: { isActive: true },
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
  } as const satisfies Prisma.ProductInclude;

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
        values: Array<{ value: string; valueAr: string | null }>;
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
    // Arabic storefront — the issue Wady Aljuz hit on its olive-oil
    // page where size pills read "2-liter / 4-liter / 16-liter" in
    // Arabic mode.
    const reshapedOptions = (product.options ?? []).map(o => ({
      id: o.id,
      name: o.name,
      nameAr: o.nameAr,
      values: o.values.map(v => ({ value: v.value, valueAr: v.valueAr ?? undefined })),
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

  static async getPublicBySlug(storeId: string, slug: string) {
    const product = await prisma.product.findFirst({
      where: { storeId, slug, status: 'active', deletedAt: null },
      include: this.PUBLIC_PRODUCT_DETAIL_INCLUDE,
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

    const reshaped = this.reshapePublicProductDetail(product);
    return {
      ...enrichStockFlags(reshaped as Parameters<typeof enrichStockFlags>[0]),
      ratingStats,
    };
  }

  static async getPublicById(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { storeId, id: productId, status: 'active', deletedAt: null },
      include: this.PUBLIC_PRODUCT_DETAIL_INCLUDE,
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

    const reshaped = this.reshapePublicProductDetail(product);
    return {
      ...enrichStockFlags(reshaped as Parameters<typeof enrichStockFlags>[0]),
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
        orderBy: { name: 'asc' },
        take: 100, // Guard against stores with unbounded category growth
        include: {
          _count: { select: { products: true } },
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
      prisma.store
        .findUnique({
          where: { id: storeId },
          select: { bestSellersImage: true },
        })
        .catch(err => {
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

    // Text search
    if (query && query.trim()) {
      where.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { nameAr: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { descriptionAr: { contains: query, mode: 'insensitive' } },
        { sku: { contains: query, mode: 'insensitive' } },
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

    // In stock filter
    if (inStock === true) {
      where.OR = [...(where.OR || []), { trackInventory: false }, { inventory: { gt: 0 } }];
    }

    // On sale filter (has compare price higher than regular price)
    if (onSale === true) {
      where.compareAtPrice = { not: null };
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        {
          compareAtPrice: { gt: 0 },
        },
      ];
    }

    // New arrivals filter
    if (isNew === true) {
      where.isNew = true;
    }

    // Featured filter
    if (featured === true) {
      where.featured = true;
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

    const products = await prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        OR: [
          { name: { contains: trimmed, mode: 'insensitive' } },
          { nameAr: { contains: trimmed, mode: 'insensitive' } },
        ],
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
