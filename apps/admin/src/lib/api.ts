/**
 * Admin App API Helper Utilities
 *
 * Pattern: Functional helpers (apiGet, apiPost, apiPut, apiPatch, apiDelete)
 * that wrap the base `apiRequest` function with standardized error handling.
 *
 * Base URL comes from `getApiUrl()` which reads NEXT_PUBLIC_API_URL.
 * Authentication is handled via HTTP-only cookies set by the API on
 * login/register. All requests include `credentials: 'include'` so the
 * browser automatically sends the cookie -- no manual token management.
 *
 * Usage:
 *   import { apiGet, apiPost } from '@/lib/api';
 *   const { data, error } = await apiGet<MyType>('/api/v1/stores');
 *   const { data, error } = await apiPost<MyType>('/api/v1/stores', body);
 *
 * Note: The web (storefront) app uses a different pattern -- a class-based
 * ApiClient instance exported from apps/web/src/lib/api.ts. The two patterns
 * are intentionally kept separate because the storefront includes additional
 * session IDs and store IDs in headers.
 */

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Some legacy endpoints return list payloads as `T[]` directly while others
 * wrap them as `{ data: T[] }`. `unwrapList` accepts either shape and returns
 * the array (or `[]` if neither matches). Use this instead of casting through
 * `as any` when the caller can't be certain which variant the endpoint emits.
 */
export function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && 'data' in value) {
    const inner = (value as { data: unknown }).data;
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

/**
 * Symmetrical helper for object payloads that may be wrapped as `{ data: T }`
 * or returned bare. Returns `null` when no usable object is present.
 */
export function unwrapObject<T extends object>(value: unknown): T | null {
  if (value && typeof value === 'object') {
    if ('data' in value) {
      const inner = (value as { data: unknown }).data;
      if (inner && typeof inner === 'object') return inner as T;
    }
    return value as T;
  }
  return null;
}

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

/**
 * Get the base API URL
 */
export function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
}

/**
 * Transparent refresh-on-401 (matches the storefront ApiClient).
 *
 * The access token is now short-lived (30 min). When a protected request
 * 401s mid-session we silently exchange the long-lived refresh token for a
 * fresh access+refresh pair via /auth/refresh and retry the original request
 * once — the merchant never sees a logout. Rotation means the response
 * returns a NEW refresh token; we mirror both into localStorage for the iOS
 * PWA Bearer path. The HTTP-only refresh cookie is rotated server-side in
 * parallel for the browser-cookie path.
 *
 * Single-flight: concurrent 401s share ONE in-flight refresh promise so we
 * don't fire N parallel /auth/refresh calls (which would rotate the family
 * N times and trip reuse-detection on all but the first).
 */
