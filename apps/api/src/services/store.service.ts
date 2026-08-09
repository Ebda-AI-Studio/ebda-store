import { prisma, Prisma, withMoneyTx } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { slugify } from '@force/shared';
import { redis } from './redis.service';
import { invalidateCached, invalidateCachedPrefix } from '../lib/public-cache';
import logger from '../lib/logger';
import { cleanupRemovedImages, deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { sendAlert } from './alerts.service';
import { StorageService } from './storage.service';
import { seedCoaForStore } from './accounting/account.service';
import { revalidateStorefront } from '../lib/revalidate-storefront';

/**
 * Bust every public-cache entry that depends on a store record. The
 * `public:store:<slugOrId>` key is hit by both the slug and the UUID
 * paths, so we invalidate both. `public:store:resolve:<domain>` backs
 * `GET /public/store/resolve` (the domain→store lookup every storefront
 * page load depends on) — bust it too so a domain-header'd merchant edit
 * shows up immediately instead of waiting out the 120s TTL. Categories
 * and product lists are separate keys handled by their own services, but
 * a store update can still change the embedded settings (currency, theme)
 * the storefront shows next to product cards — so we also drop
 * product/category caches for the same store. Cheap relative to the cost
 * of serving stale settings to a customer mid-purchase.
 *
 * NOTE: on a domain CHANGE, only the CURRENT `domain` value is known here
 * (callers pass `updatedStore.domain`, i.e. the NEW domain post-write) —
 * the old domain's `public:store:resolve:<oldDomain>` entry is left to
 * expire on its own 120s TTL rather than being explicitly busted. Bounded
 * staleness, not unbounded; see `docs/audits/2026-07-12-scaling-cliff-reel.md`
 * finding #1.
 */
async function bustStoreCaches(
  storeId: string,
  slug: string | null,
  domain?: string | null
): Promise<void> {
  await invalidateCached(`public:store:${storeId}`);
  if (slug) await invalidateCached(`public:store:${slug}`);
  if (domain) await invalidateCached(`public:store:resolve:${domain}`);
  await invalidateCached(`public:categories:${storeId}`);
  await invalidateCachedPrefix(`public:products:${storeId}:`);
  // Purge the storefront's Next data cache too (fire-and-forget, no-op if the
  // STOREFRONT_REVALIDATE_URL / REVALIDATE_SECRET env pair isn't configured) so
  // a merchant's edit shows on the live storefront within ~a second.
  revalidateStorefront({ slug, domain });
}

interface CreateStoreData {
  name: string;
  slug?: string;
  domain?: string;
  settings?: Prisma.InputJsonValue;
}

type UpdateStoreData = Partial<CreateStoreData> & {
  /** Return window in days. null = merchant cleared it ("not declared"); 0 = "no returns". */
  returnWindowDays?: number | null;
  /** 'merchant' (free returns) | 'customer'. null when unset. */
  returnFeesPaidBy?: string | null;
  heroTitle?: string | null;
  heroTitleAr?: string | null;
  heroSubtitle?: string | null;
  heroSubtitleAr?: string | null;
  heroCtaText?: string | null;
  heroCtaTextAr?: string | null;
  heroCtaLink?: string | null;
  heroImage?: string | null;
  /** Bucket E1 (2026-05-17): opt-in blog feature toggle. */
  blogEnabled?: boolean;
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
        // 2026-07-12 design structural batch: new stores get the persona-chrome
        // completion + card-frame dedup ON by default (Ahmad-approved for NEW
        // stores only — every existing store keeps these flags undefined/false
        // and renders unchanged). Merchant can still toggle either off via
        // Branding → Theme.
        // 2026-07-12 design-sweep batch: new stores also get a neutral-slate
        // OOS ribbon (harmonizes better than the platform's original fixed
        // terracotta) + rtlPolish (RTL-correct empty-state CTA arrow on
        // elegant). Existing stores keep both undefined and render unchanged.
        theme: {
          personaChromeV2: true,
          frameChromeDedup: true,
          oosRibbonColor: '#6b7280',
          rtlPolish: true,
        },
      },
      include: {
        owner: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    // Seed Chart of Accounts (Kuwait retail template, 27 system accounts).
    // Idempotent — safe if accountingEnabled is later toggled.
    await seedCoaForStore(store.id);

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
        ...(data.blogEnabled !== undefined && { blogEnabled: data.blogEnabled }),
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

    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);

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

    await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      // 2026-05-21 — switched from prisma.deleteMany() to raw SQL DELETE
      // statements because the Prisma-typed approach kept hitting
      // P2003 (journal_entries_store_id_fkey) even with explicit
      // tx.journalEntry.deleteMany() in the chain. Raw SQL is:
      //   1. unambiguous about which table + column the delete targets
      //      (no Prisma client cache / schema drift)
      //   2. easier to debug — each step logs storeId + affected row
      //      count via $executeRaw's number return value
      //   3. order-explicit — Postgres processes statements sequentially
      //      so any FK cascade chain is committed before the next step
      //
      // Order matters. Each step listed below corresponds to a Store FK
      // that's either Restrict OR a child whose own FK to Product is
      // NoAction. Cascade-from-Store relations clean themselves up via
      // store.delete() at the end. Schema audit done 2026-05-21:
      //   Order(Restrict), Review.order(Restrict), Expense(Restrict),
      //   StockAdjustment(Restrict), PurchaseOrder(Restrict),
      //   JournalEntry(Restrict), BackorderLine.product(NoAction),
      //   AuditLog.store(NoAction nullable).
      // ROOT CAUSE 2026-05-21 — RLS was silently filtering every delete
      // to zero rows. The accounting tables (journal_entries, expenses,
      // stock_adjustments, accounts, sequences) have row-level-security
      // policies that require either app.current_store_id GUC to match
      // OR app.bypass_rls = 'true'. Inside this transaction neither
      // was set, so DELETE matched 0 rows even though rows existed.
      // The FK violation at store.delete then fired because the
      // journal_entries rows were never actually touched.
      //
      // Set the bypass GUC for the duration of THIS transaction only —
      // SET LOCAL scoping means it dies on commit/rollback. This is a
      // super-admin-only code path (route gates with super_admin role
      // check) so bypass is appropriate here.
      await tx.$executeRaw`SET LOCAL app.bypass_rls = 'true'`;

      logger.info({ storeId }, '[STORE_DELETE] start (raw sql, rls bypassed)');

      const reviewCount =
        await tx.$executeRaw`DELETE FROM public.reviews WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: reviewCount }, '[STORE_DELETE] reviews');

      const returnCount =
        await tx.$executeRaw`DELETE FROM public.returns WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: returnCount }, '[STORE_DELETE] returns');

      const orderCount =
        await tx.$executeRaw`DELETE FROM public.orders WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: orderCount }, '[STORE_DELETE] orders');

      const expenseCount =
        await tx.$executeRaw`DELETE FROM public.expenses WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: expenseCount }, '[STORE_DELETE] expenses');

      const stockAdjCount =
        await tx.$executeRaw`DELETE FROM public.stock_adjustments WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: stockAdjCount }, '[STORE_DELETE] stockAdjustments');

      const poCount =
        await tx.$executeRaw`DELETE FROM public.purchase_orders WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: poCount }, '[STORE_DELETE] purchaseOrders');

      const journalCount =
        await tx.$executeRaw`DELETE FROM public.journal_entries WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: journalCount }, '[STORE_DELETE] journalEntries');

      const backorderCount =
        await tx.$executeRaw`DELETE FROM public.backorder_lines WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: backorderCount }, '[STORE_DELETE] backorderLines');

      // Detach historical audit logs by nulling their storeId (preserves trail).
      const auditCount =
        await tx.$executeRaw`UPDATE public.audit_logs SET store_id = NULL WHERE store_id = ${storeId}`;
      logger.info({ storeId, count: auditCount }, '[STORE_DELETE] auditLogs (detached)');

      // Verification: count any rows that would still block the store delete.
      // If any of these come back > 0, we know exactly which table.
      const blocking = await tx.$queryRaw<Array<{ table_name: string; cnt: bigint }>>`
        SELECT 'orders' AS table_name, COUNT(*)::bigint AS cnt FROM public.orders WHERE store_id = ${storeId}
        UNION ALL SELECT 'journal_entries', COUNT(*)::bigint FROM public.journal_entries WHERE store_id = ${storeId}
        UNION ALL SELECT 'expenses', COUNT(*)::bigint FROM public.expenses WHERE store_id = ${storeId}
        UNION ALL SELECT 'stock_adjustments', COUNT(*)::bigint FROM public.stock_adjustments WHERE store_id = ${storeId}
        UNION ALL SELECT 'purchase_orders', COUNT(*)::bigint FROM public.purchase_orders WHERE store_id = ${storeId}
      `;
      const stillBlocking = blocking.filter(b => Number(b.cnt) > 0);
      if (stillBlocking.length > 0) {
        logger.error({ storeId, stillBlocking }, '[STORE_DELETE] BLOCKING rows still exist');
      }

      // Final delete — cascades products, categories, customers, pages,
      // carts, coupons, accounts, suppliers, backorders, etc.
      await tx.$executeRaw`DELETE FROM public.stores WHERE id = ${storeId}`;
      logger.info({ storeId }, '[STORE_DELETE] store deleted');

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
    await bustStoreCaches(storeId, store.slug, store.domain);

    // Reclaim R2 storage: every upload for this store is namespaced under
    // `stores/<storeId>/...`, so purge that whole prefix. Best-effort + AFTER
    // the DB commit — a storage hiccup must never block (or roll back) the
    // store deletion. Orphaned objects would otherwise sit in the bucket
    // forever (there is no other cleanup path on delete).
    try {
      const { deleted, failedKeys, remaining } = await StorageService.deleteByPrefixVerified(
        `stores/${storeId}/`
      );
      logger.info({ storeId, deleted, remaining }, '[STORE_DELETE] purged R2 objects');
      if (remaining > 0) {
        // Objects survived the purge, so they are now orphaned: the store row
        // is gone, nothing references them, and no other code path will ever
        // reclaim that prefix. Alert instead of logging quietly — this exact
        // silence left an object from a 2026-06-15 delete in the bucket until
        // a manual audit found it on 2026-08-09.
        void sendAlert({
          level: 'p1',
          scope: 'platform',
          source: 'store.delete.r2_orphaned',
          title: 'R2 purge incomplete after store delete',
          body: `${remaining} object(s) survived the purge of stores/${storeId}/ and are now orphaned — the store row is gone so nothing will reclaim them. Delete the prefix manually.`,
          context: { storeId, deleted, remaining, failedKeys: failedKeys.slice(0, 20) },
        }).catch(() => undefined);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown', storeId },
        '[STORE_DELETE] R2 prefix purge failed (objects orphaned, DB delete stands)'
      );
    }

    return { id: storeId, name: store.name, slug: store.slug };
  }

  static async getStoreStats(storeId: string) {
    // Revenue = orders that are EITHER confirmed-and-beyond by fulfillment
    // status OR paid by payment status. Captures the case where an order
    // sits in 'pending' fulfillment but the customer's card was already
    // charged (Tap/MyFatoorah webhook landed the payment but a fulfillment
    // worker hasn't moved the order forward yet). Without the paymentStatus
    // arm, dashboards showed Revenue=0 even when KWDs had been collected.
    // Ahmad 2026-05-21 — Wadyaljuz had 23 orders, KWD 0.000 revenue.
    const [productCount, orderCount, customerCount, totalRevenue, recentOrders] = await Promise.all(
      [
        prisma.product.count({ where: { storeId, status: 'active' } }),
        prisma.order.count({ where: { storeId } }),
        prisma.customer.count({ where: { storeId } }),
        prisma.order.aggregate({
          where: {
            storeId,
            OR: [
              { status: { in: ['confirmed', 'processing', 'shipped', 'delivered'] } },
              { paymentStatus: 'paid' },
            ],
          },
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
      ]
    );

    return {
      productCount,
      orderCount,
      customerCount,
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
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }

  // Shallow-merge PATCH for the theme JSON column. Multiple admin surfaces
  // write `theme` (Branding ThemeTab writes fonts/preset/footer-logo; the
  // Page Builder Smart Palette writes the brand color tokens). Each used to
  // PUT the WHOLE theme object, so the last writer clobbered keys the other
  // surface had just changed (open Branding + Page Builder in two tabs → one
  // save reverts the other's edits). Merging incoming keys into the stored
  // theme means a surface only ever overwrites the keys it explicitly sends;
  // keys absent from the payload are preserved. Same read-merge-write posture
  // as `updateFloatingWidget` / `updateSocialLinks`.
  static async updateTheme(storeId: string, theme: Record<string, unknown>) {
    const store = await this.getById(storeId);
    const existingTheme = (store.theme as Record<string, unknown>) || {};
    const mergedTheme = { ...existingTheme, ...theme };

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { theme: mergedTheme as Prisma.InputJsonValue },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
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
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);

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
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
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
      /** Phase D.6 — WhatsApp bot "Locations & Hours" branch */
      businessHours?: string;
      googleMapsUrl?: string;
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
        businessHours: contact.businessHours,
        googleMapsUrl: contact.googleMapsUrl,
      },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }

  // Shallow-merge PATCH for the announcement-bar JSONB. The `/announcement`
  // admin page owns the TEXT content (text / textAr / link / linkText* /
  // dismissible / textColor); the Page Builder owns VISIBILITY + bgColor
  // (layout.announcement.enabled / bgColor, which win at render). The
  // `/announcement` page no longer sends `enabled`/`bgColor`, so merging
  // (instead of whole-object replace) preserves any legacy values already
  // stored there and avoids wiping keys this surface no longer edits.
  static async updateAnnouncementBar(storeId: string, announcementBar: Record<string, unknown>) {
    const store = await this.getById(storeId);
    const existing =
      store.announcementBar && typeof store.announcementBar === 'object'
        ? (store.announcementBar as Record<string, unknown>)
        : {};
    const merged = { ...existing, ...announcementBar };

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { announcementBar: merged as Prisma.InputJsonValue },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }

  // Dedicated writer for the floating-widget config so the admin doesn't
  // round-trip the whole `settings` JSON. The generic PUT /stores/:id
  // route accepts settings but routing the floating widget through there
  // means clients have to GET-merge-PUT — and any stale local copy of
  // `store.settings` clobbers concurrent writes from other admin tabs
  // (or wipes fields the page hasn't loaded). Merging in here keeps
  // floatingWidget surgical: read existing settings JSON, splice the
  // new sub-key in, write back. Same posture as the announcement-bar
  // writer above, but folded into the `settings` JSON column instead
  // of a dedicated column.
  static async updateFloatingWidget(storeId: string, floatingWidget: Record<string, unknown>) {
    const store = await this.getById(storeId);
    const existingSettings = (store.settings as Record<string, unknown>) || {};
    const mergedSettings = { ...existingSettings, floatingWidget };

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: { settings: mergedSettings as Prisma.InputJsonValue },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }

  static async updateSeo(
    storeId: string,
    seo: {
      metaTitle?: string;
      metaTitleAr?: string;
      metaDescription?: string;
      metaDescriptionAr?: string;
      metaDescriptionAeo?: string | null;
      metaDescriptionAeoAr?: string | null;
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
        ...(seo.metaDescriptionAeo !== undefined
          ? { metaDescriptionAeo: seo.metaDescriptionAeo }
          : {}),
        ...(seo.metaDescriptionAeoAr !== undefined
          ? { metaDescriptionAeoAr: seo.metaDescriptionAeoAr }
          : {}),
        ogImage: seo.ogImage,
        twitterHandle: seo.twitterHandle,
        googleSiteVerification: seo.googleSiteVerification,
        emailSenderLocalPart: seo.emailSenderLocalPart,
      },
    });

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);

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
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }
}
