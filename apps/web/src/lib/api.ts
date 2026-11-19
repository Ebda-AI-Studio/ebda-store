/**
 * Storefront (Web) App API Client
 *
 * Pattern: Class-based ApiClient instance that manages session IDs
 * and store context headers automatically.
 *
 * Base URL includes the /api/v1 prefix and comes from NEXT_PUBLIC_API_URL.
 * Auth is handled via HTTP-only cookies (set by the API on login).
 * All requests use credentials: 'include' to send cookies automatically.
 * A persistent session ID (X-Session-ID) is generated per browser for
 * anonymous cart tracking. An optional X-Store-ID header supports
 * multi-store routing.
 *
 * Usage:
 *   import { api } from '@/lib/api';
 *   const result = await api.getProducts({ page: '1', limit: '12' });
 *   const result = await api.post<MyType>('/custom-endpoint', body);
 *
 * Note: The admin app uses a different pattern -- functional helpers
 * (apiGet, apiPost, etc.) exported from apps/admin/src/lib/api.ts.
 * The two patterns are intentionally kept separate because the storefront
 * authenticates via 'accessToken' with session/store headers, while the
 * admin app uses a simpler 'authToken' approach.
 */
import { rememberOrderViewToken, readOrderViewToken } from './order-view-token';
import {
  isIosWebkit,
  moveSearchToHeader,
  searchQueryHeaders,
  type PublicGoldPricing,
} from '@ebda/shared';
import type { buildQuoteRequest, OrderQuote } from './checkout-quote';
import type { ResolvedPrice } from './b2b-tiers';
import type {
  PublicModel3d,
  ProductFact,
  PersonalisationConfig,
  PublicSizeChart,
} from '@ebda/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

// Common types
interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: string;
}

interface ProductVariant {
  id: string;
  name?: string;
  /** Arabic title — rendered on the Arabic storefront in place of `name`. */
  nameAr?: string;
  sku?: string;
  price: number;
  compareAtPrice?: number;
  inventory?: number;
  /**
   * Server-computed (enrichStockFlags in product.service.ts): true when
   * inventory <= 0 AND the variant/product allows backorders. The storefront
   * uses this to keep Add-to-Cart enabled for out-of-stock backorderable items.
   */
  acceptsBackorder?: boolean;
  /**
   * Optional per-variant image. When set, the product detail gallery swaps
   * its main image to this URL while the variant is selected, and reverts
   * to the product's images on deselection. Useful when a variant looks
   * visibly different from the parent (e.g. a 200g jar vs. a 50g jar).
   */
  imageUrl?: string;
  /** Variant axis values keyed by the English option name (for matching). */
  options: Record<string, string>;
  /** Same keys as `options` but values are the Arabic translations.
   *  Storefront uses these when isRtl so the picker reads `4 لتر` not
   *  `4-liter`. Per-key fallback to English when Arabic is missing. */
  optionsAr?: Record<string, string | undefined>;
}

interface ProductOption {
  id: string;
  name: string;
  /** Arabic axis label, e.g. `الحجم` for `Size`. */
  nameAr?: string;
  /** Total swatch-bearing values (the row list is capped), for the card's +N. */
  _count?: { values: number };
  /** Each value carries both the canonical English string and the Arabic
   *  translation. Storefront reads `valueAr` in isRtl mode and falls
   *  back to `value`; the matching logic always uses `value`. */
  values: Array<{
    id?: string;
    value: string;
    valueAr?: string;
    /** `#RRGGBB` colour dot, or null/absent. */
    swatchHex?: string | null;
    /** https-only fabric/colour photo; wins over `swatchHex`. */
    swatchImageUrl?: string | null;
  }>;
}

interface ProductCategory {
  id: string;
  category: {
    id: string;
    name: string;
    nameAr?: string;
    slug: string;
  };
}

interface Product {
  id: string;
  name: string;
  /**
   * Published, verified-purchase review aggregate (PDP payload only; absent on list payloads).
   * BOUNDED-stale: it rides the cached public product payload (Ruling B3-6).
   */
  ratingStats?: { ratingAverage: number | null; ratingCount: number };
  /** B2B minimum order quantity (public data), null / absent = none. */
  moq?: number | null;
  /**
   * Gold-rate pricing (B5): what the shopper may know about a gold piece (karat, weight, today's rate, when it was
   * recorded). Absent for a fixed-price product. NEVER the margin or where the rate came from.
   */
  goldPricing?: PublicGoldPricing | null;
  /** The same for each variant that carries its own weight, keyed by variant id. */
  variantGoldPricing?: Record<string, PublicGoldPricing>;
  /** PUBLIC quantity price breaks only (group tiers are never in this payload). */
  priceTiers?: Array<{ variantId: string | null; minQty: number; priceMinor: number }>;
  /**
   * Arabic-localized name. Templates render this when the storefront
   * language is `ar` (falling back to `name` when missing). Without it
   * Arabic shoppers see English-only product cards on every surface.
   */
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  /** Short 1-2 sentence blurb, distinct from the full `description` — written
   *  by the bulk-ai-excerpt sweep or manually. Rendered on the PDP near the
   *  title when present. */
  excerpt?: string | null;
  excerptAr?: string | null;
  price: number;
  compareAtPrice?: number;
  /** Discount type set by the merchant — 'percentage' | 'fixed'. null = no explicit discount. */
  discountType?: 'percentage' | 'fixed' | null;
  /** Discount value: basis points (bps) for percentage; piastres for fixed. null when unset. */
  discountValue?: number | null;
  sku?: string;
  /** Merchant-authored free-text card badge (EN). null/absent = no badge. */
  badgeLabel?: string | null;
  /** Arabic counterpart; either side alone is enough (each falls back to the other). */
  badgeLabelAr?: string | null;
  /** Merchant spec rows (fabric, karat...): PDP table, card chips, compare rows. */
  facts?: ProductFact[];
  /** Made-to-order business days; null/absent = ready to ship. Feeds the PDP delivers-by chip. */
  leadTimeDays?: number | null;
  /** PDP personalisation field (PersonalisationConfig); null/absent = no field. */
  personalisation?: PersonalisationConfig | null;
  /** PDP size guide: the product's chart, else its category's; null/absent = no guide. */
  sizeChart?: PublicSizeChart | null;
  inventory?: number;
  /** Server-computed: inventory <= 0 && allowBackorder. Keeps Add-to-Cart
   *  enabled for out-of-stock backorderable products (the cart/order API
   *  honors backorders; the storefront must not silently block them). */
  acceptsBackorder?: boolean;
  /** Server-computed aggregate (enrichStockFlags): effectiveInventory > 0,
   *  where effectiveInventory aggregates variant stock for variant products.
   *  Use this for the OOS decision when no variant is selected — product-level
   *  `inventory` is 0/null for variant products (stock lives on the variants),
   *  so reading it directly mis-reports a stocked product as out of stock. */
  inStock?: boolean;
  status: string;
  images: Array<{ id: string; url: string; alt?: string }>;
  categories?: ProductCategory[];
  variants?: ProductVariant[];
  options?: ProductOption[];
  faqs?: Array<{
    id: string;
    question: string;
    questionAr?: string | null;
    answer: string;
    answerAr?: string | null;
  }>;
  /** Product 3D model (PDP viewer). null/absent = no model, or `product_3d` off for the store. */
  model3d?: PublicModel3d | null;
  createdAt?: string;
}

interface Category {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string | null;
  image?: string;
  productCount?: number;
  /** When false, hidden from the homepage category strip only (the collection
   *  page / nav / filters still show it). Defaults true. */
  showOnHomeStrip?: boolean;
}

/**
 * Lightweight product suggestion returned by the storefront header
 * typeahead. Flat shape (single image URL, no relations) keeps the
 * payload small enough that the dropdown stays responsive even on
 * slow connections.
 */
