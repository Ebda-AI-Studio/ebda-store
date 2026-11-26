import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  type StoreTheme,
  type StoreSocialLinks,
  type AnnouncementBar,
  type TemplateId,
  type StoreLocationPublic,
  DEFAULT_THEME,
  composeStoreTheme,
  REGION,
  BRAND,
  parseStoreHost,
  isReservedSlug,
  validateStoreSlugFormat,
  normalizeLegacyTemplate,
} from '@ebda/shared';
import { devSuffixesAllowed } from './platform-host';
import { API_URL } from './api';
import { decodeRouteParam } from './route-params';
import { StoreTemporarilyUnavailableError } from './store-unavailable';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { R2Like } from '../../store-edge-cache';
import { clearResolveMemory, resolveResilient, type ResolveDeps } from './store-resolve-cache';
import { applyDemoLook, DEMO_LOOK_HEADER } from './demo-look';

// Re-exported so server callers have one import site for the resolver and the
// failure it can raise. The declaration itself lives in a client-safe module
// because `app/error.tsx` reads the digest — see store-unavailable.ts.
export { StoreTemporarilyUnavailableError, STORE_UNAVAILABLE_DIGEST } from './store-unavailable';

/**
 * Lifecycle status of a resolved store. Mirrors the `StoreStatus` enum on
 * the API side. Customer-facing surfaces only ever see `active` or
 * `suspended`; `inactive` (archived/draft) stores are filtered out by the
 * public store endpoint and never make it to the storefront.
 */
export type ResolvedStoreStatus = 'active' | 'suspended';

/**
 * Resolved store configuration
 */
export interface ResolvedStore {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  domain?: string;
  status: ResolvedStoreStatus;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  currency: string;
  timezone: string;

  // Template & Theme
  template: TemplateId;
  /** Look id (e.g. 'qamar.atelier'); null/absent = legacy store, rendered exactly as before. */
  look?: string | null;
  /** The looks showroom (`stores.is_demo`): previews `?look=` and refuses checkout. */
  isDemo?: boolean;
  theme: StoreTheme;
  // Per-store typography overrides (font family, size, color per zone
  // + a library of Google Fonts URLs / merchant-uploaded font files).
  // Loaded from Store.typography JSON. Untyped here because the
  // shape lives in @ebda/shared/types/typography and dragging that
  // import in would force a chain of build dependencies the resolver
  // doesn't currently need.
  typography?: Record<string, unknown> | null;

  // Social & Contact
  socialLinks: StoreSocialLinks;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;

  // Announcement
  announcementBar?: AnnouncementBar;

  // SEO
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
  metaDescriptionAeo?: string;
  metaDescriptionAeoAr?: string;
  ogImage?: string;
  twitterHandle?: string;
  googleSiteVerification?: string;

  // Marketing Pixels
  marketingPixels?: Record<string, unknown>;

  // PWA — set by the admin's PWA settings page. The storefront's
  // manifest (lib/pwa/store-manifest.ts) already pulls a fully-formed manifest from the API, but
  // the values are mirrored here so app/layout.tsx can emit the matching iOS
  // meta tags (status-bar style, web-app-capable, apple-touch-icon) without
  // a second round-trip per request.
  pwaEnabled?: boolean;
  pwaSettings?: Record<string, unknown>;

  // General Settings (footer links, etc.)
  settings?: Record<string, unknown>;

  // Locations feature flag — gates the storefront Locations nav/footer/utility
  // links + the /locations route. Sourced from Store.locationsEnabled. Without
  // this mapped through, ShopChrome reads `store.locationsEnabled` as undefined
  // and filters out every merchant-placed Locations link (the link never
  // renders on any surface). Keep in lock-step with the API select.
  locationsEnabled?: boolean;

  // Tax — when taxIncludedInPrice is true the storefront should label
  // prices with "Includes VAT" so customers don't expect the tax to be
  // added on top at checkout. taxEnabled is mirrored for parity.
  taxEnabled?: boolean;
  taxIncludedInPrice?: boolean;
  /**
   * The store's active VAT rate as a percentage (e.g. 14 for 14%) — zeroed
   * unless the merchant has tax turned on AND its VAT registration is verified
   * (ruling TAX-2; `taxEnabled` here is that EFFECTIVE value) (`resolveActiveTaxRate`,
   * apps/api/src/lib/order-tax.ts — the ONE resolver order creation charges
   * against too, ruling M3-9, docs/RULINGS.md), so the checkout/cart tax
   * line never renders for a disabled store, and the charge agrees.
   * 0/undefined for a store with no active tax rate.
   */
  taxRatePercent?: number;
  /**
   * Issue 206: render the "Send me offers by SMS" opt-in (checkout + account)
   * ONLY when true. The API sets it when the store has the sms feature on, an
   * SMS provider configured and a promotional SMS event enabled; anything
   * else (including an older API that omits it) is false → nothing renders.
   */
  smsMarketingOptIn?: boolean;
  /**
   * Render the checkout box "Email me about my cart" ONLY when true: the API sets it when the
   * store's plan has abandoned-cart recovery AND the merchant turned the email channel on.
   */
  cartEmailOptIn?: boolean;
  /** Ebda Chat is linked: show the WhatsApp marketing-consent box (Ruling WA-CONSENT-1). */
  whatsappMarketingOptIn?: boolean;

