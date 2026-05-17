import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';
import { redis } from './redis.service';
import { invalidateCached, invalidateCachedPrefix } from '../lib/public-cache';
import logger from '../lib/logger';
import { cleanupRemovedImages, deleteR2ObjectIfOrphan } from './r2-cleanup.service';

/**
 * Bust every public-cache entry that depends on a store record. The
 * `public:store:<slugOrId>` key is hit by both the slug and the UUID
 * paths, so we invalidate both. Categories and product lists are
 * separate keys handled by their own services, but a store update can
 * still change the embedded settings (currency, theme) the storefront
 * shows next to product cards — so we also drop product/category
 * caches for the same store. Cheap relative to the cost of serving
 * stale settings to a customer mid-purchase.
 */
async function bustStoreCaches(storeId: string, slug: string | null): Promise<void> {
  await invalidateCached(`public:store:${storeId}`);
  if (slug) await invalidateCached(`public:store:${slug}`);
  await invalidateCached(`public:categories:${storeId}`);
  invalidateCachedPrefix(`public:products:${storeId}:`);
}

interface CreateStoreData {
  name: string;
  slug?: string;
  domain?: string;
  settings?: Prisma.InputJsonValue;
}

type UpdateStoreData = Partial<CreateStoreData> & {
  heroTitle?: string | null;
  heroTitleAr?: string | null;
  heroSubtitle?: string | null;
  heroSubtitleAr?: string | null;
  heroCtaText?: string | null;
  heroCtaTextAr?: string | null;
  heroCtaLink?: string | null;
  heroImage?: string | null;
};

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

    // Write to cache (best-effort, 120s TTL — invalidated explicitly
    // on every store update so admin edits land within seconds, not
    // minutes).
    try {
      await redis.set(`store:slug:${slug}`, JSON.stringify(store), 120);
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
    // Snapshot the heroImage URL so a replaced banner gets the old R2
    // object cleaned up post-commit. Same posture as branding / seo /
    // category / page cover paths.
    const previousHeroImage = (store as { heroImage?: string | null }).heroImage ?? null;

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
        ...(data.heroTitle !== undefined && { heroTitle: data.heroTitle }),
        ...(data.heroTitleAr !== undefined && { heroTitleAr: data.heroTitleAr }),
        ...(data.heroSubtitle !== undefined && { heroSubtitle: data.heroSubtitle }),
        ...(data.heroSubtitleAr !== undefined && { heroSubtitleAr: data.heroSubtitleAr }),
        ...(data.heroCtaText !== undefined && { heroCtaText: data.heroCtaText }),
        ...(data.heroCtaTextAr !== undefined && { heroCtaTextAr: data.heroCtaTextAr }),
        ...(data.heroCtaLink !== undefined && { heroCtaLink: data.heroCtaLink }),
        ...(data.heroImage !== undefined && { heroImage: data.heroImage }),
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

    await bustStoreCaches(updatedStore.id, updatedStore.slug);

    if (data.heroImage !== undefined && previousHeroImage && previousHeroImage !== data.heroImage) {
      void deleteR2ObjectIfOrphan(previousHeroImage).catch(err =>
        logger.warn({ err, storeId }, '[store.update] hero r2 cleanup failed')
      );
    }

    return updatedStore;
  }

  /**
   * Hard-delete a store and ALL of its data.
   *
   * Most Store->X relations have `onDelete: Cascade` so the database removes
   * them automatically. A few relations don't, so we clean them up explicitly
   * inside a transaction:
   *   - `Order.store` is `Restrict` (prevents accidental deletes from app
   *     code). We delete orders manually here; the order's children
   *     (OrderItem, Payment, Shipment) cascade from Order.
   *   - `Return.order` has no onDelete (defaults to NoAction), so we delete
   *     returns BEFORE orders to avoid an FK violation.
   *   - `AuditLog.store` has no onDelete and we want to preserve the trail
   *     post-deletion, so we null its storeId for this store before delete.
   *
   * Caller is responsible for super_admin authorization (route enforces it)
   * and for writing the STORE_DELETED audit log AFTER this returns successfully.
   */
  static async delete(storeId: string) {
    const store = await this.getById(storeId);

    await prisma.$transaction(async tx => {
      // Returns reference orders with no cascade — clear them first.
      await tx.return.deleteMany({ where: { storeId } });
      // Orders are Restrict-on-delete from Store; remove them explicitly.
      // OrderItem / Payment / Shipment cascade from Order.
      await tx.order.deleteMany({ where: { storeId } });
      // Preserve historical audit logs by detaching them from the store.
      await tx.auditLog.updateMany({ where: { storeId }, data: { storeId: null } });
      // Now the store delete cascades through everything else
      // (products, categories, customers, pages, carts, coupons, etc.).
      await tx.store.delete({ where: { id: storeId } });

      // If the owner was a store_admin and this was their only store,
      // delete the user too. Otherwise they remain in the system as a
      // login-able account with no stores to manage — confusing UI and
      // dead weight on the users list. Super-admins are never deleted
      // here (they own the platform, not specific stores). Cleaned up
      // historically by `scripts/admin-cleanup-orphan-store-admins.mjs`.
      const owner = await tx.user.findUnique({
        where: { id: store.ownerId },
        select: { id: true, role: true, _count: { select: { stores: true } } },
      });
      if (owner && owner.role === 'store_admin' && owner._count.stores === 0) {
        await tx.auditLog.updateMany({ where: { userId: owner.id }, data: { userId: null } });
        await tx.refreshToken.deleteMany({ where: { userId: owner.id } });
        await tx.verificationToken.deleteMany({ where: { userId: owner.id } });
        await tx.oneSignalSubscription.deleteMany({ where: { userId: owner.id } });
        await tx.user.delete({ where: { id: owner.id } });
      }
    });

    // Invalidate store cache (best-effort, post-commit)
    try {
      await redis.delete(`store:slug:${store.slug}`);
      if (store.domain) await redis.delete(`store:domain:${store.domain}`);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache invalidation failed on delete'
      );
    }

    // Public-facing storefront caches too — same logic as updates.
    await bustStoreCaches(storeId, store.slug);

    return { id: storeId, name: store.name, slug: store.slug };
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

    // Write to cache (best-effort, 120s TTL — invalidated on store updates).
    try {
      await redis.set(`store:domain:${domain}`, JSON.stringify(store), 120);
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
    await bustStoreCaches(updatedStore.id, updatedStore.slug);
    return updatedStore;
  }

  static async updateTheme(storeId: string, theme: Prisma.InputJsonValue) {
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { theme },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug);
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
    await bustStoreCaches(updatedStore.id, updatedStore.slug);

    // Diff the three image fields and queue cleanup for any URL that
    // was replaced. `undefined` in the patch means "leave existing", so
    // only fire when the caller explicitly sent the field.
    const oldUrls: string[] = [];
    const newUrls: string[] = [];
    const s = store as {
      logo?: string | null;
      logoAr?: string | null;
      favicon?: string | null;
    };
    if (branding.logo !== undefined) {
      if (s.logo) oldUrls.push(s.logo);
      if (branding.logo) newUrls.push(branding.logo);
    }
    if (branding.logoAr !== undefined) {
      if (s.logoAr) oldUrls.push(s.logoAr);
      if (branding.logoAr) newUrls.push(branding.logoAr);
    }
    if (branding.favicon !== undefined) {
      if (s.favicon) oldUrls.push(s.favicon);
      if (branding.favicon) newUrls.push(branding.favicon);
    }
    if (oldUrls.length > 0) {
      void cleanupRemovedImages(oldUrls, newUrls).catch(err =>
        logger.warn({ err, storeId }, '[store.updateBranding] r2 cleanup failed')
      );
    }

    return updatedStore;
  }

  static async updateSocialLinks(storeId: string, socialLinks: Prisma.InputJsonValue) {
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { socialLinks },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug);
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
    await bustStoreCaches(updatedStore.id, updatedStore.slug);
    return updatedStore;
  }

  static async updateAnnouncementBar(storeId: string, announcementBar: Prisma.InputJsonValue) {
    const store = await this.getById(storeId);

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { announcementBar },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug);
    return updatedStore;
  }

  static async updateSeo(
    storeId: string,
    seo: {
      metaTitle?: string;
      metaTitleAr?: string;
      metaDescription?: string;
      metaDescriptionAr?: string;
      ogImage?: string;
      twitterHandle?: string;
      googleSiteVerification?: string;
      emailSenderLocalPart?: string;
    }
  ) {
    const store = await this.getById(storeId);
    const previousOgImage = (store as { ogImage?: string | null }).ogImage ?? null;

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        metaTitle: seo.metaTitle,
        metaTitleAr: seo.metaTitleAr,
        metaDescription: seo.metaDescription,
        metaDescriptionAr: seo.metaDescriptionAr,
        ogImage: seo.ogImage,
        twitterHandle: seo.twitterHandle,
        googleSiteVerification: seo.googleSiteVerification,
        emailSenderLocalPart: seo.emailSenderLocalPart,
      },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug);

    if (seo.ogImage !== undefined && previousOgImage && previousOgImage !== seo.ogImage) {
      void deleteR2ObjectIfOrphan(previousOgImage).catch(err =>
        logger.warn({ err, storeId }, '[store.updateSeo] og-image r2 cleanup failed')
      );
    }

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
    await bustStoreCaches(updatedStore.id, updatedStore.slug);
    return updatedStore;
  }
}
