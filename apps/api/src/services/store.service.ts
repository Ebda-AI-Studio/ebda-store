import {
  prisma,
  Prisma,
  scopeTransaction,
  asPlatformOperator,
  acrossStores,
  withStore,
  withUser,
  withMoneyTx,
  StoreStatus,
} from '@ebda/database';
import { copyStoreSettings, storeDb, storeRepo, syncStoreFields } from '../lib/repo-factory';
import type { StoreTemplate } from '@ebda/database';
import {
  deleteUserTokens,
  detachStoreAuditLogs,
  lookupStore,
  storeIdByDomain,
  storeIdBySlug,
  unlinkUserAuditLogs,
} from '../lib/definer';
import { AppError } from '../middleware/error-handler';
import { assertMediaOriginOrUnchanged } from '../lib/media-url-guard';
import { config as appConfig } from '../config';
import { archiveFiscalRecords, assertNoMoneyInFlight } from './store-closure.service';
import { assertStoreSlug, deriveStoreSlug } from '../lib/store-slug';
import {
  slugifyWithFallback,
  isReservedSlug,
  isProtectedSlug,
  STORE_SLUG_ERROR_MESSAGES,
  storeHost,
  REGION,
  STORE_PLAN_TO_PLAN_CODE,
  NEW_STORE_LAYOUT_SETTINGS,
  getLook,
  LOOK_OWNED_THEME_KEYS,
  mergeClientSettings,
  stripServerOwnedSettings,
  isRetiredTemplate,
  normalizeLegacyTemplate,
} from '@ebda/shared';
import { applyFamilyForLook, previewFamilyForLook } from './page-builder.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { redis } from './redis.service';
import { invalidateCached, invalidateCachedPrefix } from '../lib/public-cache';
import logger from '../lib/logger';
import {
  deleteStoreClients,
  eraseIdentityUser,
  getAccountState,
  isIdentityManagedUser,
  setAccountStatus,
} from '../lib/identity-client';
import { cleanupRemovedImages, deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { sendAlert } from './alerts.service';
import { StorageService } from './storage.service';
import { seedCoaForStore } from './accounting/account.service';
import { revalidateStorefront } from '../lib/revalidate-storefront';
import { bustCorsCache } from '../lib/cors-cache';
import {
  assertOwnerMayCreateStore,
  assertPlanAllows,
  assertWithinLimit,
} from './plan-limit.service';
import { sortOwnerStores } from './billing/billing-parent';
import { NEW_STORE_LEGACY_PLAN, syncSubscriptionFromLegacyPlan } from './plan-sync';
import { startSignupTrial } from './billing/trial';

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
export async function bustStoreCaches(
  storeId: string,
  slug: string | null,
  domain?: string | null
): Promise<void> {
  await invalidateCached(`public:store:${storeId}`);
  if (slug) {
    await invalidateCached(`public:store:${slug}`);
    // `<slug>.ebda.app` resolves by slug and is cached under its HOST.
    await invalidateCached(`public:store:resolve:${storeHost(slug)}`);
  }
  if (domain) await invalidateCached(`public:store:resolve:${domain}`);
  // The credentialed-CORS trust for the domain depends on the store's status
  // too (#1214), so it is busted on the same writes.
  if (domain) bustCorsCache(domain);
  if (slug) bustCorsCache(storeHost(slug));
  await invalidateCached(`public:categories:${storeId}`);
  await invalidateCachedPrefix(`public:products:${storeId}:`);
  // Purge the storefront's Next data cache too (fire-and-forget, no-op if the
  // STOREFRONT_REVALIDATE_URL / REVALIDATE_SECRET env pair isn't configured) so
  // a merchant's edit shows on the live storefront within ~a second.
  // `layout:<storeId>` is the tag on every storefront fetch of the page-builder
  // layout (`GET /public/stores/:id/layout`); without it a layout save could not
  // reach the Next data cache and stayed stale for the 60s revalidate window.
  revalidateStorefront({ slug, domain, tags: [`layout:${storeId}`] });
}

/**
 * Settings write-through (Ruling CF-WRITES-2): runs the authoritative `Store` update (D1/Postgres) exactly as `withStore`
 * did, then copies the changed fields to the Durable Object's settings copy for a store served by its DO. On Postgres the
 * copy is a no-op. The patch is captured from the `tx.store.update({ data })` call itself, so no call site restates it.
 */
async function updateStoreThrough<T>(
  storeId: string,
  run: (tx: Parameters<Parameters<typeof withStore>[1]>[0]) => Promise<T>
): Promise<T> {
  let patch: Record<string, unknown> | undefined;
  const result = await withStore(storeId, tx => {
    const watched = new Proxy(tx as object, {
      get(target, prop) {
        const v = (target as any)[prop];
        if (prop !== 'store') return v;
        return new Proxy(v, {
          get(st, m) {
            if (m !== 'update') return st[m];
            return (args: { data: Record<string, unknown> }) => {
              patch = args.data;
              return st.update(args);
            };
          },
        });
      },
    });
    return run(watched as typeof tx);
  });
  if (patch) await copyStoreSettings(storeId, patch);
  return result as T;
}

/**
 * Convenience wrapper for callers that only have a `storeId` in scope (the
 * bulk-AI Inngest sweeps that write FAQs/HowTos/llmsTxt/aboutJson — all
 * served off the `public:store:*` keys `bustStoreCaches` busts, never off
 * `public:products:*`). Looks up the slug/domain needed to bust every
 * `public:store:*` key for this store, then delegates. #1333: those sweeps
 * previously called `invalidateStoreProductCaches(storeId)`, which busts the
 * wrong namespace entirely for store-level content.
 */
export async function bustStoreCachesById(storeId: string): Promise<void> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { slug: true, domain: true },
    })
  );
  if (!store) return;
  await bustStoreCaches(storeId, store.slug, store.domain);
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
  /** IANA zone governing finance-report / tax-period days (validated at the route). */
  timezone?: string;
  /**
   * Gate for the store-locations feature. Accepted by updateStoreSchema and
   * PUT by the admin's LocationsTab, but it was absent from BOTH this type and
   * the write below — so the toggle looked like it worked (the tab sets local
   * state optimistically) until a reload, and the public locations endpoint
   * kept 404ing.
   *
   * Typing a field here has no runtime effect on its own: the write is an
   * explicit whitelist, and a field this type declares but that object omits is
   * still silently dropped. The round-trip test is what actually holds them
   * together.
   */
  locationsEnabled?: boolean;
};

