import { prisma, Prisma } from '@force/database';
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

export class ProductService {
  static async list(storeId: string, options: ListProductsOptions = {}) {
    const { page = 1, limit = 20, status, category, search, featured } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = { storeId };

    if (status) {
      where.status = status;
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
      where: { id: productId },
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

    await prisma.product.delete({
      where: { id: productId },
    });
  }

  static async updateInventory(storeId: string, productId: string, quantity: number) {
    await this.getById(storeId, productId);

    return prisma.product.update({
      where: { id: productId },
      data: { inventory: quantity },
    });
  }

  // Public methods (no store scope required)
  static async listPublic(options: ListProductsOptions = {}) {
    const { page = 1, limit = 20, status = 'active', category, search, featured } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = { status };

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

  static async getPublicBySlug(slug: string) {
    const product = await prisma.product.findFirst({
      where: { slug, status: 'active' },
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

  static async getPublicById(productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, status: 'active' },
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

  static async getCategories() {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' },
    });
    return categories;
  }
}