interface SearchSuggestion {
  id: string;
  slug: string;
  name: string;
  nameAr?: string | null;
  price: number;
  image: string | null;
}

interface CartItem {
  id: string;
  productId: string;
  quantity: number;
  price: number;
  /** A gold line whose price moved since it was added (B5-17): the notice shows until the shopper continues. */
  priceChanged?: boolean;
  previousUnitPrice?: number | null;
  goldPricing?: PublicGoldPricing;
  /** Personalisation text; part of the line identity. */
  note?: string | null;
  product: Product;
}

/**
 * A bundle line on the cart response (`CartBundleView` on the API) — the
 * box the customer bought, priced and displayed as ONE row. `id` is the
 * `CartBundle` row id (what `DELETE /cart/bundles/:cartBundleId` takes),
 * distinct from `bundleId` (the catalog `Bundle` id).
 */
export interface CartBundleItem {
  id: string;
  bundleId: string;
  name: string;
  nameAr: string | null;
  image: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  available: number;
}

interface Cart {
  id: string;
  items: CartItem[];
  bundles?: CartBundleItem[];
  total: number;
  subtotal: number;
}

/**
 * Public bundle listing shape, returned by `GET /stores/public/:storeId/bundles`.
 * Already filtered to purchasable bundles only; `componentSum` (vs. `price`)
 * is what a "Save X" badge is computed from — never render it as a price.
 */
export interface PublicBundle {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  image: string | null;
  price: number;
  componentSum: number;
  available: number;
}

/**
 * Public single-bundle detail shape, returned by
 * `GET /stores/public/:storeId/bundles/:slug`. Unlike `PublicBundle` (the
 * PLP listing, pre-filtered to purchasable-only), this can describe a
 * bundle that is currently NOT sellable (`isPurchasable: false` — out of
 * stock, expired, not yet started) so the detail page can render it as
 * unavailable rather than 404 — a deactivated bundle 404s at the route
 * itself and never reaches this shape. `componentNames` is "what's inside"
 * by name only; there is deliberately no per-component price anywhere on
 * this shape — see `PublicBundle`'s sibling doc comment and
 * `ResolvedBundle` on the API for why.
 */
export interface PublicBundleDetail extends PublicBundle {
  description: string | null;
  descriptionAr: string | null;
  isPurchasable: boolean;
  componentNames: Array<{ name: string; nameAr: string | null }>;
}

/** One skin-type / concern chip (`GET /public/tags`, Phase B3): a tag with published products. */
export interface PublicTag {
  id: string;
  name: string;
  /** Arabic label; the Arabic storefront falls back to `name` without it. */
  nameAr?: string | null;
  productCount: number;
}

/**
 * A purchasable bundle that contains every requested product, with the saving it gives
 * (`GET /stores/public/:storeId/bundle-savings`, Phase B3). The money comes from the same
 * `resolveBundle` the cart prices from and is never cached.
 */
export interface BundleSavingInfo {
  bundleId: string;
  slug: string;
  name: string;
  nameAr: string | null;
  price: number;
  componentSum: number;
  saving: number;
  percent: number;
  /** The bundle holds exactly the requested products. */
  exact: boolean;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  total: number;
  /** Part of `total` paid from the customer wallet (D1), in piastres. The
   *  gateway charges `total - walletAmount`. 0 when the wallet was not used. */
  walletAmount?: number;
  /** Money breakdown (minor units), as `GET /public/orders/:id` returns the
   *  order row. Optional: older callers and fixtures omit them. */
  subtotal?: number;
  shipping?: number;
  discount?: number;
  codFee?: number;
  tax?: number;
  taxIncludedInPrice?: boolean;
  /** The delivery pick (the first notes line without its prefix); `notes` itself is never sent to a shopper. */
  deliveryLine?: string | null;
  /** Payment rows (`ORDER_PAYMENT_SELECT`); the receipt names the method. */
  payments?: Array<{ provider: string; method?: string | null }>;
  items: Array<{
    id: string;
    productId: string;
    /** The variant the customer bought (the order row carries it; "order again" re-adds it). */
    variantId?: string | null;
    quantity: number;
    price: number;
    product?: Product;
    /** Snapshotted canonical (EN) variant title (storefront orders since B0 Task 5). */
    variantName?: string | null;
    /** Snapshotted Arabic variant title (Ruling B0-41); null before it existed. */
    variantNameAr?: string | null;
    /** The customer's personalisation text for this line. */
    personalisation?: string | null;
    /**
     * How a gold-rate line was priced, frozen at sale (B5): the shopper-visible subset only (the server
     * strips the margin, the making charge and the rate row id from customer reads, Ruling B5-23).
     */
    goldSnapshot?: {
      karat: number;
      weightMg: number;
      ratePerGram: number;
      rateAppliedAt: string;
      unitPrice: number;
    } | null;
    /**
     * Set when this line is a bundle component (Task 6). `bundleGroupId`
     * groups the lines that came from ONE box — group by it to render a
     * single customer-facing row; never render these fields' presence to
     * the customer as separate lines. `bundleName`/`bundleNameAr` are
     * snapshotted at order time and must be rendered as-is, never
     * re-fetched from the (possibly renamed/deleted) live bundle.
     */
    bundleId?: string | null;
    bundleGroupId?: string | null;
    bundleName?: string | null;
    bundleNameAr?: string | null;
  }>;
  shippingAddress: Record<string, string>;
  billingAddress?: Record<string, string>;
  createdAt: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  /** The list is in hybrid relevance order (search with semantic search on, Task 12). */
  ranked?: boolean;
  /** The store's highest price in minor units, variant-aware (PL1): sizes the price filter's slider. */
  priceMax?: number;
}

/**
 * One variant-option facet group returned by the public products list.
 * Only present on products with `ProductOption` rows (variant products).
 * Stores without options will receive an empty array.
 */
interface ProductFacet {
  /** Option name in English, e.g. "Size". */
  name: string;
  /** Arabic option name, e.g. "الحجم". */
  nameAr?: string | null;
  /** All distinct values available within the current category/filter context. */
  values: Array<{ value: string; valueAr?: string | null }>;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
}

interface OrderAddress {
  firstName: string;
  lastName: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  /** Structured Egyptian city/district (English name). */
  area?: string;
  /** Arabic name of the city/district. */
  areaAr?: string;
  /** English governorate name (e.g. 'Cairo'). */
  governorate?: string;
  /** Arabic governorate name (e.g. 'القاهرة'). */
  governorateAr?: string;
  /** Street name. */
  street?: string;
  /** Building number/name. */
  building?: string;
  /** Floor number. */
  floor?: string;
  /** Apartment number. */
  apartment?: string;
  state?: string;
  postalCode?: string;
  country: string;
  phone?: string;
  /** Buyer-supplied contact email captured at checkout. Persisted on the
   * order so the invoice / confirmation use the actual customer's address,
   * not the authenticated user's profile email. */
  email?: string;
}

export interface SmsConsentView {
  status: 'granted' | 'revoked' | 'none';
  phone: string | null;
  grantedAt: string | null;
  grantedSource: 'checkout' | 'account' | 'unsubscribe' | null;
  revokedAt: string | null;
  revokedSource: 'checkout' | 'account' | 'unsubscribe' | null;
}

export interface SmsConsentResponse {
  /** The store can send promotional SMS; the account toggle shows only then
   *  (or while consent is still active, so it can always be withdrawn). */
  available: boolean;
  phone: string | null;
  consent: SmsConsentView;
}

