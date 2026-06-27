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
import { isIosWebkit } from '@force/shared';

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
  /** Each value carries both the canonical English string and the Arabic
   *  translation. Storefront reads `valueAr` in isRtl mode and falls
   *  back to `value`; the matching logic always uses `value`. */
  values: Array<{ value: string; valueAr?: string }>;
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
   * Arabic-localized name. Templates render this when the storefront
   * language is `ar` (falling back to `name` when missing). Without it
   * Arabic shoppers see English-only product cards on every surface.
   */
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  compareAtPrice?: number;
  sku?: string;
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
  createdAt?: string;
}

interface Category {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
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
  product: Product;
}

interface Cart {
  id: string;
  items: CartItem[];
  total: number;
  subtotal: number;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  total: number;
  items: Array<{
    id: string;
    productId: string;
    quantity: number;
    price: number;
    product?: Product;
  }>;
  shippingAddress: Record<string, string>;
  billingAddress?: Record<string, string>;
  createdAt: string;
}

interface Store {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  settings?: Record<string, unknown>;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
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
  /** Structured Kuwait delivery area (English area name). */
  area?: string;
  /** Arabic name of the Kuwait delivery area. */
  areaAr?: string;
  /** English governorate name (e.g. 'Hawalli'). */
  governorate?: string;
  /** Arabic governorate name (e.g. 'حولي'). */
  governorateAr?: string;
  /** Kuwait address block number. */
  block?: string;
  /** Kuwait street name/number. */
  street?: string;
  /** Kuwait avenue (جادة). */
  avenue?: string;
  /** House or building number/name. */
  house?: string;
  /** Floor number. */
  floor?: string;
  state?: string;
  postalCode?: string;
  country: string;
  phone?: string;
  /** Buyer-supplied contact email captured at checkout. Persisted on the
   * order so the invoice / confirmation use the actual customer's address,
   * not the authenticated user's profile email. */
  email?: string;
}

interface CreateOrderData {
  shippingAddress: OrderAddress;
  billingAddress?: OrderAddress;
  paymentMethod: string;
  notes?: string;
  couponCode?: string;
  /** Customer SMS marketing opt-in captured from the checkout checkbox. */
  smsOptIn?: boolean;
  /** Loyalty points the customer requests to redeem. Re-validated server-side
   *  against the real balance + store caps; ignored for guest checkout. */
  pointsToRedeem?: number;
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
      // On iOS/iPadOS the refresh token lives in localStorage (the httpOnly
      // cookie is unreliable for installed PWAs). On every other browser the
      // refresh token rides in the refresh_token httpOnly cookie, sent
      // automatically via credentials:'include' — so we send an empty body
      // and let the server read it from the cookie. The /auth/refresh route
      // accepts either. Only bail early when iOS has no stored token.
      const ios = isIosWebkit();
      const storedRefreshToken =
        typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
      if (ios && !storedRefreshToken) return null;

