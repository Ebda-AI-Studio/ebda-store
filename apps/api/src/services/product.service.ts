import { prisma, Prisma, ProductStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';
import { redis } from './redis.service';
import logger from '../lib/logger';

interface CreateProductData {
  name: string;
  nameAr?: string;
  slug?: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  compareAtPrice?: number;
  /** Cost-of-goods in fils. Used for profit reporting. */
  costPrice?: number | null;
  sku?: string;
  inventory?: number;
  status?: 'draft' | 'active' | 'archived';
  isFeatured?: boolean;
  isNew?: boolean;
  isBestSeller?: boolean;
  categories?: string[];
  images?: { url: string; alt?: string }[];
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
}

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
    const { status, category, search, featured } = options;
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

    return {
      products,
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
   */
  private static async invalidateStoreProductCache(storeId: string): Promise<void> {
    try {
      // Invalidate the categories cache (product counts may have changed)
      await redis.delete(`categories:store:${storeId}`);
      // Product list caches expire after 30s so we don't attempt pattern-based deletion
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown', storeId },
        '[PRODUCT] Redis cache invalidation failed'
      );
    }
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
        compareAtPrice: data.compareAtPrice,
        costPrice: data.costPrice ?? null,
        sku: data.sku,
        inventory: data.inventory ?? 0,
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

    // Wrap image/category replacement and product update in a transaction
    // so that a failure mid-way does not leave orphaned or missing relations.
    const updatedProduct = await prisma.$transaction(async tx => {
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
          compareAtPrice: data.compareAtPrice,
          // Pass through only when present in the patch — undefined leaves
          // the existing value, explicit null clears it. Same convention
          // as the curated flags below.
          ...(data.costPrice !== undefined ? { costPrice: data.costPrice } : {}),
          sku: data.sku,
          inventory: data.inventory,
          status: data.status,
          // Curated flags driven by the admin product edit form. We accept
          // them only when explicitly present in the patch so callers that
          // omit them don't accidentally clear the existing value.
          ...(data.isFeatured !== undefined ? { featured: data.isFeatured } : {}),
          ...(data.isNew !== undefined ? { isNew: data.isNew } : {}),
          ...(data.isBestSeller !== undefined ? { isBestSeller: data.isBestSeller } : {}),
        },
        include: {
          images: { orderBy: { position: 'asc' } },
          categories: { include: { category: true } },
        },
      });
    });

    await this.invalidateStoreProductCache(storeId);
    return updatedProduct;
  }

  static async delete(storeId: string, productId: string) {
    await this.getById(storeId, productId);

    await prisma.product.update({
      where: { id: productId, storeId },
      data: { deletedAt: new Date() },
    });

    await this.invalidateStoreProductCache(storeId);
  }

  static async updateInventory(storeId: string, productId: string, quantity: number) {
    await this.getById(storeId, productId);

    return prisma.product.update({
      where: { id: productId, storeId },
      data: { inventory: quantity },
    });
  }

  // Public methods (no store scope required)
  static async listPublic(
    storeId: string,
    options: ListProductsOptions & {
      sort?: 'newest' | 'price_asc' | 'price_desc' | 'best_seller';
    } = {}
  ) {
    const { status = 'active', category, search, featured, minPrice, maxPrice, sort } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

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

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: {
          images: { orderBy: { position: 'asc' }, take: 1 },
          categories: { include: { category: true } },
          store: { select: { id: true, name: true, slug: true } },
        },
        orderBy,
      }),
      prisma.product.count({ where }),
    ]);

    const result = {
      products,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    // Write to cache (best-effort, 30s TTL)
    try {
      await redis.set(cacheKey, JSON.stringify(result), 30);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[PRODUCT] Redis cache write failed for listPublic'
      );
    }

    return result;
  }

  static async getPublicBySlug(storeId: string, slug: string) {
    const product = await prisma.product.findFirst({
      where: { storeId, slug, status: 'active', deletedAt: null },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        store: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    return product;
  }

  static async getPublicById(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { storeId, id: productId, status: 'active', deletedAt: null },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        store: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    return product;
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

    const categories = await prisma.category.findMany({
      where: { storeId, deletedAt: null, isActive: true },
      orderBy: { name: 'asc' },
      take: 100, // Guard against stores with unbounded category growth
      include: {
        _count: { select: { products: true } },
      },
    });
    const result = categories.map(c => ({
      ...c,
      productCount: c._count.products,
      _count: undefined,
    }));

    // Write to cache (best-effort, 60s TTL)
    try {
      await redis.set(cacheKey, JSON.stringify(result), 60);
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
            where: { isApproved: true },
            select: { rating: true },
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
  static async getSuggestSuggestions(storeId: string, query: string, limit = 8) {
    const trimmed = (query ?? '').trim();
    if (trimmed.length < 2) return { suggestions: [] as Array<unknown> };

    const take = Math.min(8, Math.max(1, limit));

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