interface CreateOrderData {
  shippingAddress: OrderAddress;
  billingAddress?: OrderAddress;
  paymentMethod: string;
  notes?: string;
  couponCode?: string;
  /** Loyalty points the customer requests to redeem. Re-validated server-side
   *  against the real balance + store caps; ignored for guest checkout. */
  pointsToRedeem?: number;
  /** Pay from the customer wallet (D1). A request — the server spends
   *  min(balance, total) only when the store's wallet checkout is on. */
  useWallet?: boolean;
  /** The total (piastres) the buyer confirmed, from the server's own quote (POST /public/orders/quote). The server compares and
   *  never charges it: a mismatch is 409 PRICE_CHANGED. */
  expectedTotal?: number;
  /** Explicit "Send me offers by SMS" tick (issue 206). Sent only when the
   *  box was rendered AND ticked; never a withdrawal. */
  smsOptIn?: boolean;
  /** The shopper's storefront language. Snapshots Arabic variant titles on the
   *  order lines and picks the transactional-email language. */
  locale?: 'en' | 'ar';
}

/**
 * Stand-in returned by refreshAccessToken() when the server rotated the
 * httpOnly cookies without putting the token pair in the response body (the
 * pure-cookie path). NOT a token — never send it as a Bearer credential; it
 * exists only so callers keep a truthy "the refresh succeeded, retry" signal.
 */
const COOKIE_ROTATED = 'cookie-rotated';

/**
 * Returned by refreshAccessToken() when the server REJECTED the refresh (401)
 * or found no refresh token to rotate (401 NO_REFRESH_TOKEN; 400 before FU46-2, #2148). NOT a token and NOT a
 * success. The server clears any auth cookies on both answers (auth.routes.ts
 * POST /auth/refresh), so the browser is now genuinely
 * cookieless — the state in which csrfProtection's no-cookie branch lets a
 * guest-reachable write (POST /payments/create) through. A CSRF-403 is
 * therefore worth retrying ONCE after it; a plain 401 is not.
 */
const SESSION_ENDED = 'session-ended';

/**
 * JS-visible record that a real session was once established in THIS browser.
 * Written at login, on every successful `/auth/me`, and on every successful
 * refresh; removed at logout and when the server rejects a refresh (401).
 *
 * It exists to keep ANONYMOUS traffic off `POST /auth/refresh`.
 * `AuthContext.refreshUser()` calls `/auth/me` on every mount — a first-time
 * visitor's included — and request() refreshes on a 401 there. Without this
 * gate every guest page load posted a credential-less refresh, which
 * `refreshLimiterKey` buckets as the SHARED `<ip>-refresh-anon` key (120/15min)
 * under an IP-wide backstop (600/15min); express-rate-limit counts the request
 * before the route can answer 400. Behind Egypt carrier CGNAT or mall/office
 * wifi, ordinary guest browsing exhausts those buckets, and the REAL signed-in
 * customers on that IP then get 429 on the one route that renews their access
 * token and re-mints their CSRF token — checkout writes 403 and the mount check
 * leaves them as guests. Only a browser that has actually held a session may
 * spend the bucket.
 */
const SESSION_MARKER_KEY = 'hadSession';

function markSessionEstablished(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SESSION_MARKER_KEY, '1');
}

/**
 * The iOS body-lane access token (PR 2301 audit P1): written only from a
 * refresh response that carried the pair, read only on iOS/iPadOS WebKit by
 * `buildHeaders`. Anywhere else a stored copy is residue and is removed.
 * Same key the order-detail page's direct download already reads.
 */
const ACCESS_TOKEN_KEY = 'accessToken';

function readStoredAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  if (isIosWebkit()) return localStorage.getItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  return null;
}

/**
 * Drop every JS-visible trace of the session. Called when the session ends
 * (logout, or a refresh the server rejected) so a now-anonymous browser stops
 * counting as evidence. `csrfToken` goes too: with no auth cookie left,
 * csrfProtection's cookieless branch admits guest writes without one. So does
 * the iOS-mirrored `refreshToken`: the server clears both auth cookies when it
 * rejects a refresh, so that copy is dead — left behind it would read as
 * evidence and buy one doomed refresh per page load.
 */
function clearSessionEvidence(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SESSION_MARKER_KEY);
  localStorage.removeItem('csrfToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem(ACCESS_TOKEN_KEY);
}

/**
 * Has a session ever existed in this browser? The marker above plus the two
 * pre-existing artefacts of a session — the iOS-mirrored `refreshToken` and the
 * `csrfToken`, both written ONLY from a login/register/refresh response — so
 * sessions that predate the marker stay refreshable while a never-signed-in
 * visitor has nothing to present and is not let through.
 */
function hasSessionEvidence(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    localStorage.getItem(SESSION_MARKER_KEY) !== null ||
    localStorage.getItem('refreshToken') !== null ||
    localStorage.getItem('csrfToken') !== null
  );
}

/**
 * Public read of the session hint for code that must not call `/auth/me` blind (AuthContext's mount
 * check on non-account routes, the PDP review form): true when this browser has ever held a session.
 */
export function hasSessionHint(): boolean {
  try {
    return hasSessionEvidence();
  } catch {
    // Blocked storage (private mode, a throwing accessor): no hint, the conservative answer.
    return false;
  }
}

/**
 * One evidence-free refresh probe per TAB, for the session check only (#2164).
 *
 * `hasSessionEvidence()` reads localStorage alone, and Safari ITP evicts
 * localStorage while the server-set `refresh_token` cookie survives — exactly
 * the iOS state the localStorage mirroring exists for. With every marker gone
 * the gate refused the refresh, `/auth/me` stayed a 401, and a signed-in
 * customer was rendered a guest indefinitely (and checked out as one).
 *
 * Letting that cohort through without re-opening #2157 (one anonymous refresh
 * per PAGE LOAD starving the shared `<ip>-refresh-anon` bucket) means capping
 * the evidence-free attempt at one per tab session: `sessionStorage` survives
 * navigations and reloads within a tab and is dropped when the tab closes.
 * Only `GET /auth/me` may spend it — it is the one call whose 401 means "is
 * there a session here at all?". No sessionStorage (private mode, a throwing
 * accessor) means no probe: the conservative side of the budget.
 */
const SESSION_PROBE_KEY = 'authProbe';

