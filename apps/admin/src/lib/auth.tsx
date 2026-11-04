'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  getApiUrl,
  refreshSession,
  checkSessionWithMountRetries,
  bumpSessionGeneration,
  clearPendingLogout,
  performLogout,
  readStoredRefreshToken,
  markSessionEvidence,
  clearStoredSession,
  rememberGrant,
} from './api';
import {
  isIosWebkit,
  safeInternalPath,
  sessionHintCookieClears,
  sessionHintCookieSet,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { FOCUS_MODE_STORAGE_KEY } from '@/lib/focus-mode-key';
import { passkeyAssertion, type PasskeyMode } from './passkeys';
import { signInMessageKey } from './sign-in-error';
import { safeSignInReturn } from './sign-in-return';
import { PUBLIC_PATHS } from './public-paths';
import {
  AccountsError,
  accountsLogin,
  accountsLoginMfa,
  accountsLogout,
  establishApiSession,
} from './accounts';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'store_admin' | 'staff' | 'customer';
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void | MfaChallenge>;
  completeMfaLogin: (challengeToken: string, code: string) => Promise<void>;
  /** Sign in with a passkey. A passkey satisfies MFA (Ruling PASSKEY-4): no code step follows. */
  loginWithPasskey: (mode: PasskeyMode) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_URL = `${getApiUrl()}/api/v1`;

/**
 * Post-login destination: honor a validated internal ?returnTo= (set by the
 * session-kick redirect below) so a re-authenticating user lands back where
 * they were. `safeInternalPath` rejects offsite targets (absolute,
 * protocol-relative `//host`, AND backslash tricks `/\host` that a naive
 * `startsWith('//')` guard misses); we additionally reject the /login page
 * itself to avoid a redirect loop.
 *
 * A plain module-level function (no hooks) so the login page can also call it
 * — needed once that page redirects away on an already/newly-authenticated
 * session (see #1814: the mount check now runs on /login too, and this is
 * where a recovered session sends the user).
 */
export function postLoginDestination(): string {
  if (typeof window === 'undefined') return '/';
  // Another Ebda product (Chat) sent the person here with ?return=<url>: honored ONLY for an https URL on the explicit
  // host allowlist (Ruling SIGNIN-RETURN-1); the result is an absolute URL, which `goAfterSignIn` navigates to.
  const external = safeSignInReturn(new URLSearchParams(window.location.search).get('return'));
  if (external) return external;
  const raw = new URLSearchParams(window.location.search).get('returnTo');
  const dest = safeInternalPath(raw, '/');
  if (dest === '/login' || dest.startsWith('/login/') || dest.startsWith('/login?')) {
    return '/';
  }
  return dest;
}

/** Go where `postLoginDestination()` said: an absolute https URL leaves the app, anything else is an in-app route. */
export function goAfterSignIn(
  router: { push: (href: string) => void; replace: (href: string) => void },
  dest: string,
  how: 'push' | 'replace' = 'push'
): void {
  if (/^https:\/\//i.test(dest)) window.location.assign(dest);
  else router[how](dest);
}

export { PUBLIC_PATHS } from './public-paths';

/** Dev-only visual previews (no session needed). Empty in production builds. */
export const DEV_PREVIEW_PATHS: readonly string[] =
  process.env.NODE_ENV === 'development' ? ['/dev-preview/order-alerts'] : [];

export function isPublicPath(pathname: string | null | undefined): boolean {
  const p = pathname ? pathname.replace(/\/+$/, '') || '/' : '';
  return !!p && (PUBLIC_PATHS.includes(p) || DEV_PREVIEW_PATHS.includes(p));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const t = useT('auth.login');
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  // Track whether the initial auth check has run so we only hit /auth/me
  // once on mount — not on every pathname change. Subsequent navigations
  // trust the in-memory user state; the 401-refresh path in api.ts handles
  // keeping the access token alive for individual requests.
  const authCheckedRef = useRef(false);

  // Delegate to the SAME single-flight refreshAccessToken() used by
  // apiRequest() in api.ts so concurrent callers (checkAuth on mount +
  // a 401-retry from an in-flight API request) share ONE /auth/refresh
  // rotation instead of racing and tripping server-side reuse-detection.
  // The module-level refreshInFlight in api.ts IS the single-flight guard —
  // no separate ref is needed here.
  const refreshToken = useCallback(async (): Promise<boolean> => {
    // On iOS/iPadOS the refresh token lives in localStorage (the httpOnly
    // cookie is unreliable for installed PWAs); elsewhere it rides in the
    // refresh_token httpOnly cookie. /auth/refresh accepts either, and is
    // called even when iOS has no stored token: a browser holding dead session
    // cookies gets them cleared by that request and by nothing else (#1531).
    // The context's own contract stays boolean — only 'refreshed' is a
    // success. checkAuth needs the third outcome and calls refreshSession()
    // directly.
    return (await refreshSession()) === 'refreshed';
  }, []);

  // The mount check can outlive the component (retry delays, a slow /auth/me): a state update after unmount is dropped, and in
  // a torn-down jsdom it threw 'window is not defined' as an unhandled rejection that failed a whole CI run.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      // checkSessionWithMountRetries owns the full /auth/me -> throttle-retry
      // decision (api.ts) so it is unit-testable without rendering this
      // component (no jsdom in this repo — Ruling P2-B2-2/P2-B2-7). It stays
      // 'throttled' — and this call keeps awaiting — for up to
      // MOUNT_RETRY_DELAYS_MS's budget before giving up, so `isLoading` below
      // stays true throughout and the redirect-to-/login effect cannot fire
      // on a throttle that clears within that window (#1782). If it never
      // clears, the credential still survives (never cleared on 'throttled')
      // and the user lands on /login, where a full reload now actually
      // re-checks instead of being a dead end (#1814).
      //
      // 'unavailable' (a 5xx/404 on /auth/me) and 'superseded' (a login or
      // logout happened meanwhile) leave `user` untouched: only a 401 followed
      // by a rejected refresh signs anyone out (#2096, #2161).
      const result = await checkSessionWithMountRetries(API_URL);
      if (!aliveRef.current) return;
      if (result.status === 'authenticated') {
        setUser(result.user as User);
      } else if (result.status === 'signed-out') {
        setUser(null);
      }
    } catch (error) {
      console.error('Auth check failed:', error);
    } finally {
      if (aliveRef.current) setIsLoading(false);
    }
  }, []);

  // Request persistent storage so iOS ITP doesn't evict localStorage (and the
  // refresh token) after ~7 days of inactivity. Best-effort: no-ops on
  // unsupported browsers, never throws.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }, []);

  // Check auth ONCE on mount, on EVERY route including /login. We
  // deliberately do NOT include `pathname` in the dependency array:
  // re-running /auth/me on every navigation is wasteful and, worse, creates
  // a race where the checkAuth refresh and the api.ts 401-retry refresh fire
  // concurrently, rotate the same token twice, and trip reuse-detection →
  // instant logout. In-memory `user` state already reflects the session;
  // individual API calls handle their own 401→refresh→retry via api.ts.
  //
  // This used to skip the check entirely when the mount pathname was
  // /login ("no session to check"), which was the actual bug in #1814: a
  // throttled checkAuth on a PROTECTED route leaves the refresh token intact
  // and routes here, and the documented recovery — "a reload signs you back
  // in without a password" — never ran, because reloading /login is exactly
  // the mount this skip suppressed. On a genuinely-anonymous /login visit the
  // check costs ONE /auth/me: with no session evidence in this browser it
  // never posts /auth/refresh and never enters the throttle ladder (#2163 —
  // it used to, feeding the shared anon refresh bucket up to 8× per load). On
  // a real surviving session it lets the login page redirect the user
  // straight into the app instead of showing them a password form.
  useEffect(() => {
    if (authCheckedRef.current) return;
    authCheckedRef.current = true;
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redirect if not authenticated. Carry the current location as ?returnTo=
  // so re-authenticating lands the user back on the page (and query) they
  // were kicked from, not the dashboard. Intentional logout() pushes a bare
  // /login — only the unauthenticated kick preserves location.
  useEffect(() => {
    if (!isLoading && !user && !isPublicPath(pathname)) {
      const here =
        typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}`
          : pathname;
      const returnTo = here && here !== '/' ? `?returnTo=${encodeURIComponent(here)}` : '';
      router.push(`/login${returnTo}`);
    }
  }, [isLoading, user, pathname, router]);

  /** Shared token-storage logic used by both normal login and MFA completion. */
  function storeSession(data: { user: User; csrfToken?: string }) {
    // A fresh session: any check still in flight is about the old one and
    // must not clear these tokens when it lands (#2161). An explicit login is
    // also what lifts a pending (unconfirmed) logout.
    bumpSessionGeneration();
    clearPendingLogout();
    // The anonymous-mount gate's evidence that a session exists here (#2163).
    markSessionEvidence();
    // No token is persisted in JS: the session is the identity service's HttpOnly cookie plus the Store API's own.
    // The CSRF token is stored on EVERY platform, not just iOS: it is a
    // double-submit token, meant to be JS-readable, and a session without it
    // cannot make a state-changing request. Admin and orders are safe today
    // only because they sit on PLATFORM origins, which remain CSRF-exempt —
    // this is the same latent defect that broke storefront writes on merchant
    // custom domains, fixed here so the copies cannot diverge again.
    if (data.csrfToken) {
      localStorage.setItem('csrfToken', data.csrfToken);
    }
    // Set session indicator cookie so middleware can gate admin pages. 30
    // days is the "looks signed in" hint window — the real session lasts as
    // long as the refresh token (the access token is short-lived and silently
    // rotates), so this is just a UX hint, not the auth source of truth.
    document.cookie = sessionHintCookieSet(30 * 24 * 60 * 60);
    setUser(data.user);
  }

  /** Exchange an identity-service access token for the Store session and finish signing in. */
  async function finishSignIn(accessToken: string, enrollSecondFactor = false): Promise<void> {
    const user = await establishApiSession<User>(accessToken);
    // Check if user is admin or staff BEFORE anything is armed: a refused customer must not keep a live refresh timer.
    const adminRoles = ['super_admin', 'store_admin', 'staff'];
    if (!adminRoles.includes(user.role)) {
      // End both sessions the sign-in just created (best effort); the accessDenied message still reaches the page.
      clearStoredSession();
      await Promise.allSettled([performLogout(API_URL, null), accountsLogout(accessToken)]);
      throw new Error(t('accessDenied'));
    }
    rememberGrant({ access_token: accessToken });
    storeSession({ user });
    // A platform admin without a second factor has no admin power yet (Ruling ID-15): send them to enrol one.
    // A platform admin who must enrol a second factor does that first; the Chat return is not honoured over it.
    goAfterSignIn(router, enrollSecondFactor ? '/account/security' : postLoginDestination());
  }

  /** Map an identity-service refusal to the page's existing messages. */
  function signInError(e: unknown, fallback: string): Error {
    if (e instanceof AccountsError) {
      // Our own sentence for every refusal; the service's raw English never reaches the page (audit A-1).
      return new Error(t(signInMessageKey(e.status, e.code)));
    }
    // A network failure ('Failed to fetch') is not a sentence for a merchant either.
    return new Error(fallback);
  }

  async function login(email: string, password: string): Promise<void | MfaChallenge> {
    let result;
    try {
      result = await accountsLogin(email, password);
    } catch (e) {
      throw signInError(e, t('loginFailed'));
    }
    // MFA challenge: surface it to the login page so it can show the code-entry step.
    if (result.mfaRequired) {
      return { mfaRequired: true, challengeToken: result.challenge } as MfaChallenge;
    }
    // A platform admin who has a passkey cannot sign in with the password alone: the server made no session; say so.
    if (result.secondFactorRequired) throw new Error(t('adminNeedsSecondFactor'));
    await finishSignIn(result.access_token, result.mfaEnrollmentRequired === true);
  }

  async function completeMfaLogin(challengeToken: string, code: string): Promise<void> {
    let grant;
    try {
      grant = await accountsLoginMfa(challengeToken, code);
    } catch (e) {
      throw signInError(e, t('mfaVerifyFailed'));
    }
    await finishSignIn(grant.access_token);
  }

  async function loginWithPasskey(mode: PasskeyMode): Promise<void> {
    const { access_token } = await passkeyAssertion(mode);
    await finishSignIn(access_token);
  }

  async function logout() {
    // iOS-gated like every other refresh-token read (#1945): elsewhere the
    // token rides the httpOnly cookie, which the server revokes when the body
    // carries none — a leftover localStorage value would be revoked instead.
    // readStoredRefreshToken also REMOVES a non-iOS residue copy (#2034).
    const refreshTokenValue =
      typeof window !== 'undefined' ? readStoredRefreshToken(isIosWebkit()) : null;

    // Invalidate the refresh token server-side before clearing local state.
    // The API also clears the HTTP-only auth cookie in its response.
    // Authoritative, not best-effort (#2160): performLogout bumps the session
    // generation so no in-flight check can restore the session, and records
    // the logout as pending until the server confirms it. While it is pending
    // every session check (a reload of /login included) re-sends it instead of
    // reading /auth/me, so a logout that never reached the API cannot be
    // undone by the cookies it failed to clear.
    await performLogout(API_URL, refreshTokenValue);

    // accessToken + refreshToken + the session-evidence marker (#2163).
    clearStoredSession();
    localStorage.removeItem('csrfToken');
    // A second admin signing into this device otherwise inherited whichever
    // store the previous admin last focused — FocusModeContext restores it
    // from localStorage on mount with no per-user validation.
    localStorage.removeItem(FOCUS_MODE_STORAGE_KEY);
    // Clear session indicator cookie
    for (const c of sessionHintCookieClears()) document.cookie = c;
    setUser(null);
    router.push('/login');
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        completeMfaLogin,
        loginWithPasskey,
        logout,
        refreshToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
