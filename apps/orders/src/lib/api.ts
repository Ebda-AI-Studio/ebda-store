/**
 * Orders PWA — API helper.
 *
 * Ported verbatim (minus the admin-only MFA-redirect) from
 * apps/admin/src/lib/api.ts. The wire protocol is IDENTICAL — this is a focused
 * copy, not a forked contract. Auth is the Bearer-token path: the access token
 * lives in localStorage and is sent as `Authorization: Bearer`, because iOS
 * Safari/WebKit purges the cross-origin cookie for installed PWAs. The
 * HTTP-only cookie is still sent via credentials:'include' as a fallback for
 * browsers that can rely on it.
 *
 * The base URL comes from NEXT_PUBLIC_API_URL — the same Railway API the admin
 * and storefront use. No new endpoints are introduced by this app.
 */

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

export function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
}

/**
 * Returns true on iOS/iPadOS Safari/WebKit — the only browsers where the
 * cross-origin httpOnly auth cookie is unreliable for installed PWAs (ITP
 * purges it). On all other browsers the httpOnly cookie carries the session
 * and tokens must NOT be persisted to localStorage (JS-readable, XSS exposure).
 */
function isIosWebkit(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iP(hone|ad|od)/i.test(navigator.userAgent)) return true;
  // iPadOS 13+ desktop-mode fingerprint (Apple's documented detection)
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
}

/**
 * Single-flight transparent refresh-on-401. Concurrent 401s share ONE in-flight
 * /auth/refresh so we don't rotate the refresh-token family N times and trip
 * the API's reuse-detection.
 */
let refreshInFlight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    // On iOS/iPadOS the refresh token lives in localStorage (the httpOnly
    // cookie is unreliable). On every other browser send an empty body and
    // let the server read the refresh_token httpOnly cookie via
    // credentials:'include' — the /auth/refresh route accepts either.
    const ios = isIosWebkit();
    const storedRefreshToken = ios ? localStorage.getItem('refreshToken') : null;
    try {
      const res = await fetch(`${getApiUrl()}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedRefreshToken ? { refreshToken: storedRefreshToken } : {}),
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (json?.success && json.data) {
        // Only persist rotated tokens to localStorage on iOS. On other
        // browsers the server already rotated the httpOnly cookies in this
        // response — no JS-visible token storage needed.
        if (ios) {
          if (json.data.accessToken) localStorage.setItem('accessToken', json.data.accessToken);
          if (json.data.refreshToken) localStorage.setItem('refreshToken', json.data.refreshToken);
          if (json.data.csrfToken) localStorage.setItem('csrfToken', json.data.csrfToken);
        }
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

export async function apiRequest<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T | null; error: ApiError | null }> {
  const url = endpoint.startsWith('http') ? endpoint : `${getApiUrl()}${endpoint}`;

  const buildHeaders = (): Record<string, string> => {
    const method = (options.method || 'GET').toUpperCase();
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

export async function apiGet<T = unknown>(endpoint: string) {
  return apiRequest<T>(endpoint, { method: 'GET' });
}

export async function apiPost<T = unknown>(endpoint: string, body?: unknown) {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiPut<T = unknown>(endpoint: string, body?: unknown) {
  return apiRequest<T>(endpoint, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  });
}
