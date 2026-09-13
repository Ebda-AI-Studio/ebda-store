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
 * 429 and 401 are opposite facts about a session — "slow down" versus "you are
 * signed out" — and `if (!res.ok) return null` collapsed them into the second.
 * That answer is destructive here: the failed-refresh branch deletes
 * `accessToken` AND `refreshToken` from localStorage, and on the installed iOS
 * PWA that store holds the ONLY copy of the refresh token (the cross-origin
 * httpOnly cookie is unreliable — which is why this app asks for persistent
 * storage). A few seconds of rate-limit back-pressure therefore signed the
 * user out permanently, with nothing left to recover from.
 *
 * This is the third of three frontends. The first version of this fix landed
 * on admin and web only and left orders byte-identical to the bug — a
 * client-side auth fix on two of three surfaces is not a fix.
 */
export class RefreshThrottledError extends Error {
  constructor() {
    super('Refresh was rate-limited');
    this.name = 'RefreshThrottledError';
  }
}

/**
 * What a refresh attempt actually established about the session.
 *
 * Three outcomes, not two. `refreshAccessToken()` answers `string | null`, and
 * callers read `null` as "signed out" — right for a 401, wrong for a 429.
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
 * Called ONLY for a 'rejected' outcome. This is not a cache eviction — on iOS
 * it is the end of the session — so it must never be the answer to
 * back-pressure.
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

      if (res.status === 429) throw new RefreshThrottledError();
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
      // A throttled refresh is not a failed one, but there is nothing this
      // call site can do with that distinction beyond NOT retrying: the
      // original 401 is returned and the session is left intact.
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