/**
 * Row counts the store payloads carry (`_count`). `products`, `orders` and `categories` are
 * store-scoped under strict RLS, so a relation count taken from the `stores` query would silently
 * read 0 outside a tenant context: each count is taken inside the store's own scope instead.
 */
async function countStoreRows(
  storeId: string,
  opts: { orders?: boolean } = {}
): Promise<{ products: number; categories: number; orders?: number }> {
  return withStore(storeId, async tx => {
    // products + categories follow the store's backend (a Postgres store keeps this very tx); orders stay on the tx
    const db = (await storeRepo(storeId)).backend === 'do' ? await storeDb(storeId) : tx;
    const [products, categories, orders] = await Promise.all([
      db.product.count({ where: { storeId } }),
      db.category.count({ where: { storeId } }),
      opts.orders ? tx.order.count({ where: { storeId } }) : Promise.resolve(undefined),
    ]);
    return opts.orders
      ? { products, categories, orders: orders as number }
      : { products, categories };
  });
}

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
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.store.count({ where }),
    ]);

    // `products` / `orders` are store-scoped under strict RLS, so a relation count taken
    // from the `stores` query would see nothing. Count each listed store inside its own scope.
    const counts = new Map(
      (
        await acrossStores(
          async storeId => ({
            products: await (await storeDb(storeId)).product.count({ where: { storeId } }),
            orders: await prisma.order.count({ where: { storeId } }),
          }),
          { storeIds: stores.map(st => st.id) }
        )
      ).map(r => [r.storeId, r.value])
    );
    const withCounts = stores.map(st => ({
      ...st,
      _count: counts.get(st.id) ?? { products: 0, orders: 0 },
    }));

    return {
      stores: withCounts,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Flip a store's lifecycle status (suspend / reactivate) AND invalidate
   * every cache layer that carries the `status` field — the service owns the
   * write and its invalidation together so no route can flip status without
   * the bust (adversarial audit P1-7 / feedback-cache-invalidate-every-write-path:
   * account status is a NEVER-stale value; the status PATCH used to
   * invalidate only the feature cache, so a suspended store kept serving the
   * cached active `public:store:resolve:<domain>` — checkouts included — for
   * up to the TTL, and reactivation was delayed the same way).
   *
   * `bustStoreCaches` clears the resolve/slug/id + categories/products keys
   * and fires the storefront revalidate purge, exactly as the domain-change
   * path does.
   */
  static async setStatus(storeId: string, status: StoreStatus) {
    const store = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: { status },
      })
    );
    await bustStoreCaches(store.id, store.slug, store.domain);
    return store;
  }

  static async getById(storeId: string, opts: { includeAcquisition?: boolean } = {}) {
    // Inside the store's own scope: the payload names the owner, whose `users` row is visible from
    // there (owner of the current store) and from nowhere else under strict RLS.
    // `includeAcquisition` (super-admin only, set by the route): how the owner found Ebda
    // (utm / fbclid / landing). Never part of a merchant's own view of their store.
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              ...(opts.includeAcquisition ? { acquisition: true } : {}),
            },
          },
        },
      })
    );

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    return { ...store, _count: await countStoreRows(store.id, { orders: true }) };
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

    // `stores` is under RLS (R-EBDA-005): slug -> id through the definer, then the row
    // is read inside that store's own scope.
    const slugStoreId = await storeIdBySlug(slug);
    const store = slugStoreId
      ? await withStore(slugStoreId, tx => tx.store.findUnique({ where: { id: slugStoreId } }))
      : null;

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }
    const storeWithCounts = { ...store, _count: await countStoreRows(store.id) };

    // Write to cache (best-effort, 120s TTL — invalidated explicitly
    // on every store update so admin edits land within seconds, not
    // minutes).
    try {
      await redis.set(`store:slug:${slug}`, JSON.stringify(storeWithCounts), 120);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[STORE] Redis cache write failed for getBySlug'
      );
    }

    return storeWithCounts;
  }

  static async create(
    ownerId: string,
    data: CreateStoreData,
    opts: { allowProtectedSlug?: boolean; platformOperator?: boolean } = {}
  ) {
    // Plan gate (locked pricing): the owner's best plan must have room for one
    // more store (1 / 1 / 3). A super-admin acting as the platform operator is
    // not plan-bound.
    if (!opts.platformOperator) await assertOwnerMayCreateStore(ownerId);
    // Signup funnel (Ruling EBDA-FUNNEL-7): a merchant-created store is never
    // public and never Basic-active for free. It starts `inactive`; the FIRST
    // store goes on the 14-day Growth trial (go-live then needs a card, see
    // go-live-gate.ts), an additional one (only reachable on a multi-store plan)
    // rides the owner's Business plan — the same shapes as self-serve onboarding.
    // The platform operator keeps the old behaviour (active, default plan).
    const merchantCreate = !opts.platformOperator
      ? {
          firstStore:
            (await withUser(ownerId, tx =>
              tx.store.count({ where: { ownerId, deletedAt: null } })
            )) === 0,
        }
      : null;

    // Same class as the product-slug defect: an empty slugify result made the
    // de-duplication loop mint '-1'/'-2' store slugs. A store is even less
    // recoverable than a product, so it gets the same guarantee.
    //
    // An EXPLICIT slug is a merchant's choice of `<slug>.ebda.app`, so it is
    // validated strictly (format + reserved list) and refused with a clear
    // code — never silently rewritten into something they did not ask for.
    // A slug DERIVED from the name is best-effort: it is padded/suffixed until
    // it is valid and unreserved ("Support" → `support-1`, not a refusal).
    let baseSlug: string;
    if (data.slug) {
      baseSlug = assertStoreSlug(data.slug, { allowProtected: opts.allowProtectedSlug });
    } else {
      baseSlug = deriveStoreSlug(slugifyWithFallback(data.name, 'store', { ascii: true }));
      // A name-derived slug that is a protected brand is refused (suffixing it
      // would only normalise back to the same brand).
      if (!opts.allowProtectedSlug && isProtectedSlug(baseSlug)) {
        throw new AppError(400, 'SLUG_PROTECTED', STORE_SLUG_ERROR_MESSAGES.SLUG_PROTECTED);
      }
    }

    // Auto-deduplicate slug
    let slug = baseSlug;
    let suffix = 0;
    while (isReservedSlug(slug) || (await storeIdBySlug(slug))) {
      suffix++;
      if (suffix > 100) throw new AppError(409, 'SLUG_COLLISION', 'Too many slug collisions');
      slug = `${baseSlug.slice(0, 40 - String(suffix).length - 1)}-${suffix}`;
    }

    // Check domain uniqueness
    if (data.domain) {
      if (await storeIdByDomain(data.domain)) {
        throw new AppError(409, 'ALREADY_EXISTS', 'Store with this domain already exists');
      }
    }

    // Plan gate (SP5): a brand-new store starts on the default plan, which
    // decides whether it may carry a custom domain at creation.
    if (data.domain) {
      await assertPlanAllows(STORE_PLAN_TO_PLAN_CODE[NEW_STORE_LEGACY_PLAN], 'customDomain');
    }

    // `stores` is under RLS (R-EBDA-005): the row is inserted AS its owner (the policy's
    // WITH CHECK and the tenant guard both key a new store on the acting owner).
    const store = await withUser(ownerId, () =>
      prisma.store.create({
        data: {
          name: data.name,
          slug,
          // Reachable only for a super_admin (the routes drop `domain` for anyone
          // else): an operator-assigned domain is trusted, so it starts `active`.
          // Merchants claim a domain through PUT /stores/:id/domain (pending).
          domain: data.domain,
          ...(data.domain ? { domainStatus: 'active', domainVerifiedAt: new Date() } : {}),
          ownerId,
          // Same fresh-store default as provisioning: no trust strip until the
          // merchant writes items (empty `items` = merchant-owned, hidden).
          layoutSettings: NEW_STORE_LAYOUT_SETTINGS,
          ...(merchantCreate
            ? {
                status: 'inactive' as const,
                plan: merchantCreate.firstStore
                  ? ('professional' as const)
                  : ('enterprise' as const),
              }
            : {}),
          settings: ((data.settings && typeof data.settings === 'object'
            ? stripServerOwnedSettings(data.settings as Record<string, unknown>)
            : null) || {
            currency: REGION.currency,
            locale: 'ar-EG',
            defaultLanguage: REGION.defaultLocale,
          }) as Prisma.InputJsonValue,
          // 2026-07-12 design structural batch: new stores get the card-frame dedup
          // ON by default (Ahmad-approved for NEW
          // stores only — every existing store keeps these flags undefined/false
          // and renders unchanged). Merchant can still toggle either off via
          // Branding → Theme.
          // 2026-07-12 design-sweep batch: new stores also get a neutral-slate
          // OOS ribbon (harmonizes better than the platform's original fixed
          // terracotta). Existing stores keep it undefined and render unchanged.
          // `rtlPolish` is no longer seeded: no renderer reads it (Ruling EP-8); nor is
          // `personaChromeV2`: only the deleted Force skins read it (Ruling SKIN-DEL-5).
          theme: {
            frameChromeDedup: true,
            oosRibbonColor: '#6b7280',
          },
        },
      })
    );

    // Every store gets a subscription row from day one (SP5): the plan the
    // enum default put it on, mapped onto a plan code. Written in the new
    // store's own scope (store_subscriptions is under strict RLS).
    //
    // Default VAT (Ebda: 14%, `REGION.defaultVatBps`) is seeded in the same
    // scope as an INACTIVE rate row (ruling TAX-2): a new store starts with VAT
    // OFF and no active rate. The merchant activates it after a super-admin
    // verifies its VAT registration; the charge is gated on that verification.
    await withStore(store.id, async tx => {
      await syncSubscriptionFromLegacyPlan(tx, store.id, store.plan);
      if (merchantCreate?.firstStore) await startSignupTrial(tx, store.id);
      await tx.taxRate.create({
        data: {
          storeId: store.id,
          name: 'VAT',
          nameAr: 'ضريبة القيمة المضافة',
          rate: REGION.defaultVatBps / 100,
          isActive: false,
        },
      });
    });

    // Seed Chart of Accounts (Egypt retail template, 27 system accounts).
    // Idempotent — safe if accountingEnabled is later toggled.
    await seedCoaForStore(store.id);

    // The owner row is identity-scoped under strict RLS (`users`), and no store scope exists
    // yet when the store is created: read it as the owner (the acting user), after the fact.
    const owner = await withUser(ownerId, tx =>
      tx.user.findUnique({
        where: { id: ownerId },
        select: { id: true, email: true, firstName: true, lastName: true },
      })
    );

    return { ...store, owner };
  }

  static async update(
    storeId: string,
    data: UpdateStoreData,
    opts: { allowProtectedSlug?: boolean } = {}
  ) {
    const store = await this.getById(storeId);
    // Snapshot the heroImage URL so a replaced banner gets the old R2
    // object cleaned up post-commit. Same posture as branding / seo /
    // category / page cover paths.
    const previousHeroImage = (store as { heroImage?: string | null }).heroImage ?? null;

    // Auto-deduplicate slug if changing
    if (data.slug && data.slug !== store.slug) {
      const baseSlug = assertStoreSlug(data.slug, { allowProtected: opts.allowProtectedSlug });
      data.slug = baseSlug;
      let suffix = 0;
      while (await storeIdBySlug(data.slug)) {
        suffix++;
        if (suffix > 100) throw new AppError(409, 'SLUG_COLLISION', 'Too many slug collisions');
        data.slug = `${baseSlug.slice(0, 40 - String(suffix).length - 1)}-${suffix}`;
      }
    }

    // Check domain uniqueness if changing
    if (data.domain && data.domain !== store.domain) {
      // Plan gate (SP5): attaching a custom domain needs the plan capability.
      await assertWithinLimit(storeId, 'customDomain');
      if (await storeIdByDomain(data.domain)) {
        throw new AppError(409, 'ALREADY_EXISTS', 'Store with this domain already exists');
      }
    }

    // Merge settings instead of replacing entirely
    let mergedSettings = data.settings;
    if (data.settings && typeof data.settings === 'object') {
      // Server-owned keys (SERVER_OWNED_SETTINGS_KEYS) can be neither added, changed nor erased here.
      mergedSettings = mergeClientSettings(
        (store.settings as Record<string, unknown>) || {},
        data.settings as Record<string, unknown>
      ) as Prisma.InputJsonValue;
    }

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: {
          name: data.name,
          slug: data.slug,
          domain: data.domain,
          ...(data.domain && data.domain !== store.domain
            ? { domainStatus: 'active', domainVerifiedAt: new Date(), pendingDomain: null }
            : {}),
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
          ...(data.timezone !== undefined && { timezone: data.timezone }),
          // These three were accepted by updateStoreSchema and dropped here. The
          // route validated them, the service typed them, and this object — the
          // only thing that actually writes — never mentioned them. So the admin
          // got "Saved", the column stayed NULL, and the value reappeared blank on
          // reload. Store locations could not be enabled by any merchant that was
          // not seeded, and the whole return-policy feature was dead: with the
          // column NULL, merchantReturnPolicyJsonLd() returns null forever and
          // hasMerchantReturnPolicy is never emitted.
          //
          // `!== undefined` rather than a truthiness check is load-bearing on all
          // three. null is a MEANINGFUL value the admin sends to clear a declared
          // policy, and 0 is a meaningful returnWindowDays ("returns not
          // accepted") — both would be dropped by a falsy guard, reintroducing the
          // same silent no-op for the two values that most need to persist.
          ...(data.locationsEnabled !== undefined && { locationsEnabled: data.locationsEnabled }),
          ...(data.returnWindowDays !== undefined && { returnWindowDays: data.returnWindowDays }),
          ...(data.returnFeesPaidBy !== undefined && { returnFeesPaidBy: data.returnFeesPaidBy }),
        },
        include: {
          owner: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      })
    );

    // Invalidate store cache (best-effort)
    try {
      await redis.delete(`store:slug:${store.slug}`);
      if (store.domain) await redis.delete(`store:domain:${store.domain}`);
      // Also invalidate updated keys if slug/domain changed
      if (data.slug && data.slug !== store.slug) await redis.delete(`store:slug:${data.slug}`);
      // A renamed slug frees its OLD address: bust the old host's resolve entry
      // (and the old by-slug key) so `<old>.ebda.app` stops resolving to this
      // store immediately instead of after the 120s TTL.
      if (data.slug && data.slug !== store.slug) {
        await invalidateCached(`public:store:resolve:${storeHost(store.slug)}`);
        await invalidateCached(`public:store:${store.slug}`);
        revalidateStorefront({ slug: store.slug });
      }
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
  static async delete(storeId: string, actorUserId?: string) {
    const store = await this.getById(storeId);
    // The owner's oldest store is the BILLING PARENT (EBDA-FUNNEL-18): deleting it while the
    // owner still has other live stores would strand the paid period and re-parent the
    // children onto a stale row. Refuse; the operator moves billing (re-orders plans) first.
    if (store.ownerId) {
      const family = sortOwnerStores(
        await withUser(store.ownerId, tx =>
          tx.store.findMany({
            where: { ownerId: store.ownerId!, deletedAt: null },
            select: { id: true, createdAt: true },
          })
        )
      );
      if (family.length > 1 && family[0].id === storeId) {
        throw new AppError(
          409,
          'STORE_IS_BILLING_PARENT',
          'This is the main (billing) store and the owner has other stores. Move billing to another store first.'
        );
      }
    }
    // The owner's identity (credential + sessions) lives in the shared identity service. If this deletion also removes the
    // owner's profile row, the identity is deactivated FIRST (ends their sessions at once) and erased only after the commit;
    // if the transaction fails the identity is re-activated (compensating rollback).
    let deactivatedOwnerId: string | null = null;
    let erasedOwnerId: string | null = null;

    try {
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
        // policies that match only the transaction's store, and this
        // transaction had none set, so DELETE matched 0 rows even though rows
        // existed. The FK violation at store.delete then fired because the
        // journal_entries rows were never actually touched.
        //
        // The transaction is scoped to THIS store with a transaction-local
        // set_config (no bypass flag exists any more). It dies on commit/rollback,
        // and this is a super-admin-only code path (the route gates on role).
        // The acting super_admin is set too: unlinking the owner's audit rows below
        // happens AFTER the store row is gone, so the definer's "user of the caller's
        // store" test cannot match; the caller's own role (ebda_is_super_admin) is
        // what authorises it.
        // `scopeTransaction` also makes this the ambient tenant transaction, so the
        // code-level tenant guard (R-EBDA-003) sees the store the GUCs name.
        return scopeTransaction(
          tx,
          { storeId, ...(actorUserId ? { userId: actorUserId } : {}) },
          async () => {
            logger.info({ storeId }, '[STORE_DELETE] start (raw sql, store-scoped)');

            // Ruling MONEYB-4: refuse while money is in flight, then copy every
            // fiscal record the deletes below would cascade away (legacy orders
            // without an issued document, Ebda's billing_events VAT ledger) into
            // the immutable 6-year archive. Issued invoices / receipts / credit
            // notes live there already (no FK to stores) and survive as they are.
            await assertNoMoneyInFlight(tx, storeId);
            await archiveFiscalRecords(tx, storeId);

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
            // A definer: nulling store_id leaves the store scope, which the policy's
            // WITH CHECK would reject.
            const auditCount = await detachStoreAuditLogs(storeId, tx);
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
            // The owner's row is outside this store's scope (users.store_id NULL): only the
            // platform operator may read and delete it ('platform-operator' hatch, checked by
            // `ebda_is_super_admin()` in this same transaction).
            if (!actorUserId) return;
            await asPlatformOperator(actorUserId, async () => {
              const owner = await tx.user.findUnique({
                where: { id: store.ownerId },
                select: { id: true, role: true, _count: { select: { stores: true } } },
              });
              if (owner && owner.role === 'store_admin' && owner._count.stores === 0) {
                await unlinkUserAuditLogs(owner.id, tx);
                // User-keyed rows: deleted through the guarded definer (the acting user is
                // the super_admin, not the owner).
                await deleteUserTokens(owner.id);
                // Only an ACTIVE owner is flipped (and restored on rollback): a suspended owner stays suspended either way.
                const managed = await isIdentityManagedUser(owner.id);
                if (managed) {
                  const acc = await getAccountState(owner.id);
                  if (acc?.status === 'active') {
                    await setAccountStatus(owner.id, 'inactive', 'store-deleted');
                    deactivatedOwnerId = owner.id;
                  }
                }
                await tx.user.delete({ where: { id: owner.id } });
                if (managed) erasedOwnerId = owner.id;
              }
            });
          }
        );
      });
    } catch (err) {
      if (deactivatedOwnerId) {
        await setAccountStatus(deactivatedOwnerId, 'active', 'store-delete-rolled-back').catch(e =>
          logger.error(
            { err: e, userId: deactivatedOwnerId },
            '[STORE_DELETE] could not re-activate owner identity'
          )
        );
      }
      throw err;
    }
    // Integrator clients (identity v1.3) are bound to the store and die with it. Post-commit (a rolled-back deletion never gets
    // here, so no client is lost with a store that still exists) and idempotent, so it is retried; a final failure is logged loudly:
    // the store is gone, so its clients' tokens reach nothing, but the rows stay until the next attempt.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deleteStoreClients(store.id);
        break;
      } catch (e) {
        if (attempt === 3)
          logger.error(
            { err: e, storeId: store.id },
            '[STORE_DELETE] integrator clients not removed (retry deleteStoreClients)'
          );
      }
    }
    if (erasedOwnerId) {
      await eraseIdentityUser(erasedOwnerId).catch(e =>
        logger.error(
          { err: e, userId: erasedOwnerId },
          '[STORE_DELETE] identity erase failed (account stays inactive)'
        )
      );
    }

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

    // The PRIVATE bucket holds this store's VAT evidence (ruling TAX-4) under
    // the same `stores/<storeId>/` prefix; reclaim it too, same alerting.
    try {
      const privateBucket = StorageService.privateBucket();
      const { deleted, failedKeys, remaining } = await StorageService.deleteByPrefixVerified(
        `stores/${storeId}/`,
        privateBucket
      );
      logger.info({ storeId, deleted, remaining }, '[STORE_DELETE] purged private R2 objects');
      if (remaining > 0) {
        void sendAlert({
          level: 'p1',
          scope: 'platform',
          source: 'store.delete.r2_private_orphaned',
          title: 'Private R2 purge incomplete after store delete',
          body: `${remaining} private object(s) (tax documents) survived the purge of stores/${storeId}/ in the private bucket. Delete the prefix manually.`,
          context: { storeId, deleted, remaining, failedKeys: failedKeys.slice(0, 20) },
        }).catch(() => undefined);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown', storeId },
        '[STORE_DELETE] private R2 prefix purge failed or not configured (DB delete stands)'
      );
    }

    return { id: storeId, name: store.name, slug: store.slug };
  }

  static async getStoreStats(storeId: string) {
    // Revenue = orders that are EITHER confirmed-and-beyond by fulfillment
    // status OR paid by payment status. Captures the case where an order
    // sits in 'pending' fulfillment but the customer's card was already
    // charged (a gateway webhook landed the payment but a fulfillment
    // worker hasn't moved the order forward yet). Without the paymentStatus
    // arm, dashboards showed Revenue=0 even when money had been collected.
    // Ahmad 2026-05-21 — Demo Shop had 23 orders, EGP 0.000 revenue.
    const [productCount, orderCount, customerCount, totalRevenue, recentOrders] = await Promise.all(
      [
        (await storeDb(storeId)).product.count({ where: { storeId, status: 'active' } }),
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

    // VERIFIED domains only (domainStatus 'active'): an unverified claim is
    // never a storefront (SP5 task 4).
    // `stores` is under RLS (R-EBDA-005): a VERIFIED-domain match through the lookup
    // definer (any status, not deleted), then the row inside that store's scope.
    const domainHit = await lookupStore({ domain }, ['active', 'inactive', 'suspended']);
    const found = domainHit
      ? await withStore(domainHit.id, tx => tx.store.findUnique({ where: { id: domainHit.id } }))
      : null;

    if (!found) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }
    const store = { ...found, _count: await countStoreRows(found.id) };

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
    // The five Force skins are deleted (Ruling SKIN-DEL-8): the strict writer refuses them, even
    // as a re-save of a store that still holds one. Readers keep mapping them (no write).
    if (isRetiredTemplate(template)) {
      throw new AppError(400, 'TEMPLATE_RETIRED', 'That template has been retired; choose a look');
    }
    const store = await this.getById(storeId);

    // Existing stores keep their current template (a re-save of it is allowed), but nobody can
    // switch INTO a bare template: Qamar and the rest are only reachable through a look (Ruling
    // B1-17). Switching is `applyLook`, gated on built looks.
    if (template !== store.template) {
      throw new AppError(
        400,
        'INVALID_TEMPLATE',
        'A store cannot switch to a bare template; choose a look instead'
      );
    }

    // A bare skin is the legacy way to style a store: picking one leaves the looks
    // system (the storefront composes skin < look < theme only while `look` is set).
    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: { template: template as StoreTemplate, ...(store.look ? { look: null } : {}) },
      })
    );

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }

  /**
   * Apply a look: set `look` + its skin as `template`, optionally reset the look-owned
   * theme keys (`design: 'reset'`; `keep` leaves every merchant override), then re-shape
   * the home page to the look's template family without losing content (see
   * `applyFamilyForLook`: published for a fresh store, a draft otherwise).
   */
  /**
   * What `applyLook` would write, without writing anything (Task 9): the proposed home document, a
   * plain change report and a revision token. The apply recomputes the same document from the current
   * draft and, given the token, refuses with 409 DRAFT_MOVED when the page moved since the preview.
   */
  static async previewLook(storeId: string, lookId: string, opts: { design: 'keep' | 'reset' }) {
    const look = getLook(lookId);
    if (!look) throw new AppError(400, 'INVALID_LOOK', 'Unknown look');
    const store = await this.getById(storeId);
    if (look.status !== 'built' && store.look !== look.id) {
      throw new AppError(400, 'LOOK_NOT_AVAILABLE', 'This look is not available yet');
    }
    const preview = await previewFamilyForLook(
      storeId,
      look.template,
      opts.design === 'reset' ? LOOK_OWNED_THEME_KEYS : [],
      look.id,
      opts.design
    );
    return {
      ...preview,
      look: look.id,
      // the skin (header, cards, buttons) is not drawn in the preview: say when it will change
      skinChange:
        normalizeLegacyTemplate(store.template) !== look.skin
          ? { from: normalizeLegacyTemplate(store.template), to: look.skin }
          : null,
    };
  }

  static async applyLook(
    storeId: string,
    lookId: string,
    opts: { design: 'keep' | 'reset'; revisionToken?: string },
    userId: string | null = null
  ) {
    const look = getLook(lookId);
    if (!look) throw new AppError(400, 'INVALID_LOOK', 'Unknown look');
    const store = await this.getById(storeId);
    // Only built looks can be switched into (re-applying the store's own current look stays allowed).
    if (look.status !== 'built' && store.look !== look.id) {
      throw new AppError(400, 'LOOK_NOT_AVAILABLE', 'This look is not available yet');
    }
    // Builder FIRST: it can refuse (409/422), and a refusal throws before any store write, so a
    // refused switch leaves the store row untouched. /stores/:id routes run under
    // storeScopeContext (no request transaction): each query below is its own transaction, so the
    // builder step and the store update are NOT atomic. If the store update fails after a publish,
    // a retry converges (the store is no longer fresh, so it takes the draft path). Ruling LOOKS-10.
    const builder = await applyFamilyForLook(
      storeId,
      look.template,
      userId,
      opts.design === 'reset' ? LOOK_OWNED_THEME_KEYS : [],
      look.id,
      opts.design,
      opts.revisionToken
    );
    // Re-read the theme in the same transaction as this write (not a stale copy from before the
    // builder step): a publish above may have merged a pending theme patch into it, and that
    // must not be overwritten.
    const updated = await updateStoreThrough(storeId, async tx => {
      const live = await tx.store.findUnique({
        where: { id: storeId },
        select: { theme: true },
      });
      const theme = { ...((live?.theme as Record<string, unknown>) || {}) };
      if (opts.design === 'reset') for (const k of LOOK_OWNED_THEME_KEYS) delete theme[k];
      return tx.store.update({
        where: { id: storeId },
        data: {
          look: look.id,
          template: look.skin as StoreTemplate,
          theme: theme as Prisma.InputJsonValue,
        },
      });
    });
    // After the request commits, so a read between the bust and the commit cannot re-cache
    // the old look (applyLook only; the other update* methods keep their inline bust).
    void deferAfterTenantCommit('store.applyLook.purge', async () => {
      await StoreService.invalidateCache(store);
      await bustStoreCaches(updated.id, updated.slug, updated.domain);
    }).catch(err => logger.error({ err, storeId }, '[STORE] applyLook cache purge failed'));
    return { store: updated, builder };
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
  //
  // A `null` value DELETES that key (the merchant resets one look override back
  // to the look's default). Audited 2026-10-14: no admin surface writes an
  // intentional null into the theme (StoreTheme has no nullable key), so null
  // is free to carry "remove" and a literal null is never persisted.
  static async updateTheme(storeId: string, theme: Record<string, unknown>) {
    const store = await this.getById(storeId);
    const existingTheme = (store.theme as Record<string, unknown>) || {};
    const mergedTheme: Record<string, unknown> = { ...existingTheme, ...theme };
    for (const [k, v] of Object.entries(theme)) if (v === null) delete mergedTheme[k];

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: { theme: mergedTheme as Prisma.InputJsonValue },
      })
    );

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
    assertMediaOriginOrUnchanged(
      { logo: branding.logo, logoAr: branding.logoAr },
      store as { logo?: string | null; logoAr?: string | null },
      appConfig.storagePublicUrl
    );

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
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
      })
    );

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

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: { socialLinks },
      })
    );

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
      /** E.164 Egyptian mobile; `null` clears it. */
      whatsapp?: string | null;
      address?: string;
      addressAr?: string;
      /** Phase D.6 — WhatsApp bot "Locations & Hours" branch */
      businessHours?: string;
      googleMapsUrl?: string;
    }
  ) {
    const store = await this.getById(storeId);

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
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
      })
    );

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

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: { announcementBar: merged as Prisma.InputJsonValue },
      })
    );

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
  /**
   * QR-1: replace `settings.qr` only. One atomic jsonb_set so a concurrent write of another
   * settings key (floating widget, announcement, ...) is never overwritten by a stale read-merge-write.
   */
  static async updateQrSettings(storeId: string, qr: Record<string, unknown>) {
    const store = await this.getById(storeId);
    await withStore(
      storeId,
      tx => tx.$executeRaw`
        UPDATE stores
        SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{qr}', ${JSON.stringify(qr)}::jsonb),
            updated_at = now()
        WHERE id = ${storeId}`
    );
    await syncStoreFields(storeId, ['settings']);
    await StoreService.invalidateCache(store);
  }

  /** BARCODE-1: replace `settings.labels` only (atomic jsonb_set, see updateQrSettings). */
  static async updateLabelSettings(storeId: string, labels: Record<string, unknown>) {
    const store = await this.getById(storeId);
    await withStore(
      storeId,
      tx => tx.$executeRaw`
        UPDATE stores
        SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{labels}', ${JSON.stringify(labels)}::jsonb),
            updated_at = now()
        WHERE id = ${storeId}`
    );
    await syncStoreFields(storeId, ['settings']);
    await StoreService.invalidateCache(store);
  }

  static async updateFloatingWidget(storeId: string, floatingWidget: Record<string, unknown>) {
    const store = await this.getById(storeId);
    const existingSettings = (store.settings as Record<string, unknown>) || {};
    const mergedSettings = { ...existingSettings, floatingWidget };

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: { settings: mergedSettings as Prisma.InputJsonValue },
      })
    );

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }

  /**
   * Merchant's own per-store switch for the merchant-MCP WRITE tools
   * (`settings.mcpWriteEnabled`, absent = on). Surgical splice into the
   * `settings` JSON like `updateFloatingWidget` above — no migration, no new
   * column. This is the merchant half of the gate; the plan/Feature-Matrix half
   * is the `merchant_mcp_write` feature (mcp/merchant-write.ts checks both).
   */
  static async setMcpWriteEnabled(storeId: string, enabled: boolean) {
    const store = await this.getById(storeId);
    const existingSettings = (store.settings as Record<string, unknown>) || {};
    const mergedSettings = { ...existingSettings, mcpWriteEnabled: enabled };

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: { settings: mergedSettings as Prisma.InputJsonValue },
      })
    );

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return enabled;
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
    assertMediaOriginOrUnchanged(
      { ogImage: seo.ogImage },
      { ogImage: previousOgImage },
      appConfig.storagePublicUrl
    );

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
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
      })
    );

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

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
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
      })
    );

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }
}