  // Return policy — powers hasMerchantReturnPolicy in Product JSON-LD.
  // NULL/undefined means the merchant never declared one, and the storefront
  // then omits the block rather than publishing a guess; 0 means "returns not
  // accepted". Keep in lock-step with BOTH store-resolve selects in
  // apps/api/src/routes/public.routes.ts — missing one silently strips the
  // field for custom-domain stores only.
  returnWindowDays?: number | null;
  returnFeesPaidBy?: string | null;

  // Feature flags
  enabledFeatures?: string[];

  // CMS pages where the merchant has explicitly turned the storefront
  // toggle off (`isPublished=false` on the StorePage row). Footer link
  // resolution AND-merges this with the merchant's per-link toggles so a
  // disabled Privacy page automatically removes the "Privacy" link from
  // the bottom bar without the merchant having to flip both controls.
  // Slugs are bare ("privacy", "terms", "shipping", or any custom slug).
  disabledCmsSlugs?: string[];

  // Hero customization
  heroTitle?: string | null;
  heroTitleAr?: string | null;
  heroSubtitle?: string | null;
  heroSubtitleAr?: string | null;
  heroCtaText?: string | null;
  heroCtaTextAr?: string | null;
  heroCtaLink?: string | null;
  heroImage?: string | null;

  // GEO — merchant-editable /llms.txt content + brand-facts JSON-LD data
  llmsTxt?: string | null;
  aboutJson?: Record<string, unknown> | null;

  // Store FAQs + HowTos (active only, ordered by orderIndex)
  faqs?: Array<{
    id: string;
    question: string;
    questionAr?: string | null;
    answer: string;
    answerAr?: string | null;
  }>;
  howtos?: Array<{
    id: string;
    title: string;
    titleAr?: string | null;
    description: string;
    descriptionAr?: string | null;
    steps: Array<{ name: string; text: string; image?: string }>;
    stepsAr?: Array<{ name: string; text: string; image?: string }> | null;
  }>;

  /**
   * Published store locations, forwarded from the API only when
   * `locationsEnabled && theme.showBranchesInFooter` (B3, 2026-09-25) — the
   * storefront footer's opt-in "Branches" column. Absent otherwise, so a
   * store that hasn't opted in pays no extra query and sees no change. See
   * `templates/shared/display-helpers.ts::resolveFooterBranches`.
   */
  locations?: StoreLocationPublic[];

  /**
   * Set ONLY on the `DEFAULT_STORE` fallback returned by the lenient
   * {@link getStore}, and only when the real store could not be resolved for a
   * TRANSIENT reason (429/5xx/network) rather than because the request carried
   * no store identifier.
   *
   * It exists because those two cases are opposite facts that `id === 'demo'`
   * cannot tell apart, and `app/layout.tsx::generateMetadata` keys on that
   * sentinel to emit `title: 'Page not found — Ebda'`. Without this flag a
   * rate-limited merchant's storefront renders the "we're a little busy" body
   * inside a document whose `<title>` says the page does not exist — the exact
   * claim this work removes, relocated from the body to the head.
   */
  transientResolveFailure?: boolean;
}

/**
 * Default store used as a last-resort fallback when no real store can be
 * resolved (dev environment, edge-case paths). Production traffic on
 * `ebda.app/` is redirected to the marketing site by the
 * middleware before this fallback is ever rendered, so customers never
 * see it. The neutral copy below is intentional — if it does slip through
 * somewhere, "Ebda" is harmless; "Ebda Demo Store" looked broken.
 */
const DEFAULT_STORE: ResolvedStore = {
  id: 'demo',
  name: BRAND.product.nameEn,
  nameAr: BRAND.product.nameAr,
  slug: 'demo',
  status: 'active',
  currency: REGION.currency,
  timezone: 'Africa/Cairo',
  template: 'qamar',
  theme: DEFAULT_THEME,
  socialLinks: {},
  heroTitle: null,
  heroTitleAr: null,
  heroSubtitle: null,
  heroSubtitleAr: null,
  heroCtaText: null,
  heroCtaTextAr: null,
  heroCtaLink: null,
  heroImage: null,
};

// Resolution caching + stale-if-error live in store-resolve-cache.ts (Ruling RESOLVE-BULLETPROOF-1): per-isolate
// memory of hits AND definitive misses, a durable R2 last-known-good shared by every isolate, both checked against the
// per-store purge epochs before every serve (store status / domain ownership / plan are NEVER-stale).

