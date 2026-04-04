import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';
import { redis } from './redis.service';
import logger from '../lib/logger';

interface CreateStoreData {
  name: string;
  slug?: string;
  domain?: string;
  settings?: Prisma.InputJsonValue;
}

type UpdateStoreData = Partial<CreateStoreData>;

export class StoreService {
  /**
   * Invalidate all Redis cache keys for a store.
   * Requires the store record so we know which slug/domain keys to delete.
   * Best-effort: failures are logged but never thrown.
   */
  private static async invalidateCache(store: {
    slug: string;
    domain?: string | null;
  }): Promise<void> {
    try {
      await redis.delete(`store:slug:${store.slug}`);
      if (store.domain) await redis.delete(`store:domain:${store.domain}`);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache invalidation failed'
      );
    }
  }

  static async list(options: { page?: number; limit?: number; ownerId?: string } = {}) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where = options.ownerId ? { ownerId: options.ownerId } : {};

    const [stores, total] = await Promise.all([
      prisma.store.findMany({
        where,
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
      prisma.store.count({ where }),
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
    // Try Redis cache first (best-effort)
    try {
      const cached = await redis.get<string>(`store:slug:${slug}`);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return parsed;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache read failed for getBySlug'
      );
    }

    const store = await prisma.store.findUnique({
      where: { slug },
      include: {
        _count: { select: { products: true, categories: true } },
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    // Write to cache (best-effort, 60s TTL)
    try {
      await redis.set(`store:slug:${slug}`, JSON.stringify(store), 60);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache write failed for getBySlug'
      );
    }

    return store;
  }

  static async create(ownerId: string, data: CreateStoreData) {
    const baseSlug = data.slug || slugify(data.name);

    // Auto-deduplicate slug
    let slug = baseSlug;
    let suffix = 0;
    while (await prisma.store.findUnique({ where: { slug } })) {
      suffix++;
      if (suffix > 100) throw new AppError(409, 'SLUG_COLLISION', 'Too many slug collisions');
      slug = `${baseSlug}-${suffix}`;
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

    // Auto-deduplicate slug if changing
    if (data.slug && data.slug !== store.slug) {
      const baseSlug = data.slug;
      let suffix = 0;
      while (await prisma.store.findUnique({ where: { slug: data.slug } })) {
        suffix++;
        if (suffix > 100) throw new AppError(409, 'SLUG_COLLISION', 'Too many slug collisions');
        data.slug = `${baseSlug}-${suffix}`;
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

    // Merge settings instead of replacing entirely
    let mergedSettings = data.settings;
    if (data.settings && typeof data.settings === 'object') {
      const existingSettings = (store.settings as Record<string, unknown>) || {};
      mergedSettings = {
        ...existingSettings,
        ...(data.settings as Record<string, unknown>),
      } as Prisma.InputJsonValue;
    }

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        name: data.name,
        slug: data.slug,
        domain: data.domain,
        settings: mergedSettings,
      },
      include: {
        owner: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    // Invalidate store cache (best-effort)
    try {
      await redis.delete(`store:slug:${store.slug}`);
      if (store.domain) await redis.delete(`store:domain:${store.domain}`);
      // Also invalidate updated keys if slug/domain changed
      if (data.slug && data.slug !== store.slug) await redis.delete(`store:slug:${data.slug}`);
      if (data.domain && data.domain !== store.domain)
        await redis.delete(`store:domain:${data.domain}`);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache invalidation failed'
      );
    }

    return updatedStore;
  }

  static async delete(storeId: string) {
    const store = await this.getById(storeId);

    await prisma.store.update({
      where: { id: storeId },
      data: { deletedAt: new Date() },
    });

    // Invalidate store cache (best-effort)
    try {
      await redis.delete(`store:slug:${store.slug}`);
      if (store.domain) await redis.delete(`store:domain:${store.domain}`);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache invalidation failed on delete'
      );
    }
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
    // Try Redis cache first (best-effort)
    try {
      const cached = await redis.get<string>(`store:domain:${domain}`);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return parsed;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache read failed for getByDomain'
      );
    }

    const store = await prisma.store.findUnique({
      where: { domain },
      include: {
        _count: { select: { products: true, categories: true } },
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    // Write to cache (best-effort, 60s TTL)
    try {
      await redis.set(`store:domain:${domain}`, JSON.stringify(store), 60);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache write failed for getByDomain'
      );
    }

    return store;
  }

  static async updateTemplate(storeId: string, template: string) {
    const store = await this.getById(storeId);

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

    await StoreService.invalidateCache(store);
    return updatedStore;
  }

  static async updateTheme(storeId: string, theme: Prisma.InputJsonValue) {
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { theme },
    });

    await StoreService.invalidateCache(store);
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
      description?: string;
      descriptionAr?: string;
    }
  ) {
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        name: branding.name,
        nameAr: branding.nameAr,
        logo: branding.logo,
        logoAr: branding.logoAr,
        favicon: branding.favicon,
        description: branding.description,
        descriptionAr: branding.descriptionAr,
      },
    });

    await StoreService.invalidateCache(store);
    return updatedStore;
  }

  static async updateSocialLinks(storeId: string, socialLinks: Prisma.InputJsonValue) {
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { socialLinks },
    });

    await StoreService.invalidateCache(store);
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
    const store = await this.getById(storeId);

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

    await StoreService.invalidateCache(store);
    return updatedStore;
  }

  static async updateAnnouncementBar(storeId: string, announcementBar: Prisma.InputJsonValue) {
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { announcementBar },
    });

    await StoreService.invalidateCache(store);
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
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        metaTitle: seo.metaTitle,
        metaTitleAr: seo.metaTitleAr,
        metaDescription: seo.metaDescription,
        metaDescriptionAr: seo.metaDescriptionAr,
      },
    });

    await StoreService.invalidateCache(store);
    return updatedStore;
  }

  static async updateMarketingPixels(storeId: string, marketingPixels: Prisma.InputJsonValue) {
    const store = await this.getById(storeId);

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

    await StoreService.invalidateCache(store);
    return updatedStore;
  }
}
