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
  sku?: string;
  price: number;
  compareAtPrice?: number;
  inventory?: number;
  options: Record<string, string>;
}

interface ProductOption {
  id: string;
  name: string;
  values: string[];
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
  slug: string;
  description?: string;
  price: number;
  compareAtPrice?: number;
  sku?: string;
  inventory?: number;
  status: string;
  images: Array<{ id: string; url: string; alt?: string }>;
  categories?: ProductCategory[];
  variants?: ProductVariant[];
  options?: ProductOption[];
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
  state: string;
  postalCode: string;
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
      const refreshToken =
        typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
      if (!refreshToken) return null;

      try {
        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        if (json.success && json.data) {
          if (json.data.refreshToken && typeof window !== 'undefined') {
            localStorage.setItem('refreshToken', json.data.refreshToken);
          }
          if (json.data.csrfToken && typeof window !== 'undefined') {
            localStorage.setItem('csrfToken', json.data.csrfToken);
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
  async register(data: { email: string; password: string; firstName: string; lastName: string }) {
    return this.request<{ user: User; accessToken: string; refreshToken: string }>(
      '/auth/register',
      { method: 'POST', body: JSON.stringify(data) }
    );
  }

  async login(email: string, password: string) {
    const result = await this.request<{ user: User; accessToken: string; refreshToken: string }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) }
    );

    if (result.success && result.data) {
      // The access token is set as an HTTP-only cookie by the API response.
      // Only store the refresh token in localStorage.
      if (typeof window !== 'undefined') {
        localStorage.setItem('refreshToken', result.data.refreshToken);
        if ((result.data as any).csrfToken) {
          localStorage.setItem('csrfToken', (result.data as any).csrfToken);
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

  async forgotPassword(email: string) {
    return this.request<{ message: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async resetPassword(token: string, password: string) {
    return this.request<{ message: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  // Products (public endpoints)
  async getProducts(params?: Record<string, string>) {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    return this.request<{ products: Product[]; meta: PaginationMeta }>(`/public/products${query}`);
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

  async addToCart(productId: string, quantity = 1) {
    return this.request<{ cart: Cart }>('/public/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity }),
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

  // Store
  async getStore() {
    return this.request<{ store: Store }>('/public/store');
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
}

export const api = new ApiClient(API_URL);
export { API_URL };
export type { User, Product, ProductVariant, ProductOption, Category, Order, PaginationMeta };