/** Normalised host: the key the purge epochs use (`host/<label>`, store-edge-cache.ts epochKeysForTag). */
function hostKey(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '');
}

/** The Worker bindings when running on Cloudflare; null under next dev/start and in tests (memory-only, short TTLs). */
function resolveDeps(): ResolveDeps {
  let r2: R2Like | null = null;
  let waitUntil: (p: Promise<unknown>) => void = p => {
    void p;
  };
  try {
    const ctx = getCloudflareContext();
    const bucket = (ctx.env as { NEXT_INC_CACHE_R2_BUCKET?: R2Like }).NEXT_INC_CACHE_R2_BUCKET;
    if (bucket) r2 = bucket;
    const c = ctx.ctx as { waitUntil?(p: Promise<unknown>): void } | undefined;
    if (c?.waitUntil) waitUntil = p => c.waitUntil!(p);
  } catch {
    // not on Cloudflare
  }
  return {
    r2,
    now: Date.now,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    random: Math.random,
    waitUntil,
  };
}

/**
 * Get the store domain from request headers
 */
export async function getStoreDomain(): Promise<string | null> {
  const headersList = await headers();
  return headersList.get('x-store-domain');
}

/**
 * The visual-builder canvas token for THIS request, or null.
 *
 * Set by middleware ONLY from `?_builder=` inside the `?_preview` iframe (any
 * client-sent value is stripped first), so it is never present on a public
 * visit. It is just a CLAIM: the API verifies it server-side (Redis entry bound
 * to the store the host resolves to) before returning a not-yet-active store.
 */
export async function getBuilderPreviewToken(): Promise<string | null> {
  const headersList = await headers();
  const token = headersList.get('x-builder-preview-token');
  return token && /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
}

/**
 * The demo-showroom look preview for THIS request: the base store, or (only for `isDemo` stores
 * and only for a built look) the same store wearing the `?look=` look. Middleware sets
 * `x-demo-look` from a validated `?look=` only (any client-sent value is stripped first); this
 * applies it AFTER the cached fetch, per request, so the cached base store is never mutated.
 */
async function withDemoLookPreview(store: ResolvedStore): Promise<ResolvedStore> {
  if (!store.isDemo) return store;
  const raw = (await headers()).get(DEMO_LOOK_HEADER);
  return raw ? applyDemoLook(store, raw) : store;
}

/**
 * Check if running on platform domain
 */
export async function isPlatformDomain(): Promise<boolean> {
  const headersList = await headers();
  return headersList.get('x-is-platform') === 'true';
}

/**
 * An identifier interpolated into a log line, defanged.
 *
 * `domain` comes from the Host header and `slug` from the URL path — both are
 * visitor-controlled. A control character in either would let a visitor forge
 * extra log lines (code-quality rule 2, log injection) and an unbounded value
 * would let them flood the drain, so strip C0/C1 and cap the length.
 */
function logSafe(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '?').slice(0, 128);
}

/**
 * Why a 2xx response carried no store.
 *
 * `success: false` (the API refused the request) and `success: true` with no
 * store object (the API answered about a store that does not exist, or the
 * response shape drifted) are different operational facts with different
 * fixes, so the log says which one happened rather than just "no store".
 */
function noStoreReason(data: { success?: unknown }): string {
  return data?.success ? 'response carried no store object' : 'API reported success:false';
}

/**
 * Validate the `locations` sibling the API attaches to the store-resolve
 * payload (only present when `locationsEnabled && theme.showBranchesInFooter`
 * — see `public.routes.ts`). Malformed/absent input returns `undefined`
 * rather than an empty array so `resolveFooterBranches` can distinguish
 * "not sent" from "sent, empty" — both render nothing, but only the former
 * is the expected shape for a store that hasn't opted in.
 */
function parsePublicLocations(raw: unknown): StoreLocationPublic[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(
    (l): l is StoreLocationPublic =>
      !!l &&
      typeof l === 'object' &&
      typeof (l as { id?: unknown }).id === 'string' &&
      typeof (l as { name?: unknown }).name === 'string' &&
      typeof (l as { address?: unknown }).address === 'string'
  );
}

