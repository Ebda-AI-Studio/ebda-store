import { prisma, Prisma, ProductStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';

interface CreateProductData {
  name: string;
  slug?: string;
  description?: string;
  price: number;
  compareAtPrice?: number;
  sku?: string;
  inventory?: number;
  status?: 'draft' | 'active' | 'archived';
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
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = { storeId, deletedAt: null };

    if (status) {
      where.status = status as ProductStatus;
    }

    if (featured !== undefined) {
      where.featured = featured;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
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
      where: { id: productId, storeId },
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

  static async create(storeId: string, data: CreateProductData) {
    const slug = data.slug || slugify(data.name);

    // Check if slug exists
    const existingProduct = await prisma.product.findFirst({
      where: { storeId, slug },
    });

    if (existingProduct) {
      throw new AppError(409, 'ALREADY_EXISTS', 'Product with this slug already exists');
    }

    const product = await prisma.product.create({
      data: {
        storeId,
        name: data.name,
        slug,
        description: data.description,
        price: data.price,
        compareAtPrice: data.compareAtPrice,
        sku: data.sku,
        inventory: data.inventory ?? 0,
        status: data.status ?? 'draft',
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

    return product;
  }

  static async update(storeId: string, productId: string, data: UpdateProductData) {
    const product = await this.getById(storeId, productId);

    // Check slug uniqueness if changing
    if (data.slug && data.slug !== product.slug) {
      const existingProduct = await prisma.product.findFirst({
        where: { storeId, slug: data.slug, id: { not: productId } },
      });

      if (existingProduct) {
        throw new AppError(409, 'ALREADY_EXISTS', 'Product with this slug already exists');
      }
    }

    const updatedProduct = await prisma.product.update({
      where: { id: productId, storeId },
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description,
        price: data.price,
        compareAtPrice: data.compareAtPrice,
        sku: data.sku,
        inventory: data.inventory,
        status: data.status,
      },
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
      },
    });

    return updatedProduct;
  }

  static async delete(storeId: string, productId: string) {
    await this.getById(storeId, productId);

    await prisma.product.update({
      where: { id: productId, storeId },
      data: { deletedAt: new Date() },
    });
  }

  static async updateInventory(storeId: string, productId: string, quantity: number) {
    await this.getById(storeId, productId);

    return prisma.product.update({
      where: { id: productId, storeId },
      data: { inventory: quantity },
    });
  }

  // Public methods (no store scope required)
  static async listPublic(storeId: string, options: ListProductsOptions = {}) {
    const { status = 'active', category, search, featured } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      storeId,
      status: status as ProductStatus,
      deletedAt: null,
    };

    if (featured !== undefined) {
      where.featured = featured;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (category) {
      where.categories = {
        some: { category: { slug: category } },
      };
    }

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
    const categories = await prisma.category.findMany({
      where: { storeId },
      orderBy: { name: 'asc' },
    });
    return categories;
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