let refreshInFlight: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    // Body token for the Bearer/localStorage path; the HTTP-only refresh
    // cookie is sent automatically via credentials:'include' for the
    // pure-browser path (the API accepts either).
    const refreshToken = localStorage.getItem('refreshToken');

    try {
      const res = await fetch(`${getApiUrl()}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (json?.success && json.data) {
        if (json.data.accessToken) localStorage.setItem('accessToken', json.data.accessToken);
        if (json.data.refreshToken) localStorage.setItem('refreshToken', json.data.refreshToken);
        if (json.data.csrfToken) localStorage.setItem('csrfToken', json.data.csrfToken);
        return json.data.accessToken ?? null;
      }
      return null;
    } catch {
      return null;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/**
 * Make an API request with proper error handling.
 * Authentication is handled automatically via the HTTP-only cookie sent
 * by the browser when `credentials: 'include'` is set.
 */
export async function apiRequest<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T | null; error: ApiError | null }> {
  const url = endpoint.startsWith('http') ? endpoint : `${getApiUrl()}${endpoint}`;

  // Build the request headers fresh each call so a retry after a token
  // refresh picks up the new Bearer + CSRF token from localStorage.
  const buildHeaders = (): Record<string, string> => {
    const method = (options.method || 'GET').toUpperCase();
    const csrfHeaders: Record<string, string> = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfToken = typeof window !== 'undefined' ? localStorage.getItem('csrfToken') : null;
      if (csrfToken) {
        csrfHeaders['X-CSRF-Token'] = csrfToken;
      }
    }

    // Bearer token from localStorage. The HTTP-only cookie is the primary
    // auth path for browsers, but iOS Safari/WebKit purges third-party
    // cookies aggressively for installed PWAs (the admin is at
    // app.forcemediakw.com, the API at store-api.forcemediakw.com —
    // a third-party cookie from WebKit's perspective). Sending the token
    // explicitly in the Authorization header keeps the iOS admin PWA
    // signed in even after WebKit drops the cookie. The API's auth
    // middleware (apps/api/src/middleware/auth.ts) accepts either.
    const authHeaders: Record<string, string> = {};
    if (typeof window !== 'undefined') {
      const accessToken = localStorage.getItem('accessToken');
      if (accessToken) {
        authHeaders.Authorization = `Bearer ${accessToken}`;
      }
    }

    return {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...csrfHeaders,
      ...(options.headers as Record<string, string>),
    };
  };

  try {
    let response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: buildHeaders(),
    });

    // Transparent refresh-on-401: the access token is short-lived, so an
    // expired one gets silently swapped for a fresh pair and the request is
    // retried ONCE. Skip /auth/ endpoints to avoid a refresh→401→refresh loop.
    if (
      response.status === 401 &&
      !endpoint.startsWith('/auth/') &&
      typeof window !== 'undefined'
    ) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        response = await fetch(url, {
          ...options,
          credentials: 'include',
          headers: buildHeaders(),
        });
      }
    }

    let data: ApiResponse<T>;
    try {
      data = await response.json();
    } catch {
      // Response is not JSON
      if (!response.ok) {
        return {
          data: null,
          error: {
            code: 'PARSE_ERROR',
            message: `Server returned non-JSON response with status ${response.status}`,
            status: response.status,
          },
        };
      }
      return { data: null, error: null };
    }

    if (!response.ok) {
      // A super-admin who hasn't enrolled in 2FA gets 403 MFA_SETUP_REQUIRED on
      // every protected route. Send them straight to the enrollment page instead
      // of surfacing a dead "failed to load" error. The /account/security page
      // only calls non-gated routes (/auth/me, /auth/mfa/*) so this can't loop.
      if (
        typeof window !== 'undefined' &&
        data.error?.code === 'MFA_SETUP_REQUIRED' &&
        window.location.pathname !== '/account/security'
      ) {
        window.location.assign('/account/security');
      }
      return {
        data: null,
        error: {
          code: data.error?.code || 'SERVER_ERROR',
          message: data.error?.message || `Request failed with status ${response.status}`,
          status: response.status,
        },
      };
    }

    return { data: data.data as T, error: null };
  } catch (error) {
    return {
      data: null,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Network request failed',
        status: 0,
      },
    };
  }
}

/**
 * Raw fetch with the same auth headers `apiRequest` adds, but returns
 * the unparsed Response so callers can stream HTML, blobs, or anything
 * non-JSON. Use this for invoice HTML, file downloads, and exports —
 * never for normal JSON endpoints (use `apiGet` etc. instead, which
 * also unwraps the API's `{ success, data, error }` envelope).
 *
 * The reason this exists at all: iOS Safari/WebKit purges third-party
 * cookies aggressively, so the iOS admin PWA depends on the Bearer
 * token in localStorage. A bare `fetch(url, { credentials: 'include' })`
 * misses the Bearer header and gets 401 on every authenticated request.
 */
export async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const url = endpoint.startsWith('http') ? endpoint : `${getApiUrl()}${endpoint}`;
  const method = (options.method || 'GET').toUpperCase();

  // Rebuilt for the retry so a refreshed Bearer/CSRF token is picked up.
  const buildHeaders = (): Record<string, string> => {
    const csrfHeaders: Record<string, string> = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfToken = typeof window !== 'undefined' ? localStorage.getItem('csrfToken') : null;
      if (csrfToken) csrfHeaders['X-CSRF-Token'] = csrfToken;
    }

    const authHeaders: Record<string, string> = {};
    if (typeof window !== 'undefined') {
      const accessToken = localStorage.getItem('accessToken');
      if (accessToken) authHeaders.Authorization = `Bearer ${accessToken}`;
    }

    return {
      ...authHeaders,
      ...csrfHeaders,
      ...(options.headers as Record<string, string>),
    };
  };

  let response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: buildHeaders(),
  });

  // Same transparent refresh-on-401 as apiRequest — keeps file downloads /
  // invoice HTML working after the short-lived access token expires.
  if (response.status === 401 && !endpoint.startsWith('/auth/') && typeof window !== 'undefined') {
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await fetch(url, {
        ...options,
        credentials: 'include',
        headers: buildHeaders(),
      });
    }
  }

  return response;
}

/**
 * GET request helper
 */
export async function apiGet<T = unknown>(endpoint: string) {
  return apiRequest<T>(endpoint, { method: 'GET' });
}

/**
 * POST request helper
 */
export async function apiPost<T = unknown>(endpoint: string, body?: unknown) {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * PUT request helper
 */
export async function apiPut<T = unknown>(endpoint: string, body?: unknown) {
  return apiRequest<T>(endpoint, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * DELETE request helper
 */
export async function apiDelete<T = unknown>(endpoint: string) {
  return apiRequest<T>(endpoint, { method: 'DELETE' });
}

/**
 * PATCH request helper
 */
export async function apiPatch<T = unknown>(endpoint: string, body?: unknown) {
  return apiRequest<T>(endpoint, {
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Get user-friendly error message based on status code
 */
export function getErrorMessage(error: ApiError): { title: string; message: string } {
  switch (error.status) {
    case 400:
      return {
        title: 'Invalid request',
        message: error.message || 'The request was invalid. Please check your input.',
      };
    case 401:
      return {
        title: 'Session expired',
        message: 'Please log in again to continue.',
      };
    case 403:
      return {
        title: 'Access denied',
        message: error.message || 'You do not have permission to perform this action.',
      };
    case 404:
      return {
        title: 'Not found',
        message: error.message || 'The requested resource was not found.',
      };
    case 409:
      return {
        title: 'Conflict',
        message: error.message || 'This action conflicts with existing data.',
      };
    case 422:
      return {
        title: 'Validation error',
        message: error.message || 'Please check your input and try again.',
      };
    case 429:
      return {
        title: 'Too many requests',
        message: 'Please wait a moment before trying again.',
      };
    case 500:
    case 502:
    case 503:
    case 504:
      return {
        title: 'Server error',
        message: 'Something went wrong on our end. Please try again later.',
      };
    case 0:
      return {
        title: 'Connection error',
        message: 'Unable to connect to the server. Please check your internet connection.',
      };
    default:
      return {
        title: 'Error',
        message: error.message || 'An unexpected error occurred.',
      };
  }
}
