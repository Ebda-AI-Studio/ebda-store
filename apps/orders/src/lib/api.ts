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
 * provider needs to stay unauthenticated-but-loading, not unauthenticated,
 * or the redirect effect routes to /login anyway while the user holds a
 * perfectly good session. This retry happens INSIDE checkAuth, so `isLoading`
 * stays true throughout it and the redirect cannot fire mid-retry.
 *
 * ONE retry here, and it is deliberately not a recovery from a real throttle
 * by itself — see `checkSessionWithMountRetries` below, which wraps this in a
 * further bounded ladder at the whole-session-check level (#1782), so a
 * mount-time throttle gets more than one chance before the caller gives up.
 *
 * Both buckets it waits on are FIXED 15-minute windows backed by a
 * rate-limit-redis counter, so once a caller is over the cap every request
 * for the rest of the window 429s. No ladder — at this layer or the outer one
 * — can be long enough to reliably cross that boundary without the spinner
 * itself becoming the problem; what retrying buys is the case it can actually
 * win — a request that lands on the wrong side of a window boundary, or loses
 * a moment of Redis contention.
 *
 * The recovery from a genuine, still-throttled-after-retries throttle is that
 * the CREDENTIAL SURVIVES: `clearStoredSession` is never called on this
 * outcome, so once the window turns over the user signs back in without a
 * password — on the next full page load of a protected route, or now also on
 * /login itself (previously a dead end; see #1814 and the login page's
 * already-signed-in redirect). Making this automatic without any reload —
 * re-checking on focus or `visibilitychange` — is the more durable fix and is
 * deliberately still not in this PR; see Ruling P2-B2-7.
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

/** A `GET /auth/me` outcome, named the same three ways as a refresh. */
export type SessionCheckResult =
  | { status: 'authenticated'; user: unknown }
  | { status: 'signed-out' }
  | { status: 'throttled' };

async function fetchMe(apiUrl: string): Promise<Response> {
  const accessToken = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${apiUrl}/auth/me`, { credentials: 'include', headers });
}

/**
 * The mount-time session check: `GET /auth/me`, and on a 401 wait out a
 * throttle (`refreshSessionWaitingOutThrottle`) before deciding. Exported as
 * a plain function — network calls only, no component state — so the
 * decision logic is unit-testable without rendering `AuthProvider`: this repo
 * has no jsdom (Ruling P2-B2-2 / P2-B2-7).
 */
export async function checkSession(apiUrl: string): Promise<SessionCheckResult> {
  const first = await fetchMe(apiUrl);
  if (first.ok) {
    const data = await first.json();
    return { status: 'authenticated', user: data.data.user };
  }
  if (first.status !== 401) {
    return { status: 'signed-out' };
  }

  const outcome = await refreshSessionWaitingOutThrottle();
  if (outcome === 'refreshed') {
    const retry = await fetchMe(apiUrl);
    if (retry.ok) {
      const data = await retry.json();
      return { status: 'authenticated', user: data.data.user };
    }
    clearStoredSession();
    return { status: 'signed-out' };
  }
  if (outcome === 'rejected') {
    clearStoredSession();
    return { status: 'signed-out' };
  }
  // Still 'throttled': the server said "slow down", not "you are signed
  // out" — leave the credential alone (see refreshSessionWaitingOutThrottle).
  return { status: 'throttled' };
}

/**
 * How a persistently-throttled mount check is waited out before the caller
 * gives up. `THROTTLE_RETRY_DELAYS_MS` waits out a request-level blip inside
 * ONE refresh; this is one layer up — bounded retries of the WHOLE session
 * check, so a mount that lands on a throttle gets the same "wrong side of a
 * window boundary" chance instead of being kicked straight to a login screen
 * while holding a perfectly good refresh token (#1782).
 *
 * `isLoading` stays true across this whole call (see `auth.tsx`'s
 * `checkAuth`), so the redirect-to-/login effect cannot fire mid-retry. If
 * every attempt is still throttled after the budget, the caller falls back to
 * the pre-existing behaviour: land on /login with the credential intact —
 * where a full reload now actually re-checks instead of being a dead end
 * (#1814), rather than this loop growing to cover the full 15-minute window.
 */
export const MOUNT_RETRY_DELAYS_MS = [5_000, 5_000, 5_000] as const;

export async function checkSessionWithMountRetries(apiUrl: string): Promise<SessionCheckResult> {
  let result = await checkSession(apiUrl);
  for (const delay of MOUNT_RETRY_DELAYS_MS) {
    if (result.status !== 'throttled') break;
    await sleep(delay);
    result = await checkSession(apiUrl);
  }
  return result;
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
    // On iOS with no locally stored refresh token there is nothing to
    // exchange (the cookie can't be trusted there either) — every caller
    // that reaches this function (checkAuth's direct refreshSession() path
    // included, not just the refreshToken() callback) skips the doomed
    // network round-trip instead of hitting /auth/refresh only to be
    // rejected. This was previously checked only inside the unused
    // refreshToken() callback, so checkAuth's own refresh path missed it.
    if (ios && !localStorage.getItem('refreshToken')) return null;
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
