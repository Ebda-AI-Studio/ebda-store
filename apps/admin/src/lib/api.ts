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

import { hasSessionHintCookie, sessionHintCookieClears } from '@ebda/shared';
import {
  PLAN_GATE_FALLBACK,
  RAW_PLAN_GATE_MESSAGES,
  RAW_STATUS_MESSAGE,
  isPlanGateError,
} from './route-feature-gates';
import { AccountsError, accountsLogout, accountsToken, establishApiSession } from './accounts';
import { armProactiveRefresh, disarmProactiveRefresh, grantExpiryMs } from './proactive-refresh';
import { handleSessionEnded } from './session-ended';

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

/**
 * The iOS-only refresh-token read, which also REMOVES the legacy copy on every
 * other browser (#2034). Writes are iOS-gated, so a value found elsewhere is
 * residue from before the gate: a 365-day credential in JS-readable storage
 * that is never read or sent again. Mirrors apps/web/src/lib/api.ts.
 */
export function readStoredRefreshToken(ios: boolean): string | null {
  if (typeof window === 'undefined') return null;
  if (ios) return localStorage.getItem('refreshToken');
  localStorage.removeItem('refreshToken');
  return null;
}

/**
 * Evidence that a session ever existed in this browser (#2095, #2163).
 *
 * The mount check runs on EVERY route, /login included, and an anonymous
 * visitor's `GET /auth/me` 401 used to be followed by a credential-less
 * `POST /auth/refresh`. express-rate-limit counts that request against the
 * SHARED `<ip>-refresh-anon` bucket and the IP-wide backstop before the route
 * can answer, so staff reloading the login page behind one office/carrier IP
 * drained the budget the signed-in sessions on that IP renew from — and once
 * it was throttled, the mount ladder multiplied each load into 4 × /auth/me +
 * 8 × /auth/refresh. Same gate as apps/web (`hasSessionEvidence`).
 *
 * Evidence: the marker written on every authenticated answer, a stored token
 * (iOS mirrors them), or the admin's `ebda-session=1` hint cookie.
 */
const SESSION_MARKER_KEY = 'hadSession';

export function markSessionEvidence(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SESSION_MARKER_KEY, '1');
}

export function hasSessionEvidence(): boolean {
  if (typeof window === 'undefined') return false;
  if (
    localStorage.getItem(SESSION_MARKER_KEY) !== null ||
    localStorage.getItem('refreshToken') !== null ||
    localStorage.getItem('accessToken') !== null ||
    localStorage.getItem('csrfToken') !== null
  ) {
    return true;
  }
  return typeof document !== 'undefined' && hasSessionHintCookie(document.cookie);
}

/**
 * One evidence-free refresh per TAB (web's #2164 answer): Safari ITP can evict
 * localStorage while the server's refresh cookie survives, so a real session
 * with no local evidence still gets one chance per tab — sessionStorage keeps
 * it to one across reloads. No sessionStorage means no probe.
 */
const SESSION_PROBE_KEY = 'authProbe';