/**
 * The raw `{ success, data: { store, enabledFeatures, disabledCmsSlugs, locations } }` body of a store lookup, as the
 * resolve caches keep it (Ruling RESOLVE-BULLETPROOF-1): the RAW API body, not the parsed store, so a copy written by an
 * older storefront build is always parsed by the CURRENT code (the durable copy outlives deploys).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreBody = { success?: unknown; data: { store: any; [k: string]: any } };

/** Parse a store lookup body into the storefront's ResolvedStore (shared by the domain and slug lookups). */
function storeFromBody(data: StoreBody): ResolvedStore {
  const storeData = data.data.store;
  const enabledFeatures: string[] | undefined = Array.isArray(data.data.enabledFeatures)
    ? data.data.enabledFeatures
    : undefined;
  const disabledCmsSlugs: string[] | undefined = Array.isArray(data.data.disabledCmsSlugs)
    ? data.data.disabledCmsSlugs.filter((s: unknown): s is string => typeof s === 'string')
    : undefined;

  // Merge theme with template defaults
  const customTheme = typeof storeData.theme === 'object' ? storeData.theme : {};

  return {
    id: storeData.id,
    name: storeData.name,
    nameAr: storeData.nameAr,
    slug: storeData.slug,
    domain: storeData.domain,
    status: storeData.status === 'suspended' ? 'suspended' : 'active',
    logo: storeData.logo,
    logoAr: storeData.logoAr,
    favicon: storeData.favicon,
    description: storeData.description,
    descriptionAr: storeData.descriptionAr,
    currency: storeData.currency || REGION.currency,
    timezone: storeData.timezone || 'Africa/Cairo',
    template: normalizeLegacyTemplate(storeData.template),
    look: storeData.look ?? null,
    isDemo: storeData.isDemo === true,
    theme: composeStoreTheme({
      template: normalizeLegacyTemplate(storeData.template),
      look: storeData.look,
      theme: customTheme,
    }),
    socialLinks: typeof storeData.socialLinks === 'object' ? storeData.socialLinks : {},
    email: storeData.email,
    phone: storeData.phone,
    phoneAr: storeData.phoneAr,
    whatsapp: storeData.whatsapp,
    address: storeData.address,
    addressAr: storeData.addressAr,
    announcementBar:
      typeof storeData.announcementBar === 'object' ? storeData.announcementBar : undefined,
    metaTitle: storeData.metaTitle,
    metaTitleAr: storeData.metaTitleAr,
    metaDescription: storeData.metaDescription,
    metaDescriptionAr: storeData.metaDescriptionAr,
    metaDescriptionAeo: storeData.metaDescriptionAeo,
    metaDescriptionAeoAr: storeData.metaDescriptionAeoAr,
    ogImage: storeData.ogImage,
    twitterHandle: storeData.twitterHandle,
    googleSiteVerification: storeData.googleSiteVerification,
    marketingPixels:
      typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
    pwaEnabled: typeof storeData.pwaEnabled === 'boolean' ? storeData.pwaEnabled : undefined,
    pwaSettings:
      storeData.pwaSettings &&
      typeof storeData.pwaSettings === 'object' &&
      !Array.isArray(storeData.pwaSettings)
        ? (storeData.pwaSettings as Record<string, unknown>)
        : undefined,
    settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
    locationsEnabled:
      typeof storeData.locationsEnabled === 'boolean' ? storeData.locationsEnabled : undefined,
    returnWindowDays:
      typeof storeData.returnWindowDays === 'number' ? storeData.returnWindowDays : undefined,
    returnFeesPaidBy:
      typeof storeData.returnFeesPaidBy === 'string' ? storeData.returnFeesPaidBy : undefined,
    taxEnabled: typeof storeData.taxEnabled === 'boolean' ? storeData.taxEnabled : undefined,
    taxIncludedInPrice:
      typeof storeData.taxIncludedInPrice === 'boolean' ? storeData.taxIncludedInPrice : undefined,
    taxRatePercent:
      typeof storeData.taxRatePercent === 'number' ? storeData.taxRatePercent : undefined,
    smsMarketingOptIn: storeData.smsMarketingOptIn === true,
    cartEmailOptIn: storeData.cartEmailOptIn === true,
    whatsappMarketingOptIn: storeData.whatsappMarketingOptIn === true,
    enabledFeatures,
    disabledCmsSlugs,
    heroTitle: storeData.heroTitle ?? null,
    heroTitleAr: storeData.heroTitleAr ?? null,
    heroSubtitle: storeData.heroSubtitle ?? null,
    heroSubtitleAr: storeData.heroSubtitleAr ?? null,
    heroCtaText: storeData.heroCtaText ?? null,
    heroCtaTextAr: storeData.heroCtaTextAr ?? null,
    heroCtaLink: storeData.heroCtaLink ?? null,
    heroImage: storeData.heroImage ?? null,
    // Per-store typography overrides — passed through verbatim;
    // layout.tsx sanitises every value before injecting CSS.
    typography:
      storeData.typography && typeof storeData.typography === 'object'
        ? (storeData.typography as Record<string, unknown>)
        : null,
    faqs: Array.isArray(storeData.faqs) ? storeData.faqs : undefined,
    howtos: Array.isArray(storeData.howtos) ? storeData.howtos : undefined,
    llmsTxt: typeof storeData.llmsTxt === 'string' ? storeData.llmsTxt : null,
    aboutJson:
      storeData.aboutJson &&
      typeof storeData.aboutJson === 'object' &&
      !Array.isArray(storeData.aboutJson)
        ? (storeData.aboutJson as Record<string, unknown>)
        : null,
    // Sibling of `store`, not a store field — only present when the API
    // decided to include it (locationsEnabled && showBranchesInFooter).
    locations: parsePublicLocations(data.data.locations),
  };
}

