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

import { isIosWebkit } from '@force/shared';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    /** Structured extra data alongside the message — Zod validation's
     *  `{ field: string[] }` issue map, or a route-specific payload like
     *  bundle.routes.ts's `PRICE_NOT_ALLOCATABLE`'s `{ suggested: number }`.
     *  Shape depends on `code`; callers narrow it themselves. */
    details?: Record<string, unknown>;
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
  /** See `ApiResponse['error']['details']` — forwarded through unparsed so
   *  callers that need route-specific structured data (e.g. bundle saves'
   *  `PRICE_NOT_ALLOCATABLE` -> `{ suggested: number }`) don't have to
   *  bypass this envelope parser to get at it. */
  details?: Record<string, unknown>;
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
 * returns a NEW refresh token; we mirror both into localStorage ONLY on
 * iOS/iPadOS WebKit (Bearer path). On all other browsers the httpOnly
 * refresh cookie is rotated server-side and returned tokens are kept
 * in-memory only (not persisted to localStorage). The HTTP-only refresh
 * cookie is always rotated server-side in parallel for both paths.
 *
 * Single-flight: concurrent 401s share ONE in-flight refresh promise so we
 * don't fire N parallel /auth/refresh calls (which would rotate the family
 * N times and trip reuse-detection on all but the first).
 */
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Stand-in returned by refreshAccessToken() when the server rotated the
 * httpOnly cookies without putting the token pair in the response body (the
 * pure-cookie path). NOT a token — never send it as a Bearer credential; it
 * exists only so callers keep a truthy "the refresh succeeded, retry" signal.
 */
const COOKIE_ROTATED = 'cookie-rotated';

/**
 * A refresh the server THROTTLED, as opposed to one it rejected.
 *
 * 429 and 401 are opposite facts about a session — one says "slow down", the
 * other says "you are signed out" — and `if (!res.ok) return null` collapsed
 * them into the second. The consequence was not cosmetic: on a 429,
 * `checkAuth` cleared `accessToken` AND `refreshToken` from localStorage,
 * and on the iOS PWA that store holds the only copy of the refresh token.
 * A transient throttle after a deploy therefore signed the user out
 * permanently, with nothing to recover from.
 */
export class RefreshThrottledError extends Error {
  constructor() {
    super('Refresh was rate-limited');
    this.name = 'RefreshThrottledError';
  }
}

