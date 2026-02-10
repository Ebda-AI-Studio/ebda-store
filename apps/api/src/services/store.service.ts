import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';

interface CreateStoreData {
  name: string;
  slug?: string;
  domain?: string;
  settings?: Prisma.InputJsonValue;
}

type UpdateStoreData = Partial<CreateStoreData>;

export class StoreService {
  static async list(options: { page?: number; limit?: number } = {}) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
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
          currency: 'KWD',
          timezone: 'Asia/Kuwait',
          locale: 'en-KW',
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

    await prisma.store.update({
      where: { id: storeId },
      data: { deletedAt: new Date() },
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

  static async getByDomain(domain: string) {
    const store = await prisma.store.findUnique({
      where: { domain },
      include: {
        _count: { select: { products: true, categories: true } },
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    return store;
  }

  static async updateTemplate(storeId: string, template: string) {
    await this.getById(storeId);

    const validTemplates = ['modern', 'classic', 'minimal', 'bold', 'elegant'];
    if (!validTemplates.includes(template)) {
      throw new AppError(
        400,
        'INVALID_TEMPLATE',
        `Template must be one of: ${validTemplates.join(', ')}`
      );
    }

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { template: template as 'modern' | 'classic' | 'minimal' | 'bold' | 'elegant' },
    });

    return updatedStore;
  }

  static async updateTheme(storeId: string, theme: Prisma.InputJsonValue) {
    await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { theme },
    });

    return updatedStore;
  }

  static async updateBranding(
    storeId: string,
    branding: {
      name?: string;
      nameAr?: string;
      logo?: string;
      logoAr?: string;
      favicon?: string;
    }
  ) {
    await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        name: branding.name,
        nameAr: branding.nameAr,
        logo: branding.logo,
        logoAr: branding.logoAr,
        favicon: branding.favicon,
      },
    });

    return updatedStore;
  }

  static async updateSocialLinks(storeId: string, socialLinks: Prisma.InputJsonValue) {
    await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { socialLinks },
    });

    return updatedStore;
  }

  static async updateContactInfo(
    storeId: string,
    contact: {
      email?: string;
      phone?: string;
      phoneAr?: string;
      whatsapp?: string;
      address?: string;
      addressAr?: string;
    }
  ) {
    await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        email: contact.email,
        phone: contact.phone,
        phoneAr: contact.phoneAr,
        whatsapp: contact.whatsapp,
        address: contact.address,
        addressAr: contact.addressAr,
      },
    });

    return updatedStore;
  }

  static async updateAnnouncementBar(storeId: string, announcementBar: Prisma.InputJsonValue) {
    await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { announcementBar },
    });

    return updatedStore;
  }

  static async updateSeo(
    storeId: string,
    seo: {
      metaTitle?: string;
      metaTitleAr?: string;
      metaDescription?: string;
      metaDescriptionAr?: string;
    }
  ) {
    await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        metaTitle: seo.metaTitle,
        metaTitleAr: seo.metaTitleAr,
        metaDescription: seo.metaDescription,
        metaDescriptionAr: seo.metaDescriptionAr,
      },
    });

    return updatedStore;
  }

  static async updateMarketingPixels(storeId: string, marketingPixels: Prisma.InputJsonValue) {
    await this.getById(storeId);

    // Extract individual pixel IDs from the marketingPixels object for quick access
    const pixels = marketingPixels as Record<
      string,
      {
        enabled?: boolean;
        pixelId?: string;
        measurementId?: string;
        containerId?: string;
        conversionId?: string;
        tagId?: string;
      }
    >;

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        marketingPixels,
        metaPixelId: pixels.meta?.enabled ? pixels.meta.pixelId : null,
        tiktokPixelId: pixels.tiktok?.enabled ? pixels.tiktok.pixelId : null,
        snapchatPixelId: pixels.snapchat?.enabled ? pixels.snapchat.pixelId : null,
        googleAnalyticsId: pixels.googleAnalytics?.enabled
          ? pixels.googleAnalytics.measurementId
          : null,
        googleTagManagerId: pixels.googleTagManager?.enabled
          ? pixels.googleTagManager.containerId
          : null,
        googleAdsId: pixels.googleAds?.enabled ? pixels.googleAds.conversionId : null,
        twitterPixelId: pixels.twitter?.enabled ? pixels.twitter.pixelId : null,
        pinterestTagId: pixels.pinterest?.enabled ? pixels.pinterest.tagId : null,
      },
    });

    return updatedStore;
  }
}