function claimSessionProbe(endpoint: string, options: RequestInit): boolean {
  if (typeof window === 'undefined') return false;
  if (!endpoint.startsWith('/auth/me') || (options.method || 'GET').toUpperCase() !== 'GET')
    return false;
  try {
    const ss = window.sessionStorage;
    if (!ss || ss.getItem(SESSION_PROBE_KEY) !== null) return false;
    ss.setItem(SESSION_PROBE_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Has this tab already spent its one evidence-free probe? Then it asked `/auth/me`, tried the one
 * refresh, and was told there is no session. Every way a session can start afterwards (login,
 * passkey, a successful refresh) writes the session hint from this same script, so a browser with a
 * spent probe and no hint is a guest: AuthContext stops asking on each cart / checkout / returns
 * view, which was one red 401 per page in a guest's console (pre-QA sweep 2026-11-10 #7).
 *
 * No sessionStorage (private mode, a throwing accessor) answers false: no probe was ever claimed
 * there, so the caller keeps asking rather than settle a possible customer as a guest.
 */
export function sessionProbeSpent(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const ss = window.sessionStorage;
    return !!ss && ss.getItem(SESSION_PROBE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Auth routes a 401/CSRF-403 must NEVER send through a refresh (#2097).
 *
 * The loop guard only needs to exclude `/auth/refresh` itself (its own 401/429
 * handling lives in refreshAccessToken(), a raw fetch). The rest of this list
 * is the credential-LESS entry points: a 401 there means wrong credentials or
 * a bad link, which a refresh cannot fix. Every other `/auth/` route sits
 * behind `authenticate` (/auth/me, /auth/change-password, …) and heals on a
 * refresh exactly like a non-auth route — change-password used to be folded
 * into a blanket `/auth/` skip, so an expired access token or a pre-CSRF
 * session made it fail with nothing to recover it.
 */
const NO_REFRESH_AUTH_ROUTES = new Set([
  '/auth/refresh',
  '/auth/login',
  '/auth/register',
  '/auth/logout',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/verify-email',
  '/auth/resend-verification',
  '/auth/mfa/verify',
  '/auth/passkeys/authenticate/begin',
  '/auth/passkeys/authenticate/finish',
]);

export function endpointMayRefresh(endpoint: string): boolean {
  return !NO_REFRESH_AUTH_ROUTES.has(endpoint.split('?')[0]);
}

/**
 * A refresh the server THROTTLED, as opposed to one it rejected.
 *
 * 429 and 401 are opposite facts about a session — "slow down" versus "you
 * are signed out" — and `if (!res.ok) return null` collapsed them into the
 * second. On the storefront the cost is a customer shown as signed out while
 * their session is fine; in the admin app the same collapse deleted the
 * stored refresh token. Surfacing the distinction lets a caller wait instead
 * of tearing down.
 */
/**
 * The refresh token lives in localStorage ONLY on iOS/iPadOS WebKit (every
 * write is iOS-gated). Elsewhere it rides the httpOnly cookie, so any
 * localStorage copy is legacy residue: it is removed, never sent.
 */
function readStoredRefreshToken(ios: boolean): string | null {
  if (typeof window === 'undefined') return null;
  if (ios) return localStorage.getItem('refreshToken');
  localStorage.removeItem('refreshToken');
  return null;
}

export class RefreshThrottledError extends Error {
  constructor() {
    super('Refresh was rate-limited');
    this.name = 'RefreshThrottledError';
  }
}

class ApiClient {
  private baseUrl: string;
  private storeId: string | null = null;
  private refreshPromise: Promise<string | null> | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setStoreId(storeId: string | null) {
    this.storeId = storeId;
  }

  private getSessionId(): string {
    if (typeof window === 'undefined') return 'server';
    let sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      sessionId = `sess_${Array.from(array, b => b.toString(16).padStart(2, '0')).join('')}`;
      localStorage.setItem('sessionId', sessionId);
    }
    return sessionId;
  }

  /**
   * Attempt to refresh the access token using the stored refresh token.
   * Deduplicates concurrent calls: if a refresh is already in-flight,
   * subsequent callers await the same promise instead of firing a new one.
   */
  private refreshAccessToken(): Promise<string | null> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async (): Promise<string | null> => {
      // On iOS/iPadOS the refresh token is mirrored to localStorage (the
      // httpOnly cookie is unreliable for installed PWAs). On every other
      // browser it rides in the refresh_token httpOnly cookie, sent
      // automatically via credentials:'include'. With no stored token we send
      // an empty body and let the server read the cookie — on iOS too: Safari
      // ITP evicts localStorage while the server-set cookie survives, and
      // bailing out here left that shopper with no way to re-mint a CSRF token
      // (every checkout write 403'd until a manual re-login). The
      // /auth/refresh route accepts either and answers 401 NO_REFRESH_TOKEN (400 before FU46-2) when neither is
      // present, which lands on the same `null` the old bail returned.
      // And when the browser holds DEAD session cookies, that 400 now clears
      // them, so the next checkout write takes the cookieless guest path (#1531).
      //
      // The READ is iOS-gated (#1945), mirroring admin/orders: a non-iOS
      // browser carrying a leftover entry (written before the writes were
      // iOS-gated) would otherwise take the body-token branch forever, ship a
      // 365-day token in a JS-visible body, and never refresh from its cookie.
      // That residue is cleared here so it is not carried forward.
      const ios = isIosWebkit();
      const storedRefreshToken = readStoredRefreshToken(ios);

      try {
        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          // X-Session-ID is what the server keys the re-issued CSRF token on.
          // This is a raw fetch (it deliberately bypasses buildHeaders to avoid
          // recursing through the 401-refresh path), so the header has to be
          // set explicitly or no csrfToken comes back.
          headers: { 'Content-Type': 'application/json', 'X-Session-ID': this.getSessionId() },
          body: JSON.stringify(storedRefreshToken ? { refreshToken: storedRefreshToken } : {}),
        });
        if (res.status === 429) throw new RefreshThrottledError();
        // 401 (the presented token failed, or none was presented: NO_REFRESH_TOKEN
        // since FU46-2) and 400 (the same no-token answer from an API deployed
        // before FU46-2) are the SAME fact for this browser: the server
        // holds no session for it, and on either answer it has cleared any
        // auth cookies the browser still carried (#1531 — the 400 branch now
        // clears dead `token`/`refresh_token` cookies too). The 400 branch is kept
        // for API/web deploy skew. Reading the 400 as a plain failure
        // (`null`) left a CSRF-403 un-retried, so the shopper's first write
        // after the heal still failed — the heal only took effect on the NEXT
        // request (#2148) — and it kept stale evidence alive, buying one
        // doomed refresh per page load.
        if (res.status === 401 || res.status === 400) {
          // This browser holds no session any more, so it must stop
          // presenting itself as one that could be refreshed.
          clearSessionEvidence();
          return SESSION_ENDED;
        }
        if (!res.ok) return null;
        const json = await res.json();
        if (json.success && json.data) {
          // A server that rotated this session is proof one exists here.
          markSessionEstablished();
          // Only persist the rotated REFRESH token on iOS. On other browsers
          // the server already rotated the httpOnly cookies in this response —
          // no JS-visible token storage needed.
          if (ios && typeof window !== 'undefined' && json.data.refreshToken) {
            localStorage.setItem('refreshToken', json.data.refreshToken);
          }
          // The iOS body lane (PR 2301 audit P1). On a merchant custom domain
          // the API rotates a body-presented token WITHOUT Set-Cookie unless
          // that token is this browser's own cookie (issue 2217 — a
          // cross-site page must never install a session of its choosing), so
          // the `token` cookie can stay expired. Persist the rotated access
          // token and send it as a Bearer (`buildHeaders`), exactly as the
          // admin and orders clients do — otherwise the shopper loops
          // 401 → refresh → 401 and is signed out on every account page. A
          // response with no access token (the cookie lane, or the stale-token
          // fallback) means the cookies are the fresh credential now, so any
          // stored Bearer — which outranks the cookie — is dropped.
          if (ios && typeof window !== 'undefined') {
            if (json.data.accessToken) {
              localStorage.setItem(ACCESS_TOKEN_KEY, json.data.accessToken);
            } else {
              localStorage.removeItem(ACCESS_TOKEN_KEY);
            }
          }
          // The server rotated the COOKIE session because our stored token was
          // dead (issue 2170). Re-presenting that stored token would trip
          // reuse detection and revoke every session of the user — drop it and
          // continue on the cookie.
          if (typeof window !== 'undefined' && json.data.staleRefreshToken) {
            localStorage.removeItem('refreshToken');
            localStorage.removeItem(ACCESS_TOKEN_KEY);
          }
          // The CSRF token is stored on EVERY platform, not just iOS. It is a
          // double-submit token: it is *meant* to be JS-readable, and the
          // request header carrying it is exactly what proves the caller is
          // our own page rather than a cross-origin one. Merchant custom
          // origins are no longer CSRF-exempt, so a session that never stores
          // this token cannot make a state-changing request at all — which is
          // what kept pre-existing sessions working before that exemption was
          // removed.
          if (typeof window !== 'undefined' && json.data.csrfToken) {
            localStorage.setItem('csrfToken', json.data.csrfToken);
          }
          // On the cookie path the server rotates the httpOnly cookies but
          // deliberately withholds the token pair from the body (a merchant
          // custom origin must never be able to READ a session token — see
          // apps/api/src/routes/auth.routes.ts POST /auth/refresh), so
          // `refreshed` is the success signal there, not accessToken. The
          // return value is only ever used as a truthy "retry now" flag.
          return json.data.accessToken ?? (json.data.refreshed ? COOKIE_ROTATED : null);
        }
        return null;
      } catch (error) {
        // A throttle is not a network error — it must reach the request path,
        // or the blanket `return null` here re-collapses 429 into the caller's
        // original 401 and AuthContext renders a signed-in customer as a guest.
        if (error instanceof RefreshThrottledError) throw error;
        return null;
      }
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private buildHeaders(options: RequestInit = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Session-ID': this.getSessionId(),
      ...(options.headers as Record<string, string>),
    };

    if (this.storeId) {
      headers['X-Store-ID'] = this.storeId;
    }

    // A multipart body needs the browser to set Content-Type (with the boundary).
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      delete headers['Content-Type'];
    }

    // iOS body lane only — see ACCESS_TOKEN_KEY. The cookie still rides along
    // (credentials: 'include'); the API prefers the Bearer when both exist.
    const accessToken = readStoredAccessToken();
    if (accessToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    // Include CSRF token for state-changing requests
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && typeof window !== 'undefined') {
      const csrfToken = localStorage.getItem('csrfToken');
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }

    return headers;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const headers = this.buildHeaders(options);
    // SEC-15: a guest order's calls (`/public/orders/:id`, `/payments/instapay/:id/...`) carry the
    // signed view token this tab got when the order was created. Without it the API answers with
    // the masked view.
    const orderId = /\/(?:public\/orders|payments\/instapay)\/([0-9a-f-]{36})(?:[/?]|$)/i.exec(
      endpoint
    )?.[1];
    const viewToken = orderId ? readOrderViewToken(orderId) : null;
    if (viewToken) headers['X-Order-View-Token'] = viewToken;

    // 45s request timeout — long enough for cold-start + complex order
    // creation, short enough to surface a real error before the user
    // gives up on a stuck spinner.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        credentials: 'include',
        headers,
        signal: options.signal ?? controller.signal,
      });

      // A 403 whose code starts CSRF_ means this session holds no valid CSRF
      // token — typically a session established before the token was persisted
      // on this platform. /auth/refresh re-mints one, so refreshing and
      // retrying heals it on the FIRST failed request. Without this the
      // customer's writes fail until the 30-minute access token expires and a
      // 401 happens to trigger the same path.
      let shouldRefreshRetry = response.status === 401;
      let csrfRejected = false;
      if (response.status === 403) {
        try {
          const peek = await response.clone().json();
          if (typeof peek?.error?.code === 'string' && peek.error.code.startsWith('CSRF_')) {
            shouldRefreshRetry = true;
            csrfRejected = true;
          }
        } catch {
          // Non-JSON 403 — treat as a normal failure, not a CSRF problem.
        }
      }

      // On 401 (or a CSRF 403), attempt a single token refresh and retry.
      // Only the credential-less /auth/ entry points are skipped
      // (`endpointMayRefresh`, #2097); /auth/refresh is the loop guard. /auth/me
      // must refresh: it's how AuthContext learns the customer is still signed
      // in, and a 401 there that could never trigger a refresh rendered a
      // customer returning after the 30-minute access-token window (with a
      // perfectly valid 365-day refresh token) signed-out with nothing to
      // recover it (#1789). /auth/change-password heals the same way.
      //
      // A plain 401 additionally requires EVIDENCE that a session ever existed
      // in this browser (`hasSessionEvidence`). /auth/me is called on every
      // mount, so without that condition each anonymous storefront visitor
      // fired a credential-less POST /auth/refresh into the shared
      // `<ip>-refresh-anon` bucket and starved the signed-in customers behind
      // the same CGNAT/wifi IP of their token-renewal path. A CSRF-403 is
      // exempt from the evidence check: that is an active write failing, it is
      // user-paced rather than per-page-load, and it is the one case where a
      // session can be alive in the cookies while localStorage was evicted
      // (Safari ITP) — the state #1526 exists to heal.
      //
      // The one exception to the evidence rule is `claimSessionProbe`: a single
      // evidence-free `/auth/me` refresh per tab, for the Safari-ITP cohort
      // whose localStorage was evicted while the refresh cookie survived
      // (#2164). Evaluated LAST so a browser with evidence never spends it.
      if (
        shouldRefreshRetry &&
        endpointMayRefresh(endpoint) &&
        (csrfRejected || hasSessionEvidence() || claimSessionProbe(endpoint, options))
      ) {
        // A throttle must not read as a rejection. The storefront has
        // nothing to retry with here, so it returns the original response —
        // but it does NOT let the failure reach AuthContext as "signed out".
        let newToken: string | null = null;
        try {
          newToken = await this.refreshAccessToken();
        } catch (error) {
          if (!(error instanceof RefreshThrottledError)) throw error;
          return {
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again.' },
          } as ApiResponse<T>;
        }
        // A rejected refresh (401) cleared the dead session's cookies, so a
        // CSRF-403 is retried once as the cookieless request it now is —
        // otherwise the shopper's "Place order" fails on the very attempt
        // that healed it. A 401 is NOT retried on that answer: the session is
        // gone and the same request would only 401 again. Still one retry at
        // most, so a genuinely broken session cannot loop.
        const refreshed = newToken !== null && newToken !== SESSION_ENDED;
        if (refreshed || (csrfRejected && newToken === SESSION_ENDED)) {
          // Rebuild headers to pick up any new CSRF token set during refresh
          const retryHeaders = this.buildHeaders(options);
          const retryResponse = await fetch(`${this.baseUrl}${endpoint}`, {
            ...options,
            credentials: 'include',
            headers: retryHeaders,
            signal: options.signal ?? controller.signal,
          });

          let retryData: ApiResponse<T>;
          try {
            retryData = await retryResponse.json();
          } catch (e) {
            if (e instanceof SyntaxError) {
              return {
                success: false,
                error: { code: 'INVALID_RESPONSE', message: 'Server returned an invalid response' },
              };
            }
            throw e;
          }

          if (!retryResponse.ok) {
            return {
              success: false,
              error: retryData.error || { code: 'UNKNOWN', message: 'An error occurred' },
            };
          }
          return retryData;
        }
      }

      let data: ApiResponse<T>;
      try {
        data = await response.json();
      } catch (e) {
        if (e instanceof SyntaxError) {
          return {
            success: false,
            error: { code: 'INVALID_RESPONSE', message: 'Server returned an invalid response' },
          };
        }
        throw e;
      }

      if (!response.ok) {
        return {
          success: false,
          error: data.error || { code: 'UNKNOWN', message: 'An error occurred' },
        };
      }

      return data;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return {
          success: false,
          error: {
            code: 'TIMEOUT',
            message: 'The server took too long to respond. Please try again.',
          },
        };
      }
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'Network error' },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Auth
  async register(data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    /**
     * Storefront tenant scope. The web app sends the active store's id so
     * registrations are isolated per tenant; admin app omits this and the
     * API treats the request as an admin-side registration.
     */
    storeId?: string;
  }) {
    // T1-4: register issues NO session — no user, tokens, cookies or
    // csrfToken — and answers identically for new and existing emails. The
    // session (and its CSRF token) starts at login() after the customer
    // verifies their address (#1256: the type used to promise a token pair).
    return this.request<{ emailVerificationSent: true }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async login(email: string, password: string, storeId?: string) {
    const result = await this.request<{
      user: User;
      accessToken: string;
      refreshToken: string;
      csrfToken?: string;
    }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, storeId }) });

    return this.persistLoginSession(result);
  }

  /**
   * Browser-side bookkeeping for a freshly minted session (password login AND passkey sign-in).
   */
  persistLoginSession<
    R extends { success: boolean; data?: { refreshToken: string; csrfToken?: string } },
  >(result: R): R {
    if (result.success && result.data) {
      // This browser now holds a session, so a later 401 on /auth/me is worth
      // a refresh (see SESSION_MARKER_KEY).
      markSessionEstablished();
      // The access token is always set as an HTTP-only cookie by the API
      // response. Persist the refresh token to localStorage ONLY on
      // iOS/iPadOS WebKit, where the cross-origin httpOnly cookie is
      // unreliable for installed PWAs (ITP purges it). On every other browser
      // auth rides the httpOnly cookies and writing the refresh token to
      // localStorage would needlessly expose it to XSS.
      if (typeof window !== 'undefined' && isIosWebkit()) {
        localStorage.setItem('refreshToken', result.data.refreshToken);
      }
      // A fresh login sets fresh cookies; a Bearer left from an earlier
      // session would outrank them (see ACCESS_TOKEN_KEY).
      if (typeof window !== 'undefined') localStorage.removeItem(ACCESS_TOKEN_KEY);
      // The CSRF token is stored on EVERY platform, not just iOS. It is a
      // double-submit token — it is MEANT to be JS-readable, and the header
      // carrying it is what proves the caller is our own page. Storing it only
      // on iOS meant a non-iOS customer on a merchant custom domain (no longer
      // CSRF-exempt) had no token, so every wishlist/address write 403'd until
      // the 30-minute access token expired and the refresh path finally
      // supplied one. Same reasoning as refreshAccessToken above.
      if (typeof window !== 'undefined' && result.data.csrfToken) {
        localStorage.setItem('csrfToken', result.data.csrfToken);
      }
    }

    return result;
  }

  /** Passkey sign-in, step 1: discoverable-credential options for THIS host (Ruling PASSKEY-3). */
  async passkeyBegin() {
    return this.request<unknown>('/auth/passkeys/authenticate/begin', {
      method: 'POST',
      body: '{}',
    });
  }

  /** Passkey sign-in, step 2: send the signed assertion; a full session comes back (PASSKEY-4). */
  async passkeyFinish(response: unknown) {
    const result = await this.request<{
      user: User;
      accessToken: string;
      refreshToken: string;
      csrfToken?: string;
    }>('/auth/passkeys/authenticate/finish', {
      method: 'POST',
      body: JSON.stringify({ response }),
    });
    return this.persistLoginSession(result);
  }

  async logout() {
    // Same iOS gate as refreshAccessToken (#1945): on every other browser the
    // server revokes the refresh_token COOKIE when the body carries none — a
    // leftover localStorage value would make it revoke that stale token and
    // leave the live cookie session standing.
    const refreshToken = readStoredRefreshToken(isIosWebkit());
    await this.request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    if (typeof window !== 'undefined') {
      localStorage.removeItem('refreshToken');
    }
    clearSessionEvidence();
  }

  async getProfile() {
    // Anonymous-safe probe: a browser holding no refresh token of its own asks `?probe=anon`, so a guest gets 200 {user:null}
    // instead of a console 401 (STORE-QA-43). Callers must treat `data.user === null` as "signed out".
    const soft =
      typeof window !== 'undefined' &&
      (() => {
        try {
          return !window.localStorage.getItem('refreshToken');
        } catch {
          return false;
        }
      })();
    const result = await this.request<{ user: User | null }>(
      soft ? '/auth/me?probe=anon' : '/auth/me'
    );
    // A 200 here is the other proof a session lives in this browser — it covers
    // sessions established before the marker existed, and it re-arms one whose
    // localStorage was cleared while the cookies survived.
    if (result.success && result.data?.user) {
      markSessionEstablished();
    }
    return result as typeof result & { data?: { user: User } };
  }

  async updateProfile(data: { firstName?: string; lastName?: string; phone?: string }) {
    return this.request<{ user: User }>('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** The signed-in shopper's SMS-offers consent for this store (issue 206). */
  async getSmsConsent() {
    return this.request<SmsConsentResponse>('/auth/me/sms-consent');
  }

  async setSmsConsent(optIn: boolean) {
    return this.request<{ consent: SmsConsentView }>('/auth/me/sms-consent', {
      method: 'PUT',
      body: JSON.stringify({ optIn }),
    });
  }

  async changePassword(currentPassword: string, newPassword: string) {
    return this.request<{ message: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  async submitContact(data: {
    name: string;
    email: string;
    subject: string;
    message: string;
    /** Honeypot (`CONTACT_HONEYPOT_FIELD`): always '' from a real person. */
    company_site?: string;
  }) {
    return this.request<{ message: string }>('/public/contact', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Subscribe an email to this store's newsletter list. Idempotent — the
   * API returns `alreadySubscribed: true` for repeat addresses so the UI
   * can show the same success state without leaking list membership.
   */
  async subscribeNewsletter(data: {
    email: string;
    language?: 'en' | 'ar';
    source?: 'footer' | 'popup' | 'manual' | 'section';
  }) {
    return this.request<{ alreadySubscribed: boolean }>('/public/newsletter/subscribe', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async forgotPassword(email: string, storeId?: string) {
    return this.request<{ message: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email, storeId }),
    });
  }

  async resetPassword(token: string, password: string) {
    return this.request<{ message: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  // Products (public endpoints)
  /**
   * Fetch the public product list. Accepts standard filter params plus an
   * optional `optionFilters` map (option name → selected values) which is
   * serialized to `?opt_<name>=val1,val2` query params.
   *
   * The response now includes a `facets` array alongside `products` and
   * `meta`. `facets` is empty (`[]`) for stores/categories without options.
   */
  async getProducts(params?: Record<string, string>, optionFilters?: Record<string, string[]>) {
    const searchParams = new URLSearchParams(params);
    // Serialize option filters as ?opt_<name>=val1,val2
    if (optionFilters) {
      for (const [name, vals] of Object.entries(optionFilters)) {
        if (vals.length > 0) {
          searchParams.set(`opt_${name}`, vals.join(','));
        }
      }
    }
    // The shopper's term travels in the X-Search-Query header, never in the URL (Ruling
    // SEARCH-URL-1): a URL is retained in Cloudflare request logs.
    const { params: rest, headers } = moveSearchToHeader(searchParams);
    const query = rest.toString() ? `?${rest.toString()}` : '';
    return this.request<{ products: Product[]; facets: ProductFacet[]; meta: PaginationMeta }>(
      `/public/products${query}`,
      { headers }
    );
  }

  async getProduct(slugOrId: string) {
    return this.request<{ product: Product }>(`/public/products/${slugOrId}`);
  }

  async getCategories() {
    return this.request<{ categories: Category[] }>('/public/categories');
  }

  async getFeaturedProducts(limit = 8) {
    return this.request<{ products: Product[]; meta: PaginationMeta }>(
      `/public/products?featured=true&limit=${limit}`
    );
  }

  // Blog (Bucket E1, 2026-05-17)
  async listBlogPosts(storeId: string, limit = 20) {
    return this.request<{
      posts: Array<{
        id: string;
        slug: string;
        title: string;
        titleAr?: string | null;
        excerpt?: string | null;
        excerptAr?: string | null;
        coverImage?: string | null;
        publishedAt?: string | null;
        createdAt: string;
      }>;
    }>(`/public/${storeId}/blog?limit=${limit}`);
  }

  // Locations (store branches)
  async listLocations(storeId: string) {
    return this.request<{
      locations: Array<{
        id: string;
        name: string;
        nameAr?: string | null;
        country: string;
        countryAr?: string | null;
        address: string;
        addressAr?: string | null;
        phone?: string | null;
        whatsapp?: string | null;
        mapsUrl?: string | null;
        mapsEmbedUrl?: string | null;
        hours?: string | null;
        hoursAr?: string | null;
        isPublished: boolean;
        position: number;
      }>;
    }>(`/public/${storeId}/locations`);
  }

  async getBlogPost(storeId: string, slug: string) {
    return this.request<{
      post: {
        id: string;
        slug: string;
        title: string;
        titleAr?: string | null;
        excerpt?: string | null;
        excerptAr?: string | null;
        content: string;
        contentAr?: string | null;
        coverImage?: string | null;
        publishedAt?: string | null;
        createdAt: string;
      };
    }>(`/public/${storeId}/blog/${slug}`);
  }

  // `getStoreProducts` / `getStoreProduct` lived here, unreferenced. They were
  // the cited justification for leaving `/stores/:id/products` off the origin
  // gate's deny side — an enumeration that read method DEFINITIONS as call
  // sites. Nothing in apps/web ever called either, and their own comment said
  // "for admin". Removed so the next enumeration cannot cite them again.

  // Cart (public endpoints - uses default store)
  async getCart() {
    return this.request<{ cart: Cart }>('/public/cart');
  }

  /** The shopper saw the moved gold price and continued: the server re-quotes every gold line at today's price. */
  async acknowledgePrices() {
    return this.request<{ cart?: Cart }>('/public/cart/acknowledge-prices', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async addToCart(productId: string, quantity = 1, variantId?: string, note?: string) {
    return this.request<{ cart: Cart }>('/public/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity, variantId, ...(note ? { note } : {}) }),
    });
  }

  async syncCart(
    items: Array<{ productId: string; quantity: number; variantId?: string; note?: string }>
  ) {
    return this.request<{ cart: Cart }>('/public/cart/sync', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  async updateCartItem(itemId: string, quantity: number) {
    return this.request<{ cart: Cart }>(`/public/cart/items/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity }),
    });
  }

  async removeCartItem(itemId: string) {
    return this.request<{ cart: Cart }>(`/public/cart/items/${itemId}`, {
      method: 'DELETE',
    });
  }

  async clearCart() {
    return this.request<{ cart: Cart }>('/public/cart', {
      method: 'DELETE',
    });
  }

  // Bundles (public storefront).
  //
  // The bundle cart mutation routes were added ONLY under
  // `/stores/:storeId/cart/bundles[/:id]` (cart.routes.ts, Task 5) — an
  // admin-space path family that `restrictPlatformOnlyOrigins`
  // (security.ts) blocks for every non-platform origin in production (see
  // tests/unit/platform-only-origins.test.ts). The storefront runs on
  // merchant custom domains, so calling that path directly would 403 on
  // every live merchant while appearing to work in local dev (which hits
  // the platform origin). Mirror routes were added to public.routes.ts
  // under `/public/cart/bundles[/:id]`, exactly like every other cart
  // route in this file — these call THAT surface. GET /public/cart already
  // returns `cart.bundles`, so no separate public read endpoint was needed.

  /** GET /stores/public/:storeId/bundles — purchasable bundles for the PLP.
   *  `/stores/public/...` is its own allow-listed pattern (distinct from
   *  `/stores/:storeId/...`), already used by the storefront's shipping/
   *  coupon/promotion calls. */
  async getPublicBundles(storeId: string) {
    return this.request<{ bundles: PublicBundle[] }>(
      `/stores/public/${encodeURIComponent(storeId)}/bundles`
    );
  }

  /** GET /public/tags — the store's tags with published products (labels in both languages). */
  async getPublicTags(name?: string) {
    return this.request<{ tags: PublicTag[] }>(
      name ? `/public/tags?name=${encodeURIComponent(name)}` : '/public/tags'
    );
  }

  /** GET /stores/public/:storeId/bundle-savings — the bundles that save money on these products.
   *  `bundles` is a feature flag; callers gate on `bundlesNavVisible(store.enabledFeatures)`. */
  async getBundleSavings(storeId: string, productIds: string[]) {
    return this.request<{ savings: BundleSavingInfo[] }>(
      `/stores/public/${encodeURIComponent(storeId)}/bundle-savings?productIds=${encodeURIComponent(productIds.join(','))}`
    );
  }

  /** GET /stores/public/:storeId/bundles/:slug — single bundle detail for
   *  the /bundles/<slug> PDP. Same allow-listed `/stores/public/...`
   *  pattern as `getPublicBundles` above. */
  async getPublicBundle(storeId: string, slug: string) {
    return this.request<{ bundle: PublicBundleDetail }>(
      `/stores/public/${encodeURIComponent(storeId)}/bundles/${encodeURIComponent(slug)}`
    );
  }

  /** POST /public/cart/bundles — add a bundle to the cart as its own row. */
  async addBundleToCart(bundleId: string, quantity = 1) {
    return this.request<{ cart: Cart }>('/public/cart/bundles', {
      method: 'POST',
      body: JSON.stringify({ bundleId, quantity }),
    });
  }

  /** DELETE /public/cart/bundles/:cartBundleId — the CartBundle row id. */
  async removeCartBundle(cartBundleId: string) {
    return this.request<{ cart: Cart }>(
      `/public/cart/bundles/${encodeURIComponent(cartBundleId)}`,
      {
        method: 'DELETE',
      }
    );
  }

  // Orders (public endpoints)
  /**
   * `idempotencyKey` (audit M-012): one key per checkout attempt. A double tap or a timeout retry carries the same key and the
   * server returns the order the first request created instead of creating a second.
   */
  async createOrder(data: CreateOrderData, opts: { idempotencyKey?: string } = {}) {
    const res = await this.request<{ order: Order; viewToken?: string }>('/public/orders', {
      method: 'POST',
      body: JSON.stringify(data),
      ...(opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
    });
    // SEC-15: a guest order comes with the signed token that unlocks its address on the success page.
    if (res.success && res.data?.order?.id) {
      rememberOrderViewToken(res.data.order.id, res.data.viewToken);
    }
    return res;
  }

  /**
   * The EXACT total the server would charge for the current cart and these inputs (B2B design review I-1). Sent back as
   * `expectedTotal` on createOrder so a repricing between the two surfaces as 409 PRICE_CHANGED.
   */
  async quoteOrder(data: ReturnType<typeof buildQuoteRequest>) {
    return this.request<{ quote: OrderQuote }>('/public/orders/quote', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /** The signed-in buyer's price for specific quantities (private, no-store). Never sends or accepts a client price. */
  async resolvePrices(items: Array<{ productId: string; variantId?: string | null; qty: number }>) {
    return this.request<{ prices: ResolvedPrice[] }>('/public/pricing/resolve', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  /** Apply for a wholesale account (signed-in customer; the applicant is the session, never a body field). */
  async applyForWholesale(data: {
    businessName: string;
    commercialRegNo?: string | null;
    phone: string;
    notes?: string | null;
    /** The applicant accepted the data notice shown on the form (the server records the time). */
    consent: true;
  }) {
    return this.request<{ application: { id: string; status: string } }>(
      '/public/wholesale/apply',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
  }

  /** The approved buyer's extra catalogue (wholesale-only products). 404 for everyone else. Private, no-store. */
  async getWholesaleProducts(params: { page?: number; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return this.request<{ products: Product[]; meta: PaginationMeta }>(
      `/public/wholesale/products${qs ? `?${qs}` : ''}`
    );
  }

  /** One wholesale-only product by slug, for an approved buyer. 404 for everyone else. */
  async getWholesaleProduct(slug: string) {
    return this.request<{ product: Product }>(
      `/public/wholesale/products/${encodeURIComponent(slug)}`
    );
  }

  async getWholesaleStatus() {
    return this.request<{
      application: {
        id: string;
        status: 'pending' | 'approved' | 'rejected' | 'revoked';
        businessName: string;
        decisionNote: string | null;
        createdAt: string;
        decidedAt: string | null;
      } | null;
      isWholesale: boolean;
    }>('/public/wholesale/status');
  }

  async getOrders() {
    return this.request<{ orders: Order[] }>('/public/orders');
  }

  /** "Order again" (Ruling B4-8): the signed-in customer's last distinct product ids. Per customer, never cached. */
  async getReorderProductIds() {
    return this.request<{ productIds: string[] }>('/public/customers/me/reorder');
  }

  async getOrder(orderId: string) {
    return this.request<{ order: Order }>(`/public/orders/${orderId}`);
  }

  /**
   * Verify-on-return: ask the API to re-check this order's payment with the
   * provider and reconcile our DB. The reliable primary confirmation path
   * (a gateway's webhook can be late or lost). Idempotent + guest-safe — see
   * the API route for the authz model. `paymentId` is an identifier a gateway
   * may append to the success URL on return (audit-only; authorization rides
   * on the order UUID + the provider's own status answer).
   */
  async verifyOrderPayment(orderId: string, paymentId?: string) {
    return this.request<{
      paymentStatus: 'paid' | 'failed' | 'unpaid';
      providerStatus: string;
      statusChanged: boolean;
    }>(`/public/orders/${orderId}/verify-payment`, {
      method: 'POST',
      body: JSON.stringify(paymentId ? { paymentId } : {}),
    });
  }

  async getOrderTimeline(storeId: string, orderId: string) {
    return this.request<{
      timeline: Array<{
        at: string;
        source: string;
        kind: string;
        fromStatus?: string;
        toStatus?: string;
        details?: string;
        location?: string;
      }>;
    }>(`/stores/${storeId}/orders/${orderId}/timeline`);
  }

  /**
   * Enrol the authenticated customer in the loyalty program for `storeId`.
   * The server creates the loyalty record and awards the signup bonus
   * (configured per-store; default 100 pts). Requires an authenticated
   * customer session — admin tokens are rejected by the API.
   *
   * Returns the new `CustomerPointsInfo` record on success.
   *
   * Maps to: POST /public/:storeId/loyalty/join
   */
  async joinLoyalty(storeId: string) {
    return this.request<{ points: Record<string, unknown> }>(`/public/${storeId}/loyalty/join`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  /**
   * Storefront search typeahead. Returns up to 8 active products matching
   * `q` against either English or Arabic name. Empty / sub-2-char queries
   * resolve to an empty list without a network round-trip — callers can
   * still fire the call and get `[]` cheaply, but skipping is preferred.
   *
   * Requires the active storefront store id to be set via `setStoreId()`
   * (StoreContext does this on mount). Returns an error response if no
   * store is bound, mirroring how getCart() fails without a session.
   */
  async searchSuggest(q: string, signal?: AbortSignal) {
    const trimmed = (q ?? '').trim();
    if (!this.storeId) {
      return {
        success: false,
        error: { code: 'NO_STORE', message: 'Store context not set' },
      } as ApiResponse<{ suggestions: SearchSuggestion[] }>;
    }
    if (trimmed.length < 1) {
      return {
        success: true,
        data: { suggestions: [] as SearchSuggestion[] },
      } as ApiResponse<{ suggestions: SearchSuggestion[] }>;
    }
    return this.request<{ suggestions: SearchSuggestion[] }>(
      `/public/${this.storeId}/search/suggest`,
      { headers: searchQueryHeaders(trimmed), signal }
    );
  }

  // Customer wallet (store credit, D1). Mounted under /stores (the wallet
  // router's own path is /public/:storeId/wallet) — NOT /public/:storeId/…,
  // which belongs to a different router and 404s.
  async getWallet(storeId: string) {
    return this.request<{ balance: number; checkoutAvailable: boolean }>(
      `/stores/public/${encodeURIComponent(storeId)}/wallet`
    );
  }

  async getWalletTransactions(storeId: string, cursor?: string) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<{
      transactions: Array<{
        id: string;
        amount: number;
        balanceAfter: number;
        type: string;
        createdAt: string;
        order: { orderNumber: string } | null;
        return: { returnNumber: string } | null;
      }>;
      nextCursor: string | null;
    }>(`/stores/public/${encodeURIComponent(storeId)}/wallet/transactions${qs}`);
  }

  // Generic methods for other endpoints
  async get<T>(endpoint: string) {
    return this.request<T>(endpoint);
  }

  async post<T>(endpoint: string, data: unknown) {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /** Multipart upload (e.g. an InstaPay receipt image). Same auth/session headers as `post`. */
  async postForm<T>(endpoint: string, form: FormData) {
    return this.request<T>(endpoint, { method: 'POST', body: form });
  }

  async put<T>(endpoint: string, data: unknown) {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async patch<T>(endpoint: string, data: unknown) {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async delete<T>(endpoint: string) {
    return this.request<T>(endpoint, {
      method: 'DELETE',
    });
  }

  /**
   * Fire-and-forget server-side view beacon.
   *
   * Posts to POST /api/v1/public/:storeId/views so the nightly analytics
   * rollup can count views in FunnelSnapshot.productViews.
   *
   * Uses `navigator.sendBeacon` when available (non-blocking, survives page
   * unload) and falls back to a keepalive fetch. Both approaches are
   * fire-and-forget — any error is silently ignored. Guard against SSR.
   *
   * Call once per PDP mount, after verifying we are in a browser context.
   */
  beaconProductView(storeId: string, productId: string, sessionId?: string): void {
    if (typeof window === 'undefined') return; // SSR guard
    if (!storeId || !productId) return;

    const url = `${this.baseUrl}/public/${storeId}/views`;
    const body = JSON.stringify(sessionId ? { productId, sessionId } : { productId });
    const type = 'application/json';

    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const blob = new Blob([body], { type });
        const sent = navigator.sendBeacon(url, blob);
        if (sent) return; // sendBeacon succeeded — we're done
      }
    } catch {
      // sendBeacon threw — fall through to fetch keepalive
    }

    // Keepalive fetch fallback (Chrome/FF when sendBeacon returns false for
    // large payloads, or in environments without sendBeacon).
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
      keepalive: true,
      credentials: 'omit', // public endpoint, no cookies needed
    }).catch(() => {
      // Ignore — tracking failure must never surface to the user
    });
  }
}

export const api = new ApiClient(API_URL);
export { API_URL };

/**
 * `/auth/me` answers that say nothing about the session: the server (or the
 * network between) could not be asked. A throttled refresh or a direct 429
 * (`RATE_LIMITED`), a timeout, a dropped connection, a non-JSON 502/503 page
 * from the edge (`INVALID_RESPONSE`), or a server-side 5xx. "Could not ask" is
 * unknown, never "signed out" (#2096's class on the storefront, #2098).
 */
const TRANSIENT_SESSION_CODES = new Set([
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'INTERNAL_ERROR',
  'DATABASE_ERROR',
  'COMMIT_TIMEOUT',
]);

export function isTransientSessionAnswer(result: { success: boolean; error?: { code: string } }) {
  return !result.success && TRANSIENT_SESSION_CODES.has(result.error?.code ?? '');
}

/**
 * The storefront's mount-time session check, with the same bounded ladder
 * admin and orders run (`checkSessionWithMountRetries`, Ruling P2-B2-5):
 * a transient answer is retried after each delay before the caller settles.
 *
 * Without it the RATE_LIMITED branch in AuthContext was a no-op on the only
 * path that matters (#2158/#2098): on mount `user` is already null, so
 * "leave the state alone" rendered a signed-in customer a guest, `isLoading`
 * went false, and nothing ever re-checked. AuthContext keeps `isLoading` true
 * across this whole call, so no consumer renders the guest UI mid-retry.
 * Same 3 × 5s budget as the other two frontends; a throttle that outlasts it
 * falls through to the pre-existing behaviour (guest render, cookies intact).
 */
export const PROFILE_MOUNT_RETRY_DELAYS_MS = [5_000, 5_000, 5_000] as const;

export async function getProfileWithMountRetries(
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
) {
  let result = await api.getProfile();
  for (const delay of PROFILE_MOUNT_RETRY_DELAYS_MS) {
    if (!isTransientSessionAnswer(result)) break;
    await sleep(delay);
    result = await api.getProfile();
  }
  return result;
}
export type {
  User,
  Product,
  ProductVariant,
  ProductOption,
  ProductFacet,
  Category,
  Order,
  PaginationMeta,
  SearchSuggestion,
};