function claimSessionProbe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const ss = window.sessionStorage;
    if (!ss || ss.getItem(SESSION_PROBE_KEY) !== null) return false;
    ss.setItem(SESSION_PROBE_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

let lastGrant: { token: string; expiresAt: number } | null = null;

/** Remember the newest grant and schedule the next renewal ~60 s before it expires (P0 logout audit). */
export function rememberGrant(grant: { access_token: string; expires_at?: number }): void {
  const expiresAt = grantExpiryMs(grant);
  lastGrant = { token: grant.access_token, expiresAt };
  if (typeof window !== 'undefined') {
    armProactiveRefresh(expiresAt, { refresh: () => refreshAccessToken() });
  }
}

/** A token with at least `minTtlMs` left: the cached one, else a refresh. null = the session is gone. */
export async function getFreshAccessToken(minTtlMs = 60_000): Promise<string | null> {
  if (lastGrant && lastGrant.expiresAt - Date.now() > minTtlMs) return lastGrant.token;
  return refreshAccessToken();
}

export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    // The session lives at the shared identity service (accounts.ebda.app, Rulings ID-1/ID-2): ask it for a fresh 15 minute
    // Store token with its own HttpOnly cookie, then exchange the token for the Store API's cookie. Nothing credential-like
    // is kept in JS. (The evidence / per-tab-probe gate for anonymous visitors (#2163) stays in the callers, as before.)
    try {
      const grant = await accountsToken();
      await establishApiSession(grant.access_token);
      markSessionEvidence();
      rememberGrant(grant);
      return grant.access_token;
    } catch (error) {
      // 401 NO_SESSION: the session is gone for good (password changed, signed out elsewhere). Say so and leave once,
      // instead of a burst of failing calls and a silent logout. A no-op on public pages.
      if (error instanceof AccountsError && error.status === 401 && error.code === 'NO_SESSION') {
        handleSessionEnded();
      }
      // A throttle is not "signed out": it must reach the caller or the credential-clear fires anyway.
      if (error instanceof AccountsError && error.status === 429) throw new RefreshThrottledError();
      // 401 NO_SESSION (signed out / revoked) and every other refusal mean there is no session to keep.
      if (error instanceof AccountsError && error.status === 503) throw new RefreshThrottledError();
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
  disarmProactiveRefresh();
  lastGrant = null;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  // The session is over: nothing is left to refresh, so the next anonymous
  // mount must not read as a session worth probing (#2163) — every piece of
  // evidence goes, or a dead session buys one doomed refresh per page load.
  localStorage.removeItem(SESSION_MARKER_KEY);
  localStorage.removeItem('csrfToken');
  if (typeof document !== 'undefined') {
    for (const c of sessionHintCookieClears()) document.cookie = c;
  }
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

/**
 * Session generation — bumped by every login and every logout.
 *
 * A session check is two to twelve sequential round trips (up to ~21s on the
 * mount ladder below), and nothing used to tie its answer to the session it
 * was asked about. A check that started before a login could land after it
 * and run `clearStoredSession()` over the tokens the login had just written
 * (#2161); one that started before a logout could land after it and
 * re-populate `user` from cookies the logout was about to kill (#2165). A
 * check captures the generation when it starts and, if it has moved by the
 * time an answer arrives, reports `superseded` and touches nothing.
 */
let sessionGeneration = 0;

export function bumpSessionGeneration(): number {
  sessionGeneration += 1;
  return sessionGeneration;
}

/** A `GET /auth/me` outcome, named the same three ways as a refresh — plus
 *  the two answers that say nothing about the session at all. */
export type SessionCheckResult =
  | { status: 'authenticated'; user: unknown }
  | { status: 'signed-out' }
  | { status: 'throttled' }
  /** `/auth/me` failed for a reason that is not "you are signed out" — a
   *  5xx during a deploy, a 404 from a mis-routed edge. Leave `user` as it is
   *  (#2096): only a 401 followed by a rejected refresh ends a session. */
  | { status: 'unavailable' }
  /** A login, a logout or a newer check happened while this one ran; its
   *  answer is about a session that no longer exists. Apply nothing. */
  | { status: 'superseded' };

export interface SessionCheckOptions {
  /** The caller's own staleness signal (e.g. "a newer check has started").
   *  Combined with the session generation. */
  isCurrent?: () => boolean;
}

/**
 * A logout the server may not have received.
 *
 * `logout()` used to treat `POST /auth/logout` as best-effort. When it never
 * reached the API (shop-floor wifi, an installed PWA on a shared tablet) the
 * cookies and the refresh token stayed live, and the very next session check
 * — which now runs on /login too (#1814) — read `/auth/me` 200 and signed the
 * staff member straight back in (#2160). The marker is written BEFORE the
 * request and removed only when the server confirms it; while it is present a
 * session check re-sends the logout instead of restoring anything, and only
 * an explicit login (`clearPendingLogout`) lifts it.
 *
 * The value is the iOS refresh token the logout has to revoke (empty on the
 * cookie path, where the server reads the cookie) — the same value that was
 * already in localStorage a moment earlier.
 */
const PENDING_LOGOUT_KEY = 'pendingLogout';

export function isLogoutPending(): boolean {
  return typeof window !== 'undefined' && localStorage.getItem(PENDING_LOGOUT_KEY) !== null;
}

export function clearPendingLogout(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(PENDING_LOGOUT_KEY);
}

async function postLogout(apiUrl: string, refreshToken: string | null): Promise<boolean> {
  // BOTH ends must confirm: the identity service (revokes the session for every Ebda product) and the Store API (clears its
  // cookie). A logout that reached only one is "pending" and is re-sent.
  const results = await Promise.all([
    accountsLogout().then(
      () => true,
      () => false
    ),
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/auth/logout`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        return res.ok;
      } catch {
        return false;
      }
    })(),
  ]);
  return results.every(Boolean);
}

/**
 * End the session authoritatively. Bumps the generation (so an in-flight
 * check cannot restore it), records the logout as pending, and clears the
 * marker only on a confirmed server answer. Returns whether the server
 * confirmed it.
 */
export async function performLogout(apiUrl: string, refreshToken: string | null): Promise<boolean> {
  bumpSessionGeneration();
  if (typeof window !== 'undefined') localStorage.setItem(PENDING_LOGOUT_KEY, refreshToken ?? '');
  const confirmed = await postLogout(apiUrl, refreshToken);
  if (confirmed) clearPendingLogout();
  return confirmed;
}

async function retryPendingLogout(apiUrl: string): Promise<void> {
  const token = typeof window !== 'undefined' ? localStorage.getItem(PENDING_LOGOUT_KEY) : null;
  if (await postLogout(apiUrl, token || null)) clearPendingLogout();
}

/**
 * A 404 on `/auth/me` that our API itself sent (`{ error: { code: 'NOT_FOUND' } }`):
 * the authenticated user no longer exists (#2283). Any other 404 — an edge or
 * platform page with no API envelope — says nothing about the identity.
 */
async function isAccountGone(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    return body?.error?.code === 'NOT_FOUND';
  } catch {
    return false;
  }
}

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
 *
 * Only a 401 followed by a REJECTED refresh, or a 404 (the user row is
 * gone, #2283), is `signed-out`. A 429 on
 * `/auth/me` is `throttled` (the mount ladder retries it); any other non-ok
 * answer is `unavailable` and leaves the caller's state alone (#2096). Every
 * destructive step re-checks the generation first (#2161).
 */
export async function checkSession(
  apiUrl: string,
  options: SessionCheckOptions = {}
): Promise<SessionCheckResult> {
  const generation = sessionGeneration;
  const stale = () =>
    generation !== sessionGeneration || (options.isCurrent ? !options.isCurrent() : false);

  if (isLogoutPending()) {
    await retryPendingLogout(apiUrl);
    return stale() ? { status: 'superseded' } : { status: 'signed-out' };
  }

  const first = await fetchMe(apiUrl);
  if (stale()) return { status: 'superseded' };
  if (first.ok) {
    const data = await first.json();
    markSessionEvidence();
    return { status: 'authenticated', user: data.data.user };
  }
  // No session was ever here: nothing to wait out and nothing to refresh, so
  // neither the mount ladder nor a credential-less /auth/refresh runs (#2163).
  if (first.status === 429) {
    return hasSessionEvidence() ? { status: 'throttled' } : { status: 'signed-out' };
  }
  // Our API answering 404 is AuthService.getProfile saying the user row is
  // gone — a definitive answer about the identity, not an outage (#2283).
  // Nothing is left to refresh, so the session ends here. A mis-routed 404
  // from the edge carries no API error body and stays `unavailable`.
  if (await isAccountGone(first)) {
    clearStoredSession();
    return { status: 'signed-out' };
  }
  if (first.status !== 401) return { status: 'unavailable' };
  if (!hasSessionEvidence() && !claimSessionProbe()) return { status: 'signed-out' };

  const outcome = await refreshSessionWaitingOutThrottle();
  if (stale()) return { status: 'superseded' };
  if (outcome === 'refreshed') {
    const retry = await fetchMe(apiUrl);
    if (stale()) return { status: 'superseded' };
    if (retry.ok) {
      const data = await retry.json();
      markSessionEvidence();
      return { status: 'authenticated', user: data.data.user };
    }
    if (retry.status === 429) return { status: 'throttled' };
    if (retry.status !== 401 && !(await isAccountGone(retry))) return { status: 'unavailable' };
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

export async function checkSessionWithMountRetries(
  apiUrl: string,
  options: SessionCheckOptions = {}
): Promise<SessionCheckResult> {
  // A superseded ladder stops at its next sleep instead of running its whole
  // budget (#2165): each navigation on the orders PWA starts a new check, and
  // three overlapping ~21s ladders used to post up to 24 refreshes and race
  // each other (and a logout) to setUser.
  const generation = sessionGeneration;
  const stale = () =>
    generation !== sessionGeneration || (options.isCurrent ? !options.isCurrent() : false);
  let result = await checkSession(apiUrl, options);
  for (const delay of MOUNT_RETRY_DELAYS_MS) {
    if (result.status !== 'throttled') break;
    await sleep(delay);
    if (stale()) return { status: 'superseded' };
    result = await checkSession(apiUrl, options);
  }
  return result;
}

/**
 * Make an API request with proper error handling.
 * Authentication is handled automatically via the HTTP-only cookie sent
 * by the browser when `credentials: 'include'` is set.
 */
export async function apiRequest<T = unknown>(
  endpoint: string,
  options: RequestInit & {
    /** An optional widget call: a plan 402/403 must not open the upgrade dialog (the widget just hides). */
    quietUpsell?: boolean;
  } = {}
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
    // store.ebda.app, the API at api.ebda.app —
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
      // Two envelopes exist: `{ error: { code, message, details } }` and the
      // legacy `{ error: 'string', code }`.
      const rawError: unknown = data.error;
      const errObj =
        rawError && typeof rawError === 'object'
          ? (rawError as { code?: string; message?: string; details?: Record<string, unknown> })
          : undefined;
      const errCode: string | undefined =
        errObj?.code ?? (data as unknown as { code?: string }).code;
      const errMessage = errObj?.message ?? (typeof rawError === 'string' ? rawError : undefined);
      // A super-admin who hasn't enrolled in 2FA gets 403 MFA_SETUP_REQUIRED on
      // every protected route. Send them straight to the enrollment page instead
      // of surfacing a dead "failed to load" error. The /account/security page
      // only calls non-gated routes (/auth/me, /auth/mfa/*) so this can't loop.
      // The session was revoked server-side (password change, signed out elsewhere): end it visibly, once.
      if (typeof window !== 'undefined' && errCode === 'TOKEN_REVOKED') handleSessionEnded();
      if (
        typeof window !== 'undefined' &&
        errCode === 'MFA_SETUP_REQUIRED' &&
        window.location.pathname !== '/account/security'
      ) {
        window.location.assign('/account/security');
      }
      let message = localizedApiMessage(
        errCode,
        errMessage || `Request failed with status ${response.status}`,
        errObj?.details
      );
      // A plan-gated call must not hand a page the raw API text (audit G-2): pages render error.message as-is.
      if (
        isPlanGateError({ status: response.status, code: errCode }) &&
        (RAW_STATUS_MESSAGE.test(message) || RAW_PLAN_GATE_MESSAGES.includes(message))
      ) {
        message = PLAN_GATE_FALLBACK[adminUiLocale()];
      }
      if (options.quietUpsell) {
        // optional widget: no dialog
      } else if (response.status === 402) dispatchUpsell(errCode, message, errObj?.details);
      else if (response.status === 403 && errCode === 'FEATURE_DISABLED') {
        // Only when the API says the PLAN withholds it (it names the unlocking sold plan).
        const flat = data as unknown as Record<string, unknown>;
        if (flat.upgradeTo) {
          const text = adminUiLocale() === 'ar' ? flat.messageAr : flat.messageEn;
          if (typeof text === 'string' && text) message = text;
          dispatchUpsell(errCode, message, {
            upgradeTo: flat.upgradeTo,
          });
        }
      }
      return {
        data: null,
        error: {
          code: errCode || 'SERVER_ERROR',
          message,
          status: response.status,
          details: errObj?.details,
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
/**
 * `headers` carries extra request headers; a typed search term goes in `X-Search-Query`
 * (`searchQueryHeaders` from @ebda/shared), never in the URL (Ruling SEARCH-P2-9).
 */
export async function apiGet<T = unknown>(
  endpoint: string,
  headers?: Record<string, string>,
  signal?: AbortSignal
) {
  const init: RequestInit = { method: 'GET' };
  if (headers) init.headers = headers;
  if (signal) init.signal = signal;
  return apiRequest<T>(endpoint, init);
}

/** GET for an optional widget: a plan refusal (402/403) never opens the upgrade dialog. */
export async function apiGetQuiet<T = unknown>(endpoint: string) {
  return apiRequest<T>(endpoint, { method: 'GET', quietUpsell: true });
}

/** The `meta` block list routes return beside `data` (see expenses.routes.ts). */
export interface PageMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/**
 * GET a list route that answers `{ data: items, meta }` and KEEP `meta`.
 * `apiGet` unwraps one layer and drops the sibling `meta`, so a page built on it
 * can show 50 rows with no way to know a 51st exists (issue 2417) — use this
 * wherever the total or page count is shown. Same auth/refresh path as
 * `apiGet` (it rides on `apiFetch`); `meta` is null when the route sent none.
 */
export async function apiGetPage<T = unknown>(
  endpoint: string
): Promise<{ data: T[] | null; meta: PageMeta | null; error: ApiError | null }> {
  try {
    const response = await apiFetch(endpoint, { method: 'GET' });
    let body: {
      data?: T[];
      meta?: PageMeta;
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    } | null = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || !body) {
      return {
        data: null,
        meta: null,
        error: {
          code: body?.error?.code || 'SERVER_ERROR',
          message: localizedApiMessage(
            body?.error?.code,
            body?.error?.message || `Request failed with status ${response.status}`,
            body?.error?.details
          ),
          status: response.status,
          details: body?.error?.details,
        },
      };
    }
    return {
      data: Array.isArray(body.data) ? body.data : [],
      meta: body.meta ?? null,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      meta: null,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Network request failed',
        status: 0,
      },
    };
  }
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
 * The API answers a plan-limit stop with 402 PLAN_LIMIT_REACHED and the text in
 * both languages (`details.messageEn` / `details.messageAr`). Every admin page
 * shows `error.message` as-is, so pick the Arabic text here, once, when the UI
 * is RTL — platform-level, no per-page handling.
 */
/**
 * The admin UI language for error text, read where the UI itself declares it (`<html dir>`).
 * The one source every error reader uses (`localizedApiMessage`, the upload readers, the 3D
 * card's own validation messages) so a toast can never be in a different language from its
 * neighbour. Call it in handlers, not during render (render-time document reads are banned).
 */
export function adminUiLocale(): 'ar' | 'en' {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'ar' : 'en';
}

export function localizedApiMessage(
  _code: string | undefined,
  message: string,
  details: Record<string, unknown> | undefined
): string {
  // Any code whose details carry both-language text is localized (plan limits,
  // subscription gates, go-live gates, ...).
  const text = adminUiLocale() === 'ar' ? details?.messageAr : details?.messageEn;
  return typeof text === 'string' && text ? text : message;
}

export interface UpsellEventDetail {
  code: string;
  message: string;
  upgradeTo: { code: string; nameEn: string; nameAr: string } | string | null;
  limitKey: string | null;
}

/** Tell the shell a 402 happened so it can offer an upgrade (UpsellDialog). */
function dispatchUpsell(
  code: string | undefined,
  message: string,
  details: Record<string, unknown> | undefined
): void {
  if (typeof window === 'undefined') return;
  const upgradeTo = details?.upgradeTo as UpsellEventDetail['upgradeTo'] | undefined;
  window.dispatchEvent(
    new CustomEvent<UpsellEventDetail>('ebda:upsell', {
      detail: {
        code: code ?? 'SERVER_ERROR',
        message,
        upgradeTo: upgradeTo ?? null,
        limitKey: typeof details?.limitKey === 'string' ? details.limitKey : null,
      },
    })
  );
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