      try {
        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(storedRefreshToken ? { refreshToken: storedRefreshToken } : {}),
        });
        if (!res.ok) return null;
        const json = await res.json();
        if (json.success && json.data) {
          // Only persist rotated tokens to localStorage on iOS. On other
          // browsers the server already rotated the httpOnly cookies in this
          // response — no JS-visible token storage needed.
          if (ios && typeof window !== 'undefined') {
            if (json.data.refreshToken) {
              localStorage.setItem('refreshToken', json.data.refreshToken);
            }
            if (json.data.csrfToken) {
              localStorage.setItem('csrfToken', json.data.csrfToken);
            }
          }
          return json.data.accessToken ?? null;
        }
        return null;
      } catch {
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

      // On 401, attempt a single token refresh and retry the request
      if (response.status === 401 && !endpoint.startsWith('/auth/')) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
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
    return this.request<{ user: User; accessToken: string; refreshToken: string }>(
      '/auth/register',
      { method: 'POST', body: JSON.stringify(data) }
    );
  }

  async login(email: string, password: string, storeId?: string) {
    const result = await this.request<{
      user: User;
      accessToken: string;
      refreshToken: string;
      csrfToken?: string;
    }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, storeId }) });

    if (result.success && result.data) {
      // The access token is always set as an HTTP-only cookie by the API
      // response. Persist the refresh token to localStorage ONLY on
      // iOS/iPadOS WebKit, where the cross-origin httpOnly cookie is
      // unreliable for installed PWAs (ITP purges it). On every other browser
      // auth rides the httpOnly cookies and writing the refresh token to
      // localStorage would needlessly expose it to XSS.
      if (typeof window !== 'undefined' && isIosWebkit()) {
        localStorage.setItem('refreshToken', result.data.refreshToken);
        if (result.data.csrfToken) {
          localStorage.setItem('csrfToken', result.data.csrfToken);
        }
      }
    }

    return result;
  }

  async logout() {
    const refreshToken =
      typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
    await this.request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    if (typeof window !== 'undefined') {
      localStorage.removeItem('refreshToken');
    }
  }

  async getProfile() {
    return this.request<{ user: User }>('/auth/me');
  }

  async updateProfile(data: { firstName?: string; lastName?: string; phone?: string }) {
    return this.request<{ user: User }>('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async changePassword(currentPassword: string, newPassword: string) {
    return this.request<{ message: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  async submitContact(data: { name: string; email: string; subject: string; message: string }) {
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
    source?: 'footer' | 'popup' | 'manual';
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
    const query = searchParams.toString() ? `?${searchParams.toString()}` : '';
    return this.request<{ products: Product[]; facets: ProductFacet[]; meta: PaginationMeta }>(
      `/public/products${query}`
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

  // Store-scoped products (for admin)
  async getStoreProducts(storeId: string, params?: Record<string, string>) {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    return this.request<{ products: Product[]; meta: PaginationMeta }>(
      `/stores/${storeId}/products${query}`
    );
  }

  async getStoreProduct(storeId: string, productId: string) {
    return this.request<{ product: Product }>(`/stores/${storeId}/products/${productId}`);
  }

  // Cart (public endpoints - uses default store)
  async getCart() {
    return this.request<{ cart: Cart }>('/public/cart');
  }

  async addToCart(productId: string, quantity = 1, variantId?: string) {
    return this.request<{ cart: Cart }>('/public/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity, variantId }),
    });
  }

  async syncCart(items: Array<{ productId: string; quantity: number; variantId?: string }>) {
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

  // Orders (public endpoints)
  async createOrder(data: CreateOrderData) {
    return this.request<{ order: Order }>('/public/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getOrders() {
    return this.request<{ orders: Order[] }>('/public/orders');
  }

  async getOrder(orderId: string) {
    return this.request<{ order: Order }>(`/public/orders/${orderId}`);
  }

  /**
   * Verify-on-return: ask the API to re-check this order's payment with the
   * provider and reconcile our DB. The reliable primary confirmation path
   * (MyFatoorah's portal webhook is account-level and doesn't fire per
   * invoice). Idempotent + guest-safe — see the API route for the authz
   * model. `paymentId` is the identifier MyFatoorah appends to the success
   * URL on return (audit-only; authorization rides on the order UUID +
   * the provider's own status answer).
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

  // Store
  async getStore() {
    return this.request<{ store: Store }>('/public/store');
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
  async searchSuggest(q: string) {
    const trimmed = (q ?? '').trim();
    if (!this.storeId) {
      return {
        success: false,
        error: { code: 'NO_STORE', message: 'Store context not set' },
      } as ApiResponse<{ suggestions: SearchSuggestion[] }>;
    }
    if (trimmed.length < 2) {
      return {
        success: true,
        data: { suggestions: [] as SearchSuggestion[] },
      } as ApiResponse<{ suggestions: SearchSuggestion[] }>;
    }
    return this.request<{ suggestions: SearchSuggestion[] }>(
      `/public/${this.storeId}/search/suggest?q=${encodeURIComponent(trimmed)}`
    );
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

  async put<T>(endpoint: string, data: unknown) {
    return this.request<T>(endpoint, {
      method: 'PUT',
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
