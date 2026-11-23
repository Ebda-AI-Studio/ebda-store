import {
  prisma,
  Prisma,
  scopeTransaction,
  asPlatformOperator,
  acrossStores,
  withStore,
  withUser,
  runInTenantContext,
  withMoneyTx,
  StoreStatus,
} from '@ebda/database';
import { hubOnD1 } from '../lib/platform-hub';
import {
  copyStoreSettings,
  storeDb,
  storeRepo,
  storeUpdateOnDo,
  storePatchOnDo,
  closeDoIfNoMoney,
  reopenDoAfterFailedDelete,
  storeWritesToDo,
} from '../lib/repo-factory';
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
import {
  finishDoStoreCreate,
  insertDoStore,
  countOwnerStores,
  ownerStores,
  storeCreateOnDo,
} from '../lib/store-create-do';
import { assertMediaOriginOrUnchanged } from '../lib/media-url-guard';
import { config as appConfig } from '../config';
import { archiveFiscalRecords, assertNoMoneyInFlight } from './store-closure.service';
import { assertStoreSlug, deriveStoreSlug } from '../lib/store-slug';
import {
  GOLD_ALLOW_DEFERRED_SETTING,
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
  stripServerOwnedSettings,
  isRetiredTemplate,
  normalizeLegacyTemplate,
} from '@ebda/shared';
import { applyFamilyForLook, previewFamilyForLook } from './page-builder.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { redis } from './redis.service';
import { invalidateCached, invalidateCachedPrefix } from '../lib/public-cache';
import { demoLayoutCacheKey } from '../lib/demo-layout-cache-key';
import logger from '../lib/logger';
import {
  deleteStoreClients,
  eraseIdentityUser,
  getAccountState,
  getAccountsBrief,
  isIdentityManagedUser,
  setAccountStatus,
} from '../lib/identity-client';
import { platformFamilyOnD1 } from './platform/cutover';
import { pageDirectoryStoreIds } from './platform/directory-d1';
import { cleanupRemovedImages, deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { sendAlert } from './alerts.service';
import { StorageService } from './storage.service';
import { seedCoaForStore } from './accounting/account.service';
import { revalidateStorefront } from '../lib/revalidate-storefront';
import { bustCorsCache } from '../lib/cors-cache';
import { syncStoreDirectoryFromPg } from '../lib/store-directory-sync';
import { anonymiseDeletedStore, finishStoreDeletion } from '../lib/store-delete-post-commit';
import { purgeStoreVectors } from '../lib/search/purge-store-vectors';
import { cfBindings } from '../cf/bindings';
import { eraseStorePlatformData, type D1Like } from '../cf/erasure/platform-subject';
import { paymentsErasurePort } from './billing/payments-erasure';
import { storeDo } from '../lib/store-backend';
import { invalidateStoreDirectory } from '../lib/store-directory';
import {
  assertOwnerMayCreateStore,
  assertPlanAllows,
  assertWithinLimit,
  ownerStoreAllowance,
} from './plan-limit.service';
import { sortOwnerStores } from './billing/billing-parent';
import { NEW_STORE_LEGACY_PLAN, syncSubscriptionFromLegacyPlan } from './plan-sync';
import { startSignupTrial } from './billing/trial';
import { netRevenue } from './revenue.service';

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
 * On a slug / domain CHANGE the caller passes the OLD values in `previous`;
 * the old address's resolve key, CORS trust and storefront tags are purged
 * here too (Ruling RESOLVE-BULLETPROOF-1; it used to wait out the 120s TTL,
 * `docs/audits/2026-07-12-scaling-cliff-reel.md` finding #1).
 */
export async function bustStoreCaches(
  storeId: string,
  slug: string | null,
  domain?: string | null,
  /** The values BEFORE a slug / domain change: the old address must stop resolving to this store. */
  previous: { slug?: string | null; domain?: string | null } = {}
): Promise<void> {
  // NEON-SCALE-1 rule 1: the cached store directory (slug / domain / id -> status) is event-invalidated here, BEFORE the
  // payload caches are busted (so a refill cannot read a stale directory entry) and AGAIN at the end (a refill that raced
  // the first pass is dropped).
  await invalidateStoreDirectory(storeId, slug, domain, previous);
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
  // The demo showroom's layout response cache (a no-op key for a real store): every publish / rollback / layout PUT /
  // look apply ends here, so a published home shows at once (Ruling DEMO-LAYOUT-PURGE-1).
  await invalidateCached(demoLayoutCacheKey(storeId));
  // Purge the storefront's Next data cache too (fire-and-forget, no-op if the
  // STOREFRONT_REVALIDATE_URL / REVALIDATE_SECRET env pair isn't configured) so
  // a merchant's edit shows on the live storefront within ~a second.
  // `layout:<storeId>` is the tag on every storefront fetch of the page-builder
  // layout (`GET /public/stores/:id/layout`); without it a layout save could not
  // reach the Next data cache and stayed stale for the 60s revalidate window.
  // The OLD address must stop resolving at once too (domain ownership is NEVER-stale, Ruling RESOLVE-BULLETPROOF-1):
  // its API resolve key, its CORS trust and its storefront tags (the storefront resolve cache and edge HTML are
  // epoch-invalidated per host). Before this, a removed/changed domain was purged only by the 120s TTL.
  const oldSlug = previous.slug && previous.slug !== slug ? previous.slug : null;
  const oldDomain = previous.domain && previous.domain !== domain ? previous.domain : null;
  const previousTags: string[] = [];
  if (oldSlug) {
    await invalidateCached(`public:store:${oldSlug}`);
    await invalidateCached(`public:store:resolve:${storeHost(oldSlug)}`);
    bustCorsCache(storeHost(oldSlug));
    previousTags.push(`store-slug:${oldSlug}`, `store-domain:${storeHost(oldSlug)}`);
  }
  if (oldDomain) {
    await invalidateCached(`public:store:resolve:${oldDomain}`);
    bustCorsCache(oldDomain);
    previousTags.push(`store-domain:${oldDomain.toLowerCase().replace(/^www\./, '')}`);
  }
  revalidateStorefront({ slug, domain, tags: [`layout:${storeId}`, ...previousTags] });
  await invalidateStoreDirectory(storeId, slug, domain, previous);
}

/**
 * Settings write-through (Ruling CF-WRITES-2): runs the authoritative `Store` update (D1/Postgres) exactly as `withStore`
 * did, then copies the changed fields to the Durable Object's settings copy for a store served by its DO. On Postgres the
 * copy is a no-op. The patch is captured from the `tx.store.update({ data })` call itself, so no call site restates it.
 */
export async function updateStoreThrough<T>(
  storeId: string,
  run: (tx: Parameters<Parameters<typeof withStore>[1]>[0]) => Promise<T>
): Promise<T> {
  // Ruling NZ-D8: a store on its Durable Object is written by D1 + the DO, never Postgres. `run` sees a transaction-shaped
  // stand-in that serves ONLY `store.update` / `store.findUnique`; any other model throws 501 (that caller needs its own port).
  if (await storeWritesToDo(storeId)) {
    const unsupported = (what: string) => {
      throw new AppError(
        501,
        'STORE_TX_UNSUPPORTED',
        `${what} is not served for a Durable Object store`
      );
    };
    const doTx = new Proxy({} as object, {
      get(_t, prop) {
        if (prop !== 'store') return unsupported(`tx.${String(prop)}`);
        return {
          update: (args: { data: Record<string, unknown> }) =>
            storeUpdateOnDo(storeId, args as never),
          findUnique: async (args: any) => (await storeDb(storeId)).store.findUnique(args),
          findUniqueOrThrow: async (args: any) =>
            (await storeDb(storeId)).store.findUniqueOrThrow(args),
        };
      },
    });
    return run(doTx as never);
  }
  let patch: Record<string, unknown> | undefined;
  const result = await withStore(storeId, tx => {
    const watched = new Proxy(tx as object, {
      get(target, prop) {
        const v = (target as any)[prop];
        // `$queryRaw` / `$executeRaw` are called as `tx.$queryRaw`..., i.e. with this Proxy as `this`: bind them to the real client.
        if (prop !== 'store')
          return typeof v === 'function' && typeof prop === 'string' && prop[0] === '$'
            ? v.bind(target)
            : v;
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
  const count = async (db: {
    product: { count(a: object): Promise<number> };
    category: { count(a: object): Promise<number> };
    order: { count(a: object): Promise<number> };
  }) => {
    const [products, categories, orders] = await Promise.all([
      db.product.count({ where: { storeId } }),
      db.category.count({ where: { storeId } }),
      opts.orders ? db.order.count({ where: { storeId } }) : Promise.resolve(undefined),
    ]);
    return opts.orders
      ? { products, categories, orders: orders as number }
      : { products, categories };
  };
  // A DO store has no Postgres: every count (orders included) is read from its DO, never from the tenant tx (which is the
  // POSTGRES_REMOVED client on the Worker). A Postgres store keeps one tenant tx for all three.
  if ((await storeRepo(storeId)).backend === 'do') return count((await storeDb(storeId)) as never);
  return withStore(storeId, tx => count(tx as never));
}

/**
 * `Store.settings` writers, BE:F-2 (Ruling FP-5).
 *
 * The lost update came from merging against a copy read minutes earlier (a page mounted, another surface wrote, the page saved its
 * stale whole copy). Two paths, by where the store is written:
 *
 * - POSTGRES-authoritative store: ONE SQL statement does the merge (`settings = coalesce(settings,'{}') || patch`, or `jsonb_set`
 *   for one key), so it is atomic in the database whatever the transaction shape. This matters: the `/stores` router has NO
 *   request transaction (it runs under `storeScopeContext`), so every query is its own transaction and a `SELECT ... FOR UPDATE`
 *   followed by a separate UPDATE would release its lock between the two. Never write that pair here.
 * - D1 + Durable Object store (`storeWritesToDo`): the StoreDO `patchSettings` op merges ONLY the sent top-level keys inside the
 *   DO's own synchronous transaction (`storePatchOnDo`), so no writer ever reads, merges and writes back here and two saves of
 *   different keys both survive (BE:F-2).
 */
type BrandingInput = Parameters<typeof StoreService.updateBranding>[1];
type ContactInput = Parameters<typeof StoreService.updateContactInfo>[1];

const brandingColumns = (b: BrandingInput) => ({
  name: b.name,
  nameAr: b.nameAr,
  logo: b.logo,
  logoAr: b.logoAr,
  favicon: b.favicon,
  description: b.description,
  descriptionAr: b.descriptionAr,
});

const contactColumns = (c: ContactInput) => ({
  email: c.email,
  phone: c.phone,
  phoneAr: c.phoneAr,
  whatsapp: c.whatsapp,
  address: c.address,
  addressAr: c.addressAr,
  businessHours: c.businessHours,
  googleMapsUrl: c.googleMapsUrl,
});

/**
 * Diff the three image fields and queue cleanup for any URL that was replaced. `undefined` in the patch means "leave existing", so
 * only fire when the caller explicitly sent the field.
 */
function queueBrandingImageCleanup(storeId: string, store: unknown, branding: BrandingInput): void {
  const oldUrls: string[] = [];
  const newUrls: string[] = [];
  const s = store as { logo?: string | null; logoAr?: string | null; favicon?: string | null };
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
}

/** The social-links change a bundle carries: keys to set and keys to remove (a cleared field). */
export type SocialLinksPatch = { set: Record<string, string>; remove: string[] };
type JsonKeyPatchInput = { set?: Record<string, unknown>; remove?: string[] };

/** Apply a `SocialLinksPatch` to the stored links (the Postgres path; a DO store applies it inside the DO). */
export function applySocialLinksPatch(
  stored: unknown,
  patch: SocialLinksPatch
): Prisma.InputJsonValue {
  const merged: Record<string, unknown> = { ...((stored as Record<string, unknown> | null) ?? {}) };
  for (const k of patch.remove) delete merged[k];
  Object.assign(merged, patch.set);
  return merged as Prisma.InputJsonValue;
}

const stamp = (row?: { updatedAt?: Date }) =>
  row?.updatedAt instanceof Date ? { updatedAt: row.updatedAt } : {};

/** Atomic shallow merge of `patch` into `stores.settings` (Postgres path). Returns the resulting settings. */
async function mergeSettingsAtomic(
  storeId: string,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const rows = await withStore(
    storeId,
    tx => tx.$queryRaw<Array<{ settings: unknown; updatedAt?: Date }>>`
      UPDATE stores
      SET settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          updated_at = now()
      WHERE id = ${storeId}
      RETURNING settings, updated_at AS "updatedAt"`
  );
  const settings = (rows?.[0]?.settings as Record<string, unknown> | null) ?? {};
  // N-19: the DO copy (a Node / dev store whose DO is not yet the writer) gets the WHOLE resulting value from RETURNING, never a
  // re-read, stamped with the row's updated_at so the DO ignores a copy older than the one it holds.
  await copyStoreSettings(storeId, { settings, ...stamp(rows?.[0]) });
  return settings;
}

/** Atomic replace of ONE top-level `settings` key (Postgres path). */
async function setSettingsKeyAtomic(storeId: string, key: string, value: unknown): Promise<void> {
  const rows = await withStore(
    storeId,
    tx => tx.$queryRaw<Array<{ settings: unknown; updatedAt?: Date }>>`
      UPDATE stores
      SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), ARRAY[${key}]::text[], ${JSON.stringify(value)}::jsonb),
          updated_at = now()
      WHERE id = ${storeId}
      RETURNING settings, updated_at AS "updatedAt"`
  );
  await copyStoreSettings(storeId, { settings: rows?.[0]?.settings ?? {}, ...stamp(rows?.[0]) });
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

    // NEON-ZERO (integration gap): with the access family on D1 the directory is D1 `stores`, each store's record is read from
    // its own backend, the owner from the identity service and the counts from the store's backend. No Postgres.
    if (await platformFamilyOnD1('access')) {
      const { ids, total } = await pageDirectoryStoreIds({
        ownerId: options.ownerId,
        skip,
        take: limit,
      });
      const rows = await Promise.all(
        ids.map(async id => {
          const db = await storeDb(id);
          const [st, products, orders] = await Promise.all([
            db.store.findUnique({ where: { id } }),
            db.product.count({ where: { storeId: id } }),
            db.order.count({ where: { storeId: id } }),
          ]);
          return st ? { st, products, orders } : null;
        })
      );
      const found = rows.filter((r): r is NonNullable<typeof r> => r !== null);
      const owners = new Map(
        (await getAccountsBrief(found.map(r => (r.st as { ownerId: string }).ownerId))).map(a => [
          a.id,
          { id: a.id, email: a.email, firstName: a.firstName, lastName: a.lastName },
        ])
      );
      return {
        stores: found.map(r => ({
          ...r.st,
          owner: owners.get((r.st as { ownerId: string }).ownerId) ?? null,
          _count: { products: r.products, orders: r.orders },
        })),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

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
          { storeIds: stores.map(st => st.id), abortOnError: true }
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
    // N-18 (Ruling NZ-D11): a store created on D1 + its Durable Object has no Postgres row.
    const onDo = storeCreateOnDo();
    const merchantCreate = !opts.platformOperator
      ? {
          firstStore:
            (await countOwnerStores(ownerId, () =>
              withUser(ownerId, tx => tx.store.count({ where: { ownerId, deletedAt: null } }))
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

    const newSettings = ((data.settings && typeof data.settings === 'object'
      ? stripServerOwnedSettings(data.settings as Record<string, unknown>)
      : null) || {
      currency: REGION.currency,
      locale: 'ar-EG',
      defaultLanguage: REGION.defaultLocale,
    }) as Prisma.InputJsonValue;
    const newTheme = { frameChromeDedup: true, oosRibbonColor: '#6b7280' };

    if (onDo) {
      const plan = merchantCreate
        ? merchantCreate.firstStore
          ? ('professional' as const)
          : ('enterprise' as const)
        : NEW_STORE_LEGACY_PLAN;
      const id = await insertDoStore({
        name: data.name,
        slug,
        domain: data.domain ?? null,
        ownerId,
        status: merchantCreate ? 'inactive' : 'active',
        plan,
        settings: newSettings as Record<string, unknown>,
        theme: newTheme,
        layoutSettings: NEW_STORE_LAYOUT_SETTINGS as Record<string, unknown>,
        vatRateHundredths: REGION.defaultVatBps,
        trial: merchantCreate?.firstStore ? {} : undefined,
        // atomic plan gate, fails closed (the Redis creation lock fails open): the insert itself refuses past the allowance
        maxOwnedStores: opts.platformOperator
          ? null
          : (await ownerStoreAllowance(ownerId)).allowance,
      });
      const created = await finishDoStoreCreate(id, {
        slug,
        domain: data.domain ?? null,
      });
      // The owner row is identity (Postgres until the identity track moves it): not read on this path.
      return { ...created, owner: { id: ownerId } } as typeof created & { owner: { id: string } };
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
          settings: newSettings,
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
          theme: newTheme,
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

    // Hotfix N-22: the new store must resolve (lookups read D1). The creating write committed above, so read it back and mirror it.
    await syncStoreDirectoryFromPg(store.id);
    // A slug probed before this store existed is negatively cached in the directory: clear it so the new store resolves at once.
    await invalidateStoreDirectory(store.id, store.slug, store.domain);

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

    // Merge settings instead of replacing entirely. BE:F-2: the merge happens against the row as it is NOW (see the note above
    // readLiveSettings): ONE atomic SQL statement on a Postgres store, the StoreDO `patchSettings` op on a DO store. `incoming` holds only the
    // keys the client sent; server-owned keys (SERVER_OWNED_SETTINGS_KEYS) can be neither added, changed nor erased here.
    const incoming =
      data.settings && typeof data.settings === 'object'
        ? (data.settings as Record<string, unknown>)
        : undefined;
    const onDo = incoming ? await storeWritesToDo(storeId) : false;
    const atomicPatch = incoming && !onDo ? stripServerOwnedSettings(incoming) : undefined;

    const updatedStore = await updateStoreThrough(storeId, async tx => {
      const mergedSettings = incoming && !onDo ? undefined : data.settings; // an incoming object is written by the atomic path
      const write = (args: Parameters<typeof tx.store.update>[0]) => {
        if (!incoming || !onDo) return tx.store.update(args);
        // BE:F-2: a DO store merges ONLY the sent keys inside the DO (StoreDO `patchSettings`), never a read-merge-write here.
        const fields: Record<string, unknown> = { ...(args.data as Record<string, unknown>) };
        delete fields.settings;
        return storePatchOnDo(
          storeId,
          { fields, json: { settings: { set: stripServerOwnedSettings(incoming) } } },
          { include: { owner: true } }
        );
      };
      return write({
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
      });
    });

    if (atomicPatch && Object.keys(atomicPatch).length > 0) {
      (updatedStore as { settings: unknown }).settings = await mergeSettingsAtomic(
        storeId,
        atomicPatch
      );
    }

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

    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain, {
      slug: store.slug,
      domain: store.domain,
    });

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
    // Decided BEFORE the Postgres delete (Ruling NZ-D14): the post-commit teardown must know whether the store lived on its DO.
    const wasOnDo = await storeWritesToDo(storeId);
    // N-18 (Ruling NZ-D14): a store created on D1 + its DO has NO Postgres row, so the Postgres phase (getById, the raw SQL deletes)
    // has nothing to act on and is skipped; only the DO close, the owner-family check (D1), and finishStoreDeletion apply.
    // Once the platform families are on D1 a DO store has no Postgres row by definition (Ruling NZ-C-15 routes Store reads to the DO,
    // so the probe below would find the DO's record and wrongly take the Postgres delete path).
    const pgRow =
      wasOnDo && !(await hubOnD1())
        ? await withStore(storeId, tx =>
            tx.store.findUnique({ where: { id: storeId }, select: { id: true } })
          )
        : wasOnDo
          ? null
          : true;
    const doNative = wasOnDo && !pgRow;
    const store = doNative
      ? await (async () => {
          const r = (await (
            await storeDb(storeId)
          ).store.findUnique({
            where: { id: storeId },
            select: { id: true, name: true, slug: true, domain: true, ownerId: true },
          })) as {
            id: string;
            name: string;
            slug: string;
            domain: string | null;
            ownerId: string;
          } | null;
          if (!r) throw new AppError(404, 'NOT_FOUND', 'Store not found');
          return r;
        })()
      : await this.getById(storeId);
    // The owner's oldest store is the BILLING PARENT (EBDA-FUNNEL-18): deleting it while the
    // owner still has other live stores would strand the paid period and re-parent the
    // children onto a stale row. Refuse; the operator moves billing (re-orders plans) first.
    if (store.ownerId) {
      const family = sortOwnerStores(
        await ownerStores(store.ownerId, () =>
          withUser(store.ownerId!, tx =>
            tx.store.findMany({
              where: { ownerId: store.ownerId!, deletedAt: null },
              select: { id: true, createdAt: true },
            })
          )
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
    // Placed after every refusal that precedes the Postgres delete (the billing-parent check), so nothing can leave it closed.
    // A DO store's money lives in the DO, not in its stale Postgres copy. ONE atomic DO call checks money in flight and closes the
    // store (Ruling NZ-D17): refused -> 409 and nothing else is touched. A failed delete below reopens only what this call closed.
    const doClose = wasOnDo ? await closeDoIfNoMoney(storeId) : null;
    let deactivatedOwnerId: string | null = null;
    let erasedOwnerId: string | null = null;

    try {
      if (!doNative)
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
                logger.error(
                  { storeId, stillBlocking },
                  '[STORE_DELETE] BLOCKING rows still exist'
                );
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
      // Compensating rollback (Ruling NZ-D17): the Postgres delete failed, so the DO this call closed is reopened (only its own flag).
      if (doClose?.token) {
        await reopenDoAfterFailedDelete(storeId, doClose.token).catch(e =>
          sendAlert({
            level: 'p1',
            scope: 'platform',
            source: 'store.delete.reopen_failed',
            title: 'Store delete failed and the Durable Object could not be reopened',
            body: `store ${storeId} is CLOSED but still exists: reopen it by hand (do_flags closed + closed_by_delete). ${e instanceof Error ? e.message : ''}`,
            context: { storeId },
          }).catch(() => undefined)
        );
      }
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

    // Ruling NZ-D14: lookups read D1 and a DO store keeps its data in the DO; neither is touched by the Postgres delete above.
    await finishStoreDeletion({ storeId, wasOnDo });

    // PDPL (Ruling FOLD-ERASURE-2): a DO store's people are anonymised once the delete is committed (the DO stays, closed, for the
    // legal retention period; fiscal / VAT / payment rows are kept, everything that identifies a person goes).
    if (wasOnDo)
      await anonymiseDeletedStore(storeId, {
        eraseDo: async (id, requestId) =>
          (
            storeDo(id) as unknown as {
              eraseSubject(
                s: Record<string, unknown>
              ): Promise<{ refused?: unknown; remaining: number }>;
            }
          ).eraseSubject({
            kind: 'merchant',
            requestId,
            storeId: id,
            ownerUserId: store.ownerId ?? '',
          }),
        eraseD1: async id => {
          const d1 = (cfBindings() as { PLATFORM_DB?: D1Like } | undefined)?.PLATFORM_DB;
          if (d1) await eraseStorePlatformData(d1, id);
        },
        erasePayments: (id, requestId) => paymentsErasurePort.scrub([id], requestId),
        purgeVectors: id => purgeStoreVectors(id),
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
    // Every read from the store's own backend (`storeDb`: its DO, or Postgres for a Postgres store). The bare `prisma`
    // order/customer reads were POSTGRES_REMOVED on every DO store's dashboard (prod 2026-11-10 21:53Z, Ruling NZ-FINAL-1).
    const db = await storeDb(storeId);
    const [productCount, orderCount, customerCount, totalRevenue, recentOrdersRaw] =
      await Promise.all([
        db.product.count({ where: { storeId, status: 'active' } }),
        db.order.count({ where: { storeId } }),
        db.customer.count({ where: { storeId } }),
        // The ONE revenue definition (services/revenue.service.ts, STORE-QA-7): refunded / cancelled / failed-payment orders
        // drop out and partial refunds are netted. (Was: status confirmed..delivered OR paid, which counted a delivered +
        // refunded order as sales.)
        netRevenue(storeId),
        // No `include: { customer }`: on a DO store the order is in the StoreDO and the customer is not
        // (prisma-lite: "Order.customer lives in another database"), so the five customers are read in one query below.
        db.order.findMany({
          where: { storeId },
          take: 5,
          orderBy: { createdAt: 'desc' },
        }),
      ]);
    const customerIds = [
      ...new Set(
        (recentOrdersRaw as Array<{ customerId: string | null }>)
          .map(o => o.customerId)
          .filter((id): id is string => !!id)
      ),
    ];
    const customers = customerIds.length
      ? ((await db.customer.findMany({
          where: { storeId, id: { in: customerIds } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })) as Array<{
          id: string;
          firstName: string | null;
          lastName: string | null;
          email: string | null;
        }>)
      : [];
    const byId = new Map(customers.map(c => [c.id, c]));
    const recentOrders = (recentOrdersRaw as Array<{ customerId: string | null }>).map(o => {
      const c = o.customerId ? byId.get(o.customerId) : undefined;
      return {
        ...o,
        customer: c ? { firstName: c.firstName, lastName: c.lastName, email: c.email } : null,
      };
    });

    return {
      productCount,
      orderCount,
      customerCount,
      totalRevenue: totalRevenue.revenue,
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
    if (await storeWritesToDo(storeId)) {
      // DO store: the key patch is merged INSIDE the DO's transaction against the theme it holds now (no read-merge-write here).
      const patched = await storePatchOnDo(storeId, {
        json: {
          theme: {
            set: Object.fromEntries(Object.entries(theme).filter(([, v]) => v !== null)),
            remove: Object.entries(theme)
              .filter(([, v]) => v === null)
              .map(([k]) => k),
          },
        },
      });
      await StoreService.invalidateCache(store);
      await bustStoreCaches(patched.id, patched.slug, patched.domain);
      return patched;
    }
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
      nameAr?: string | null;
      logo?: string | null;
      logoAr?: string | null;
      favicon?: string | null;
      description?: string | null;
      descriptionAr?: string | null;
    }
  ) {
    const store = await this.getById(storeId);
    assertMediaOriginOrUnchanged(
      { logo: branding.logo ?? undefined, logoAr: branding.logoAr ?? undefined },
      store as { logo?: string | null; logoAr?: string | null },
      appConfig.storagePublicUrl
    );

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: brandingColumns(branding),
      })
    );

    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);

    queueBrandingImageCleanup(storeId, store, branding);

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

  /**
   * `PUT /:id/social`: apply a `{set, remove}` key patch. A DO store merges it inside the DO's transaction; a Postgres store reads,
   * merges (`applySocialLinksPatch`) and writes through `updateSocialLinks`.
   */
  static async patchSocialLinks(storeId: string, patch: SocialLinksPatch) {
    if (await storeWritesToDo(storeId)) {
      const store = await this.getById(storeId);
      const patched = await storePatchOnDo(storeId, {
        json: { socialLinks: { set: patch.set, remove: patch.remove } },
      });
      await StoreService.invalidateCache(store);
      await bustStoreCaches(patched.id, patched.slug, patched.domain);
      return patched;
    }
    const existing = await this.getById(storeId);
    return this.updateSocialLinks(storeId, applySocialLinksPatch(existing.socialLinks, patch));
  }

  static async updateContactInfo(
    storeId: string,
    contact: {
      email?: string | null;
      phone?: string | null;
      phoneAr?: string | null;
      /** E.164 Egyptian mobile; `null` clears it. */
      whatsapp?: string | null;
      address?: string | null;
      addressAr?: string | null;
      /** Phase D.6 — WhatsApp bot "Locations & Hours" branch */
      businessHours?: string | null;
      googleMapsUrl?: string | null;
    }
  ) {
    const store = await this.getById(storeId);

    const updatedStore = await updateStoreThrough(storeId, tx =>
      tx.store.update({
        where: { id: storeId },
        data: contactColumns(contact),
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
    // STORE-QA-60: a null (the merchant emptied link / link text) REMOVES the stored key; undefined leaves it.
    const merged: Record<string, unknown> = { ...existing, ...announcementBar };
    for (const [k, v] of Object.entries(announcementBar)) if (v === null) delete merged[k];

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
   * QR-1: replace `settings.qr` only (setSettingsKey: one atomic jsonb_set on Postgres, the StoreDO `patchSettings` op on a DO store) so a concurrent write of another
   * settings key (floating widget, announcement, ...) is never overwritten by a stale read-merge-write.
   */
  static async updateQrSettings(storeId: string, qr: Record<string, unknown>) {
    await this.setSettingsKey(storeId, 'qr', qr);
  }

  /** BARCODE-1: replace `settings.labels` only (atomic jsonb_set, see updateQrSettings). */
  static async updateLabelSettings(storeId: string, labels: Record<string, unknown>) {
    await this.setSettingsKey(storeId, 'labels', labels);
  }

  /**
   * Replace ONE top-level `settings` key (BE:F-2): one atomic `jsonb_set` statement on a Postgres store, a write-time read-merge
   * on a DO store (see readLiveSettings), then bust the caches. Used by the single-purpose setters so none of them writes back a
   * copy read earlier.
   */
  private static async setSettingsKey(storeId: string, key: string, value: unknown) {
    const store = await this.getById(storeId);
    let updatedStore;
    if (await storeWritesToDo(storeId)) {
      // BE:F-2: the DO replaces this ONE top-level key against the settings it holds now (no read-merge-write here).
      updatedStore = await storePatchOnDo(storeId, {
        json: { settings: { set: { [key]: value } } },
      });
    } else {
      await setSettingsKeyAtomic(storeId, key, value);
      updatedStore = await this.getById(storeId);
    }
    await StoreService.invalidateCache(store);
    await bustStoreCaches(updatedStore.id, updatedStore.slug, updatedStore.domain);
    return updatedStore;
  }

  /**
   * The branding page's Save as ONE unit (BE:F-3). Every part runs in ONE database transaction on a Postgres store
   * (`runInTenantContext`; each `withStore` inside reuses it), so a failure in any part rolls ALL of it back. The `/stores`
   * router has no request transaction of its own (it runs under `storeScopeContext`), so the transaction is opened here.
   *
   * D1 + Durable Object store (`storeWritesToDo`): the validated parts are folded into ONE StoreDO `patchSettings` call (branding
   * and contact columns, `blogEnabled`, and key-wise patches of `theme` / `socialLinks` / `settings`), which the DO applies in a
   * single synchronous transaction against what it holds now. A refused part therefore writes nothing, and a concurrent save of
   * other keys is never overwritten (FP-8 is superseded for DO stores).
   *
   * Caches are busted AFTER the commit so a read between the bust and the commit cannot re-cache the old values.
   */
  static async updateBrandingBundle(
    storeId: string,
    parts: {
      branding?: BrandingInput;
      theme?: Record<string, unknown>;
      contact?: ContactInput;
      /** The keys to set / remove in the stored social links. */
      social?: SocialLinksPatch;
      settings?: Prisma.InputJsonValue;
      blogEnabled?: boolean;
    }
  ) {
    const before = await this.getById(storeId);
    const onDo = await storeWritesToDo(storeId);
    if (onDo) {
      const fields: Record<string, unknown> = {};
      const json: Record<string, JsonKeyPatchInput> = {};
      if (parts.branding) {
        assertMediaOriginOrUnchanged(
          { logo: parts.branding.logo ?? undefined, logoAr: parts.branding.logoAr ?? undefined },
          before as { logo?: string | null; logoAr?: string | null },
          appConfig.storagePublicUrl
        );
        Object.assign(fields, brandingColumns(parts.branding));
      }
      if (parts.contact) Object.assign(fields, contactColumns(parts.contact));
      if (parts.blogEnabled !== undefined) fields.blogEnabled = parts.blogEnabled;
      if (parts.theme) {
        // a `null` value removes that theme key (see updateTheme)
        json.theme = {
          set: Object.fromEntries(Object.entries(parts.theme).filter(([, v]) => v !== null)),
          remove: Object.entries(parts.theme)
            .filter(([, v]) => v === null)
            .map(([k]) => k),
        };
      }
      if (parts.social) json.socialLinks = { set: parts.social.set, remove: parts.social.remove };
      if (parts.settings && typeof parts.settings === 'object' && !Array.isArray(parts.settings))
        json.settings = {
          set: stripServerOwnedSettings(parts.settings as Record<string, unknown>),
        };
      await storePatchOnDo(storeId, { fields, json });
      if (parts.branding) queueBrandingImageCleanup(storeId, before, parts.branding);
    } else {
      await runInTenantContext(storeId, async () => {
        if (parts.branding) await this.updateBranding(storeId, parts.branding);
        if (parts.theme) await this.updateTheme(storeId, parts.theme);
        if (parts.contact) await this.updateContactInfo(storeId, parts.contact);
        if (parts.social) {
          const stored = await this.getById(storeId);
          await this.updateSocialLinks(
            storeId,
            applySocialLinksPatch(stored.socialLinks, parts.social)
          );
        }
        if (parts.settings !== undefined || parts.blogEnabled !== undefined) {
          await this.update(storeId, {
            ...(parts.settings !== undefined && { settings: parts.settings }),
            ...(parts.blogEnabled !== undefined && { blogEnabled: parts.blogEnabled }),
          });
        }
      });
    }
    const after = await this.getById(storeId);
    await StoreService.invalidateCache(before);
    await bustStoreCaches(after.id, after.slug, after.domain);
    return after;
  }

  static async updateFloatingWidget(storeId: string, floatingWidget: Record<string, unknown>) {
    return this.setSettingsKey(storeId, 'floatingWidget', floatingWidget);
  }

  /**
   * Merchant's own per-store switch for the merchant-MCP WRITE tools
   * (`settings.mcpWriteEnabled`, absent = on). Surgical splice into the
   * `settings` JSON like `updateFloatingWidget` above — no migration, no new
   * column. This is the merchant half of the gate; the plan/Feature-Matrix half
   * is the `merchant_mcp_write` feature (mcp/merchant-write.ts checks both).
   */
  /**
   * The closed-month boundary (`settings.accountingLock`, ACCT-AUDIT-4): entries dated up to and including `through` (a Cairo day)
   * are final. `null` reopens. Server-owned: only `PUT /stores/:id/finance/period-lock` writes it, through the single-key setter.
   */
  static async setAccountingLock(
    storeId: string,
    lock: { through: string; untilMs: number } | null
  ) {
    await this.setSettingsKey(storeId, 'accountingLock', lock);
    return lock;
  }

  static async setMcpWriteEnabled(storeId: string, enabled: boolean) {
    await this.setSettingsKey(storeId, 'mcpWriteEnabled', enabled);
    return enabled;
  }

  /**
   * Merchant's switch for AUTOMATIC product recommendations (`settings.autoRecommendationsEnabled`, absent = on).
   * Surgical splice into the `settings` JSON like `setMcpWriteEnabled`; no migration.
   */
  static async setAutoRecommendationsEnabled(storeId: string, enabled: boolean) {
    await this.setSettingsKey(storeId, 'autoRecommendationsEnabled', enabled);
    return enabled;
  }

  /**
   * The Smart Layer assistant's per-store rollout mode (`settings.assistantMode`, absent = off). Set ONLY by a super admin (routes/assistant.routes.ts):
   * a merchant can never raise it. Surgical splice into the `settings` JSON like `setMcpWriteEnabled`; no migration.
   */
  static async setAssistantMode(storeId: string, mode: 'off' | 'answer-only' | 'suggest' | 'act') {
    await this.setSettingsKey(storeId, 'assistantMode', mode);
    return mode;
  }

  /**
   * Merchant's switch "allow COD / installments for gold" (`settings.goldAllowDeferredPayment`, absent =
   * OFF, Ruling SHARIA-GOLD-1). Surgical splice into the `settings` JSON like `setMcpWriteEnabled`; no migration.
   */
  static async setGoldAllowDeferredPayment(storeId: string, enabled: boolean) {
    await this.setSettingsKey(storeId, GOLD_ALLOW_DEFERRED_SETTING, enabled);
    return enabled;
  }

  static async updateSeo(
    storeId: string,
    seo: {
      metaTitle?: string | null;
      metaTitleAr?: string | null;
      metaDescription?: string | null;
      metaDescriptionAr?: string | null;
      metaDescriptionAeo?: string | null;
      metaDescriptionAeoAr?: string | null;
      ogImage?: string | null;
      twitterHandle?: string | null;
      googleSiteVerification?: string | null;
      emailSenderLocalPart?: string;
      hideFromSearchEngines?: boolean;
    }
  ) {
    const store = await this.getById(storeId);
    const previousOgImage = (store as { ogImage?: string | null }).ogImage ?? null;
    assertMediaOriginOrUnchanged(
      { ogImage: seo.ogImage ?? undefined },
      { ogImage: previousOgImage },
      appConfig.storagePublicUrl
    );

    const updatedStore = await updateStoreThrough(storeId, async tx => {
      // "Hide from search engines" lives in the `settings` JSON: merge the one key into the live bag so a concurrent
      // settings write to another key is not clobbered.
      let settingsPatch: { settings: Prisma.InputJsonValue } | Record<string, never> = {};
      if (seo.hideFromSearchEngines !== undefined) {
        const live = await tx.store.findUnique({
          where: { id: storeId },
          select: { settings: true },
        });
        settingsPatch = {
          settings: {
            ...((live?.settings as Record<string, unknown> | null) ?? {}),
            hideFromSearchEngines: seo.hideFromSearchEngines,
          } as Prisma.InputJsonValue,
        };
      }
      return tx.store.update({
        where: { id: storeId },
        data: {
          ...settingsPatch,
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
