import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';

interface CreateStoreData {
  name: string;
  slug?: string;
  domain?: string;
  settings?: Record<string, unknown>;
}

type UpdateStoreData = Partial<CreateStoreData>;

export class StoreService {
  static async list(options: { page?: number; limit?: number } = {}) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const [stores, total] = await Promise.all([
      prisma.store.findMany({
        skip,
        take: limit,
        include: {
          owner: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          _count: { select: { products: true, orders: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.store.count(),
    ]);

    return {
      stores,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getById(storeId: string) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: {
        owner: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        _count: { select: { products: true, orders: true, categories: true } },
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    return store;
  }

  static async getBySlug(slug: string) {
    const store = await prisma.store.findUnique({
      where: { slug },
      include: {
        _count: { select: { products: true, categories: true } },
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    return store;
  }

  static async create(ownerId: string, data: CreateStoreData) {
    const slug = data.slug || slugify(data.name);

    // Check if slug exists
    const existingStore = await prisma.store.findUnique({
      where: { slug },
    });

    if (existingStore) {
      throw new AppError(409, 'ALREADY_EXISTS', 'Store with this slug already exists');
    }

    // Check domain uniqueness
    if (data.domain) {
      const existingDomain = await prisma.store.findUnique({
        where: { domain: data.domain },
      });

      if (existingDomain) {
        throw new AppError(409, 'ALREADY_EXISTS', 'Store with this domain already exists');
      }
    }

    const store = await prisma.store.create({
      data: {
        name: data.name,
        slug,
        domain: data.domain,
        ownerId,
        settings: data.settings || {
          currency: 'USD',
          timezone: 'UTC',
          locale: 'en-US',
        },
      },
      include: {
        owner: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    return store;
  }

  static async update(storeId: string, data: UpdateStoreData) {
    const store = await this.getById(storeId);

    // Check slug uniqueness if changing
    if (data.slug && data.slug !== store.slug) {
      const existingStore = await prisma.store.findUnique({
        where: { slug: data.slug },
      });

      if (existingStore) {
        throw new AppError(409, 'ALREADY_EXISTS', 'Store with this slug already exists');
      }
    }

    // Check domain uniqueness if changing
    if (data.domain && data.domain !== store.domain) {
      const existingDomain = await prisma.store.findUnique({
        where: { domain: data.domain },
      });

      if (existingDomain) {
        throw new AppError(409, 'ALREADY_EXISTS', 'Store with this domain already exists');
      }
    }

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        name: data.name,
        slug: data.slug,
        domain: data.domain,
        settings: data.settings,
      },
      include: {
        owner: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    return updatedStore;
  }

  static async delete(storeId: string) {
    await this.getById(storeId);

    await prisma.store.delete({
      where: { id: storeId },
    });
  }

  static async getStoreStats(storeId: string) {
    const [productCount, orderCount, totalRevenue, recentOrders] = await Promise.all([
      prisma.product.count({ where: { storeId, status: 'active' } }),
      prisma.order.count({ where: { storeId } }),
      prisma.order.aggregate({
        where: { storeId, status: { in: ['confirmed', 'processing', 'shipped', 'delivered'] } },
        _sum: { total: true },
      }),
      prisma.order.findMany({
        where: { storeId },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { firstName: true, lastName: true, email: true } },
        },
      }),
    ]);

    return {
      productCount,
      orderCount,
      totalRevenue: totalRevenue._sum.total || 0,
      recentOrders,
    };
  }
}