/**
 * Fetch store from API by domain
 */
async function fetchStoreByDomain(
  domain: string,
  builderToken?: string
): Promise<StoreBody | null> {
  try {
    const response = await fetch(`${API_URL}/public/store/resolve`, {
      // Builder canvas (token present): never cached by Next's data cache, so a
      // not-yet-active store can never be replayed to a public request.
      // Otherwise tagged so the API can purge THIS store's cached resolve on
      // save (POST /api/revalidate → revalidateTag). `revalidate` stays as a
      // slow fallback for stores that never get an explicit purge.
      // Never the Next data cache: store-resolve-cache.ts is the one owner of resolve caching (epoch-checked memory +
      // durable copy, stale-if-error), so a second cache underneath cannot hand a refetch an older answer after a purge
      // (the prod tag cache is regional). Ruling RESOLVE-BULLETPROOF-1. The builder canvas path was already uncached.
      cache: 'no-store' as const,
      headers: {
        'Content-Type': 'application/json',
        'x-store-domain': domain,
        ...(builderToken ? { 'x-builder-preview-token': builderToken } : {}),
      },
    });

    // A 404 is the API's definitive answer that no store owns this domain
    // (`/store/resolve` → `{success:false, error:{code:'STORE_NOT_FOUND'}}`).
    // That, and only that, is a real miss the caller may turn into a 404.
    if (response.status === 404) {
      console.error(`Failed to fetch store for domain ${logSafe(domain)}: ${response.status}`);
      return null;
    }

    // Anything else non-OK — 429 from `storeResolveLimiter` (30/min per IP),
    // a 5xx, a gateway error — means we could not ASK, not that the answer is
    // no. Returning null here is what told a shopper their shop does not
    // exist, and told Google to drop the URL, every time the API was busy.
    if (!response.ok) {
      console.error(`Failed to fetch store for domain ${logSafe(domain)}: ${response.status}`);
      throw new StoreTemporarilyUnavailableError(
        `domain ${logSafe(domain)} → HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (!data.success || !data.data?.store) {
      console.error(
        `Failed to resolve store for domain ${logSafe(domain)}: ${noStoreReason(data)}`
      );
      return null;
    }

    return data as StoreBody;
  } catch (error) {
    // Already classified above — rethrow rather than re-wrap or downgrade.
    if (error instanceof StoreTemporarilyUnavailableError) throw error;
    // A dropped connection, a timeout, or a body that would not parse. None of
    // these are evidence about whether the store exists.
    console.error(`Error fetching store for domain ${logSafe(domain)}:`, error);
    throw new StoreTemporarilyUnavailableError(
      `domain ${logSafe(domain)} → ${error instanceof Error ? error.name : 'unknown error'}`
    );
  }
}

/**
 * Resolve store from cache or API
 */
export async function resolveStoreByDomain(
  domain: string,
  builderToken?: string | null
): Promise<ResolvedStore | null> {
  // Builder canvas: bypass the per-instance map in BOTH directions — a preview
  // result must never be written under the key public requests read, and a
  // cached public miss/hit must not stand in for the token-checked answer.
  if (builderToken) {
    const preview = await fetchStoreByDomain(domain, builderToken);
    return preview ? storeFromBody(preview) : null;
  }

  const key = hostKey(domain);
  const body = await resolveResilient(key, key, () => fetchStoreByDomain(domain), resolveDeps());
  return body ? storeFromBody(body) : null;
}

/**
 * Fetch store from API by slug
 */
async function fetchStoreBySlug(slug: string): Promise<StoreBody | null> {
  try {
    const response = await fetch(`${API_URL}/public/stores/${slug}`, {
      cache: 'no-store' as const, // see fetchStoreByDomain (Ruling RESOLVE-BULLETPROOF-1)
      headers: { 'Content-Type': 'application/json' },
    });

    // Definitive miss: `/stores/:slugOrId` answers an unknown slug with
    // `AppError(404,'NOT_FOUND')`. See fetchStoreByDomain for the full rationale.
    if (response.status === 404) {
      console.error(`Failed to fetch store for slug ${logSafe(slug)}: ${response.status}`);
      return null;
    }

    if (!response.ok) {
      console.error(`Failed to fetch store for slug ${logSafe(slug)}: ${response.status}`);
      throw new StoreTemporarilyUnavailableError(`slug ${logSafe(slug)} → HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.success || !data.data?.store) {
      console.error(`Failed to resolve store for slug ${logSafe(slug)}: ${noStoreReason(data)}`);
      return null;
    }

    return data as StoreBody;
  } catch (error) {
    if (error instanceof StoreTemporarilyUnavailableError) throw error;
    console.error(`Error fetching store for slug ${logSafe(slug)}:`, error);
    throw new StoreTemporarilyUnavailableError(
      `slug ${logSafe(slug)} → ${error instanceof Error ? error.name : 'unknown error'}`
    );
  }
}

/**
 * Resolve store by slug from cache or API.
 *
 * Exported so the OG-card route (`/og?slug=…`) can resolve a SPECIFIC store
 * independent of request headers. The old file-convention `/opengraph-image`
 * route could only ever see the platform-default store for path-based
 * storefronts (`<slug>.ebda.app`) — WhatsApp fetches the image URL
 * with no `/<slug>` path context, so every path-based store's social preview
 * fell back to the Force default card. A slug-parameterised route fixes that.
 */
export async function resolveStoreBySlug(slug: string): Promise<ResolvedStore | null> {
  // A reserved or malformed slug is never a store: answer null without an API call.
  if (isReservedSlug(slug) || !validateStoreSlugFormat(slug).ok) return null;
  // Epoch host = `<slug>.ebda.app`, what a `store-slug:<slug>` purge bumps (store-edge-cache.ts epochKeysForTag).
  const body = await resolveResilient(
    `slug:${slug}`,
    `${slug}.ebda.app`,
    () => fetchStoreBySlug(slug),
    resolveDeps()
  );
  return body ? storeFromBody(body) : null;
}

/**
 * Get the current store based on request context — LENIENT: for the layout
 * chrome only (the 404 and retry pages render inside the layout and need
 * SOMETHING to paint). Page bodies must use {@link getStoreOrNotFound}.
 *
 * The store is identified by the request HOST alone (`x-store-domain`, set by
 * middleware for `<slug>.ebda.app` and custom domains):
 *
 *  - resolves → that store;
 *  - host named but unknown → the neutral `DEFAULT_STORE` CHROME sentinel
 *    (id `demo`), flagged transient if the API could not be asked. It is never
 *    another merchant's data, and the page body still 404s;
 *  - no host identifier (a platform host) → the same sentinel.
 *
 * There is no path-slug or cookie identifier any more.
 */
export async function getStore(opts: { demoPreview?: boolean } = {}): Promise<ResolvedStore> {
  const domain = await getStoreDomain();
  if (domain) {
    const builderToken = await getBuilderPreviewToken();
    const { store, transient } = await lenientResolve(() =>
      resolveStoreByDomain(domain, builderToken)
    );
    if (store) return opts.demoPreview === false ? store : withDemoLookPreview(store);
    return transient ? TRANSIENTLY_UNRESOLVED_STORE : DEFAULT_STORE;
  }

  // No identifier in the request at all — a platform host, the genuine
  // platform sentinel.
  return DEFAULT_STORE;
}

/**
 * The fallback for "a store WAS named but we could not reach the API".
 *
 * Identical chrome to `DEFAULT_STORE` — we do not know the merchant's brand
 * during a transient, and inventing one would be worse — but flagged so
 * `layout.tsx::generateMetadata` does not title the retry page
 * "Page not found — Ebda".
 */
const TRANSIENTLY_UNRESOLVED_STORE: ResolvedStore = {
  ...DEFAULT_STORE,
  transientResolveFailure: true,
};

/**
 * Collapse a transient resolve failure for the LENIENT callers — but SAY which
 * of the two `null`s it was.
 *
 * `getStore()` renders the chrome that both the 404 page and the retry page
 * live inside (`app/layout.tsx` + its `generateMetadata`, `app/not-found.tsx`,
 * the manifest (`lib/pwa/store-manifest.ts`), the favicon and OG routes). If a 429 threw out of there,
 * the shopper would lose the branded layout entirely and fall through to
 * `global-error.tsx` — a worse outcome than the demo chrome, and it would take
 * the 404 page down with it.
 *
 * `transient` distinguishes "this store does not exist" from "I could not ask",
 * which the caller needs because the two produce opposite page titles.
 *
 * Only `StoreTemporarilyUnavailableError` is swallowed; a genuine bug still
 * propagates.
 */
async function lenientResolve(
  resolve: () => Promise<ResolvedStore | null>
): Promise<{ store: ResolvedStore | null; transient: boolean }> {
  try {
    return { store: await resolve(), transient: false };
  } catch (error) {
    if (error instanceof StoreTemporarilyUnavailableError) {
      return { store: null, transient: true };
    }
    throw error;
  }
}

/**
 * Server-component variant of {@link getStore} that triggers Next's
 * `notFound()` when a store identifier was provided in the request but
 * doesn't match any active store (a `<slug>.ebda.app` nobody owns, or a custom
 * domain that is not registered).
 *
 * Pages that depend on a real store (homepage, /products, /categories,
 * etc.) should use this so unknown slugs land on the branded
 * `not-found.tsx` instead of silently rendering the empty `Force` demo
 * storefront — the latter looked broken to customers and made
 * "is this typo a real shop?" investigations harder for support.
 *
 * The layout itself still uses the lenient `getStore()` because the
 * not-found page renders inside that layout and needs the
 * `DEFAULT_STORE` chrome (Force-branded header/footer) to render
 * without crashing.
 *
 * Only a DEFINITIVE miss 404s. A transient resolve failure (429/5xx/network)
 * raises `StoreTemporarilyUnavailableError` from the fetch layer and is
 * deliberately NOT caught here: it propagates to `app/error.tsx`, which shows
 * retry copy instead of telling the shopper the shop does not exist. See
 * `docs/plans/done/2026-09-16-store-resolve-transient-not-404.md`.
 */
export async function getStoreOrNotFound(): Promise<ResolvedStore> {
  const domain = await getStoreDomain();
  if (domain) {
    const store = await resolveStoreByDomain(domain, await getBuilderPreviewToken());
    if (!store) notFound();
    return withDemoLookPreview(store);
  }

  // No store identifier: a platform host (the apex, a preview host). A platform
  // host NEVER renders a store — not the demo, not the first one — so any
  // store-dependent page is a 404. (`/` redirects to the marketing site before
  // it gets here; see app/page.tsx.)
  notFound();
}

/**
 * Params-based sibling of {@link getStoreOrNotFound} for the tenant-cacheable
 * Track-A route tree (`app/tenant-store/[tenant]/[locale]/`, dark-launched behind
 * `STOREFRONT_TENANT_ROUTING` — see
 * `docs/plans/done/2026-07-12-tenant-cacheable-routing.md` §3.6/§9 Phase 1).
 *
 * Track-A pages must resolve the store from the matched `[tenant]` ROUTE
 * PARAM (baked into the pathname by `middleware.ts`) instead of
 * `headers()`/`cookies()` — Next's Full Route Cache keys on the resolved
 * pathname only, so a header-based resolver would either force the route
 * dynamic (no caching benefit) or, worse, let one merchant's cached HTML
 * leak onto another merchant's domain if the layout chain ever stopped
 * reading the header at all. Reading `params` instead is Dynamic-API-free
 * and safe to cache.
 *
 * This function is purely ADDITIVE — it does not modify or replace
 * `getStore()` / `getStoreOrNotFound()`, which stay exactly as-is for every
 * existing flat/header-based route (Track B, and the legacy tree while the
 * rewrite is flag-off).
 *
 * `tenant` is the middleware-encoded tenant key — the request HOST:
 *  - `<slug>.ebda.app` (e.g. `"amelia.ebda.app"`), OR
 *  - a normalized custom domain (e.g. `"demo-shop.example"`).
 *
 * Triggers Next's `notFound()` when the tenant doesn't resolve to an active
 * store — mirrors `getStoreOrNotFound()`'s behavior for unknown
 * domains/slugs so an unknown tenant lands on the branded 404 instead of
 * silently rendering the demo store. It mirrors the transient behaviour too:
 * a 429/5xx/network failure raises `StoreTemporarilyUnavailableError` rather
 * than 404ing a store that exists.
 */
/**
 * True only for a store that actually resolved: not the demo sentinel and not
 * the transient-failure fallback (which spreads DEFAULT_STORE, id 'demo').
 * Metadata that names a URL (a canonical) must be gated on this (#1855):
 * `storeAbsoluteUrl` of the sentinel is `https://ebda.app/demo`, so
 * an API blip told Google a merchant's page duplicated the demo store.
 */
export function isResolvedStore(store: ResolvedStore): boolean {
  return !store.transientResolveFailure && store.id !== 'demo';
}

export async function getStoreByTenantParam(rawTenant: string): Promise<ResolvedStore> {
  // Decoded HERE, once, for every tenant-store route: middleware percent-
  // encodes the rewrite path, and Next hands the page component the RAW segment
  // even though `generateMetadata` gets it decoded — see lib/route-params.ts.
  const tenant = decodeRouteParam(rawTenant);

  // The tenant key is the request HOST. Re-classify it so a hand-built
  // `/tenant-store/<anything>` can only ever resolve a real store host — a
  // reserved label, platform host, IP or malformed value is a 404 here too.
  const parsed = parseStoreHost(tenant, { allowDevSuffixes: devSuffixesAllowed() });
  if (parsed.kind !== 'subdomain' && parsed.kind !== 'custom') notFound();

  const store = await resolveStoreByDomain(tenant);
  if (!store) notFound();
  return store;
}

/**
 * Get store by ID (for admin panel)
 *
 * NOTE — this one deliberately keeps the old "null on any failure" contract,
 * unlike its `domain`/`slug` siblings above (Ruling SR-1 in
 * `docs/plans/done/2026-09-16-store-resolve-transient-not-404.md`): it has no
 * production callers today and sits on no shopper's 404 path. If you wire it
 * to a customer-facing surface, give it the same 404-vs-transient split first,
 * or that surface inherits the bug this plan fixed.
 */
export async function getStoreById(storeId: string): Promise<ResolvedStore | null> {
  try {
    const response = await fetch(`${API_URL}/stores/${storeId}`, {
      next: { revalidate: 60 },
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch store for id ${logSafe(storeId)}: ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (!data.success || !data.data?.store) {
      console.error(`Failed to resolve store for id ${logSafe(storeId)}: ${noStoreReason(data)}`);
      return null;
    }

    const storeData = data.data.store;
    const customTheme = typeof storeData.theme === 'object' ? storeData.theme : {};

    return {
      id: storeData.id,
      name: storeData.name,
      nameAr: storeData.nameAr,
      slug: storeData.slug,
      domain: storeData.domain,
      status: storeData.status === 'suspended' ? 'suspended' : 'active',
      logo: storeData.logo,
      logoAr: storeData.logoAr,
      favicon: storeData.favicon,
      description: storeData.description,
      descriptionAr: storeData.descriptionAr,
      currency: storeData.currency || REGION.currency,
      timezone: storeData.timezone || 'Africa/Cairo',
      template: normalizeLegacyTemplate(storeData.template),
      look: storeData.look ?? null,
      isDemo: storeData.isDemo === true,
      theme: composeStoreTheme({
        template: normalizeLegacyTemplate(storeData.template),
        look: storeData.look,
        theme: customTheme,
      }),
      socialLinks: typeof storeData.socialLinks === 'object' ? storeData.socialLinks : {},
      email: storeData.email,
      phone: storeData.phone,
      phoneAr: storeData.phoneAr,
      whatsapp: storeData.whatsapp,
      address: storeData.address,
      addressAr: storeData.addressAr,
      announcementBar:
        typeof storeData.announcementBar === 'object' ? storeData.announcementBar : undefined,
      metaTitle: storeData.metaTitle,
      metaTitleAr: storeData.metaTitleAr,
      metaDescription: storeData.metaDescription,
      metaDescriptionAr: storeData.metaDescriptionAr,
      metaDescriptionAeo: storeData.metaDescriptionAeo,
      metaDescriptionAeoAr: storeData.metaDescriptionAeoAr,
      ogImage: storeData.ogImage,
      twitterHandle: storeData.twitterHandle,
      googleSiteVerification: storeData.googleSiteVerification,
      marketingPixels:
        typeof storeData.marketingPixels === 'object' ? storeData.marketingPixels : undefined,
      pwaEnabled: typeof storeData.pwaEnabled === 'boolean' ? storeData.pwaEnabled : undefined,
      pwaSettings:
        storeData.pwaSettings &&
        typeof storeData.pwaSettings === 'object' &&
        !Array.isArray(storeData.pwaSettings)
          ? (storeData.pwaSettings as Record<string, unknown>)
          : undefined,
      settings: typeof storeData.settings === 'object' ? storeData.settings : undefined,
      locationsEnabled:
        typeof storeData.locationsEnabled === 'boolean' ? storeData.locationsEnabled : undefined,
      returnWindowDays:
        typeof storeData.returnWindowDays === 'number' ? storeData.returnWindowDays : undefined,
      returnFeesPaidBy:
        typeof storeData.returnFeesPaidBy === 'string' ? storeData.returnFeesPaidBy : undefined,
      taxEnabled: typeof storeData.taxEnabled === 'boolean' ? storeData.taxEnabled : undefined,
      taxIncludedInPrice:
        typeof storeData.taxIncludedInPrice === 'boolean'
          ? storeData.taxIncludedInPrice
          : undefined,
      taxRatePercent:
        typeof storeData.taxRatePercent === 'number' ? storeData.taxRatePercent : undefined,
      smsMarketingOptIn: storeData.smsMarketingOptIn === true,
      cartEmailOptIn: storeData.cartEmailOptIn === true,
      whatsappMarketingOptIn: storeData.whatsappMarketingOptIn === true,
      heroTitle: storeData.heroTitle ?? null,
      heroTitleAr: storeData.heroTitleAr ?? null,
      heroSubtitle: storeData.heroSubtitle ?? null,
      heroSubtitleAr: storeData.heroSubtitleAr ?? null,
      heroCtaText: storeData.heroCtaText ?? null,
      heroCtaTextAr: storeData.heroCtaTextAr ?? null,
      heroCtaLink: storeData.heroCtaLink ?? null,
      heroImage: storeData.heroImage ?? null,
      // Per-store typography overrides — passed through verbatim;
      // layout.tsx sanitises every value before injecting CSS.
      typography:
        storeData.typography && typeof storeData.typography === 'object'
          ? (storeData.typography as Record<string, unknown>)
          : null,
    };
  } catch (error) {
    console.error(`Error fetching store ${logSafe(storeId)}:`, error);
    return null;
  }
}

/**
 * Clear store cache (useful for updates)
 */
export function clearStoreCache(domain?: string): void {
  clearResolveMemory(domain ? hostKey(domain) : undefined);
}
