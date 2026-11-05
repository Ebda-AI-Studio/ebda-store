'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
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
} from './api';
import { signInMessageKey } from './sign-in-error';
import { AccountsError, accountsLogin, accountsLoginMfa, establishApiSession } from './accounts';

/**
 * Returns true on iOS/iPadOS Safari/WebKit — the only browsers where
 * the cross-origin auth cookie is unreliable for installed PWAs (ITP
 * purges it). On all other browsers the httpOnly cookie carries the
 * session and tokens must NOT be persisted to localStorage (JS-readable,
 * XSS exposure).
 */
function isIosWebkit(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iP(hone|ad|od)/i.test(navigator.userAgent)) return true;
  // iPadOS 13+ desktop-mode fingerprint (Apple's documented detection)
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'store_admin' | 'staff' | 'customer';
  /** Forward-compat: explicit per-staff permission array once the API returns one. */
  permissions?: string[];
}

/** Returned by login() when the account has 2FA enabled — the caller must then
 *  collect a TOTP/backup code and call completeMfaLogin(). */
export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void | MfaChallenge>;
  completeMfaLogin: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_URL = `${getApiUrl()}/api/v1`;

// The Orders PWA is a staff tool: store_admin/super_admin own it, and `staff`
// members (StoreStaff) are provisioned specifically to run it. Customers are
// rejected (ADMIN_ONLY). Without `staff` here, a freshly created staff account
// could never log in.
const ADMIN_ROLES = ['super_admin', 'store_admin', 'staff'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  // Id of the newest checkAuth run. This provider re-checks on every
  // navigation (#1814), so several checks can be in flight at once; only the
  // newest may touch state, and an older ladder stops at its next sleep
  // (#2165). Logins and logouts invalidate every in-flight check through the
  // session generation in api.ts (#2161, #2160).
  const latestCheckRef = useRef(0);

  // Silent refresh using the long-lived rotating refresh token. Delegates to
  // the SAME single-flight refreshAccessToken() used by apiRequest() in
  // api.ts so concurrent callers (checkAuth + a 401-retry from an in-flight
  // API request) share ONE /auth/refresh rotation instead of racing and
  // tripping the server-side reuse-detection.
  const refreshToken = useCallback(async (): Promise<boolean> => {
    // On iOS/iPadOS the refresh token lives in localStorage (the httpOnly
    // cookie is unreliable). Bail out if iOS has no localStorage token.
    // On all other browsers the refresh token rides in the refresh_token
    // httpOnly cookie — do NOT bail out early when localStorage is empty;
    // the server reads it from the cookie via credentials:'include'.
    if (typeof window !== 'undefined' && isIosWebkit() && !readStoredRefreshToken(true)) {
      return false;
    }
    // The context's own contract stays boolean — only 'refreshed' is a
    // success. checkAuth needs the third outcome and calls refreshSession()
    // directly.
    return (await refreshSession()) === 'refreshed';
  }, []);

  const checkAuth = useCallback(async () => {
    const checkId = ++latestCheckRef.current;
    const isCurrent = () => latestCheckRef.current === checkId;
    try {
      // checkSessionWithMountRetries owns the full /auth/me -> throttle-retry
      // decision (api.ts) so it is unit-testable without rendering this
      // component (no jsdom in this repo — Ruling P2-B2-2/P2-B2-7). It stays
      // 'throttled' — and this call keeps awaiting — for up to
      // MOUNT_RETRY_DELAYS_MS's budget before giving up, so `isLoading` below
      // stays true throughout and the redirect-to-/login effect cannot fire
      // on a throttle that clears within that window (#1782). If it never
      // clears, the credential still survives (never cleared on 'throttled')
      // and the user lands on /login, where a re-check now actually runs
      // instead of being a dead end (#1814).
      //
      // 'unavailable' (a 5xx/404 on /auth/me) and 'superseded' (a login,
      // logout or newer check happened meanwhile) leave `user` untouched: only
      // a 401 followed by a rejected refresh signs anyone out (#2096).
      const result = await checkSessionWithMountRetries(API_URL, { isCurrent });
      if (result.status === 'authenticated') {
        setUser(result.user as AuthUser);
      } else if (result.status === 'signed-out') {
        setUser(null);
      }
    } catch (error) {
      console.error('Auth check failed:', error);
    } finally {
      // A superseded check leaves the loading flag to the newest one.
      if (isCurrent()) setIsLoading(false);
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

  // Re-check on every navigation, /login included (#1814, correcting the
  // once-per-mount guard #1802 briefly added here): the login page's own
  // "already signed in → go straight to orders" effect below is what turns a
  // check that resolves here into a redirect, but that only ever gets a
  // chance to fire if the check actually runs on this route. checkAuth is
  // now bounded by checkSessionWithMountRetries's own retry ladder (see
  // above), and a navigation SUPERSEDES the previous check (latestCheckRef):
  // the older ladder stops at its next sleep and never applies its answer,
  // so overlapping navigations cannot stack ladders or race each other, a
  // login or a logout to setUser (#2165).
  useEffect(() => {
    checkAuth();
  }, [checkAuth, pathname]);

  useEffect(() => {
    if (!isLoading && !user && pathname !== '/login') {
      router.push('/login');
    }
  }, [isLoading, user, pathname, router]);

  function storeSession(data: { user: AuthUser; csrfToken?: string }) {
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
    if (data.csrfToken) localStorage.setItem('csrfToken', data.csrfToken);
    setUser(data.user);
  }

  /** Exchange an identity-service access token for the Store session and finish signing in. */
  async function finishSignIn(accessToken: string): Promise<void> {
    const user = await establishApiSession<AuthUser>(accessToken);
    if (!ADMIN_ROLES.includes(user.role)) {
      throw new Error('ADMIN_ONLY');
    }
    storeSession({ user });
    router.push('/orders');
  }

  /** The page owns the wording (and the language): throw a CODE, never the service's raw English (audit A-1). */
  function signInError(e: unknown, _fallback: string): Error {
    if (e instanceof AccountsError) return new Error(signInMessageKey(e.status, e.code));
    return new Error('serverError');
  }

  async function login(email: string, password: string): Promise<void | MfaChallenge> {
    let result;
    try {
      result = await accountsLogin(email, password);
    } catch (e) {
      throw signInError(e, 'Login failed');
    }
    // MFA challenge: surface it to the login page so it can show the code-entry step.
    // (Staff enroll 2FA in the full admin; here we only complete the challenge.)
    if (result.mfaRequired) {
      return { mfaRequired: true, challengeToken: result.challenge };
    }
    await finishSignIn(result.access_token);
  }

  async function completeMfaLogin(challengeToken: string, code: string): Promise<void> {
    let grant;
    try {
      grant = await accountsLoginMfa(challengeToken, code);
    } catch (e) {
      throw signInError(e, 'Verification failed');
    }
    await finishSignIn(grant.access_token);
  }

  async function logout() {
    // iOS-gated like every other refresh-token read (#1945): elsewhere the
    // token rides the httpOnly cookie, which the server revokes when the body
    // carries none — a leftover localStorage value would be revoked instead.
    // readStoredRefreshToken also REMOVES a non-iOS residue copy (#2034).
    const refreshTokenValue =
      typeof window !== 'undefined' ? readStoredRefreshToken(isIosWebkit()) : null;
    // Authoritative, not best-effort (#2160): performLogout bumps the session
    // generation so no in-flight check can restore the session, and records
    // the logout as pending until the server confirms it. While it is pending
    // every session check re-sends it instead of reading /auth/me, so a logout
    // that never reached the API cannot be undone by the /login re-check.
    await performLogout(API_URL, refreshTokenValue);
    // accessToken + refreshToken + the session-evidence marker (#2163).
    clearStoredSession();
    localStorage.removeItem('csrfToken');
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