export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    // On iOS/iPadOS the refresh token lives in localStorage (httpOnly cookie
    // is unreliable). On all other browsers send an empty body and let the
    // server read from req.cookies.refresh_token instead.
    const ios = isIosWebkit();
    const storedRefreshToken = ios ? localStorage.getItem('refreshToken') : null;

    try {
      const res = await fetch(`${getApiUrl()}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedRefreshToken ? { refreshToken: storedRefreshToken } : {}),
      });
      if (res.status === 429) throw new RefreshThrottledError();
      if (!res.ok) return null;
      const json = await res.json();
      if (json?.success && json.data) {
        // Only persist new tokens to localStorage on iOS/iPadOS. On other
        // browsers the httpOnly cookie was already rotated by the server
        // response — no JS-visible token storage needed.
        if (ios) {
          if (json.data.accessToken) localStorage.setItem('accessToken', json.data.accessToken);
          if (json.data.refreshToken) localStorage.setItem('refreshToken', json.data.refreshToken);
          if (json.data.csrfToken) localStorage.setItem('csrfToken', json.data.csrfToken);
        }
        // On the cookie path the server rotates the httpOnly cookies but
        // deliberately withholds the token pair from the body (a merchant
        // custom origin must never be able to READ a session token — see
        // apps/api/src/routes/auth.routes.ts POST /auth/refresh), so
        // `refreshed` is the success signal there, not accessToken. The return
        // value is only ever used as a truthy "retry now" flag.
        return json.data.accessToken ?? (json.data.refreshed ? COOKIE_ROTATED : null);
      }
      return null;
    } catch (error) {
      // A throttle is not a network error — it must reach the caller, or the
      // blanket `return null` here re-collapses 429 into "signed out" and the
      // credential clear in auth.tsx fires anyway.
      if (error instanceof RefreshThrottledError) throw error;
      return null;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/**
 * What a refresh attempt actually established about the session.
 *
 * Three outcomes, not two. `refreshAccessToken()` answers `string | null`,
 * and callers read `null` as "signed out" — which is right for a 401 and
 * wrong for a 429. Collapsing them is what let a rate-limited refresh trigger
 * the credential wipe below.
 */
export type RefreshOutcome = 'refreshed' | 'rejected' | 'throttled';

/** Run a refresh and name what it proved. */
export async function refreshSession(): Promise<RefreshOutcome> {
  try {
    return (await refreshAccessToken()) !== null ? 'refreshed' : 'rejected';
  } catch (error) {
    if (error instanceof RefreshThrottledError) return 'throttled';
    return 'rejected';
  }
}

/**
 * Drop the locally stored session.
 *
 * Called ONLY for a 'rejected' outcome. On the iOS PWA `refreshToken` in
 * localStorage is the only copy there is — the httpOnly cookie is unreliable
 * for installed PWAs — so this is not a cache eviction, it is the end of the
 * session, and it must never be the answer to back-pressure.
 */
export function clearStoredSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

/**
 * How a throttled refresh is waited out before the caller gives up.
 *
 * Preserving the credential is only half an answer: on the mount path the
 * provider stays unauthenticated, `isLoading` goes false, and the redirect
 * effect routes to /login anyway — so the user still sees a password prompt
 * while holding a perfectly good session. `checkAuth` runs ONCE, guarded by a
 * ref, so "the next request retries" was not true there; nothing
 * re-exercised the surviving token. These retries happen INSIDE checkAuth, so
 * `isLoading` stays true throughout and the redirect never fires.
 *
 * ONE retry, and it is deliberately not a recovery from a real throttle.
 *
 * Both buckets it waits on are FIXED 15-minute windows backed by a
 * rate-limit-redis counter, so once a caller is over the cap every request
 * for the rest of the window 429s. No ladder short enough to sit inside
 * `checkAuth` can cross that boundary; a longer one would just be a longer
 * spinner that ends on the same login screen, two requests deeper into the
 * IP-wide cap. What this single retry buys is the case it can actually win —
 * a request that lands on the wrong side of a window boundary, or loses a
 * moment of Redis contention.
 *
 * The real recovery from a genuine throttle is that the CREDENTIAL SURVIVES:
 * `clearStoredSession` is never called on this outcome, so a reload once the
 * window turns over signs the user back in without a password. Making that
 * automatic — re-checking on focus or `visibilitychange` rather than only on
 * mount — is the durable fix and is deliberately not in this PR; see Ruling
 * P2-B2-7.
 */
export const THROTTLE_RETRY_DELAYS_MS = [1_500] as const;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Refresh, waiting out a throttle rather than reporting it as a sign-out. */
export async function refreshSessionWaitingOutThrottle(): Promise<RefreshOutcome> {
  let outcome = await refreshSession();
  for (const delay of THROTTLE_RETRY_DELAYS_MS) {
    if (outcome !== 'throttled') break;
    await sleep(delay);
    outcome = await refreshSession();
  }
  return outcome;
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
    // app.forcemediakw.com, the API at api.force-ai.co —
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
      // A throttled refresh is not a failed one, but there is nothing this
      // call site can do with that distinction beyond NOT retrying: the
      // original 401 is returned and the session is left intact. The one
      // caller that must know is checkAuth, which would otherwise discard the
      // stored credentials — see auth.tsx.
      let newToken: string | null = null;
      try {
        newToken = await refreshAccessToken();
      } catch (error) {
        if (!(error instanceof RefreshThrottledError)) throw error;
      }
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
          details: data.error?.details,
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
    let newToken: string | null = null;
    try {
      newToken = await refreshAccessToken();
    } catch (error) {
      if (!(error instanceof RefreshThrottledError)) throw error;
    }
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
