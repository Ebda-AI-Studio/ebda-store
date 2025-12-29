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
  categories?: Array<{ id: string; name: string; slug: string }>;
}

interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
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

interface CreateOrderData {
  shippingAddress: {
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
  };
  billingAddress?: {
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
  };
  paymentMethod: string;
  notes?: string;
}

class ApiClient {
  private baseUrl: string;
  private accessToken: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken');
    }
  }

  setToken(token: string | null) {
    this.accessToken = token;
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('accessToken', token);
      } else {
        localStorage.removeItem('accessToken');
      }
    }
  }

  private getSessionId(): string {
    if (typeof window === 'undefined') return 'server';
    let sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('sessionId', sessionId);
    }
    return sessionId;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'X-Session-ID': this.getSessionId(),
      ...options.headers,
    };

    if (this.accessToken) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.accessToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || { code: 'UNKNOWN', message: 'An error occurred' },
        };
      }

      return data;
    } catch {
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'Network error' },
      };
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
      this.setToken(result.data.accessToken);
      if (typeof window !== 'undefined') {
        localStorage.setItem('refreshToken', result.data.refreshToken);
      }
    }

    return result;
  }

  async logout() {
    const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
    await this.request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    this.setToken(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('refreshToken');
    }
  }

  async getProfile() {
    return this.request<{ user: User }>('/auth/me');
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
    return this.request<{ products: Product[]; meta: PaginationMeta }>(`/products${query}`);
  }

  async getProduct(slugOrId: string) {
    return this.request<{ product: Product }>(`/products/${slugOrId}`);
  }

  async getCategories() {
    return this.request<{ categories: Category[] }>('/categories');
  }

  // Store-scoped products (for admin)
  async getStoreProducts(storeId: string, params?: Record<string, string>) {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    return this.request<{ products: Product[]; meta: PaginationMeta }>(`/stores/${storeId}/products${query}`);
  }

  async getStoreProduct(storeId: string, productId: string) {
    return this.request<{ product: Product }>(`/stores/${storeId}/products/${productId}`);
  }

  // Cart (public endpoints - uses default store)
  async getCart() {
    return this.request<{ cart: Cart }>('/cart');
  }

  async addToCart(productId: string, quantity = 1) {
    return this.request<{ cart: Cart }>('/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity }),
    });
  }

  async updateCartItem(itemId: string, quantity: number) {
    return this.request<{ cart: Cart }>(`/cart/items/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity }),
    });
  }

  async removeCartItem(itemId: string) {
    return this.request<{ cart: Cart }>(`/cart/items/${itemId}`, {
      method: 'DELETE',
    });
  }

  async clearCart() {
    return this.request<{ cart: Cart }>('/cart', {
      method: 'DELETE',
    });
  }

  // Orders (public endpoints)
  async createOrder(data: CreateOrderData) {
    return this.request<{ order: Order }>('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getOrders() {
    return this.request<{ orders: Order[] }>('/orders');
  }

  async getOrder(orderId: string) {
    return this.request<{ order: Order }>(`/orders/${orderId}`);
  }

  // Store
  async getStore() {
    return this.request<{ store: Store }>('/store');
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
export type { ApiResponse, User, Product, Category, Cart, CartItem, Order, Store, PaginationMeta };
