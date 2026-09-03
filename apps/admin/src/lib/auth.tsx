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
import { getApiUrl, refreshAccessToken } from './api';
import { isIosWebkit, safeInternalPath } from '@force/shared';

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
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_URL = `${getApiUrl()}/api/v1`;

export function AuthProvider({ children }: { children: ReactNode }) {
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
    // cookie is unreliable for installed PWAs). Bail out if iOS has no
    // localStorage token — there is nothing to exchange.
    // On all other browsers the refresh token rides in the refresh_token
    // httpOnly cookie (sent automatically via credentials:'include'), so
    // we DO NOT bail out early when localStorage is empty — let the server
    // read it from the cookie. The /auth/refresh route accepts either.
    if (typeof window !== 'undefined' && isIosWebkit() && !localStorage.getItem('refreshToken')) {
      return false;
    }
    try {
      const newAccessToken = await refreshAccessToken();
      return newAccessToken !== null;
    } catch (error) {
      console.error('Token refresh failed:', error);
      return false;
    }
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      // Send the Bearer token from localStorage when available — required
      // for the iOS PWA path where Safari/WebKit purges the cross-origin
      // cookie. The cookie is still sent via credentials:'include' as a
      // fallback for browsers that can rely on it (Mac Chrome, etc.).
      const accessToken =
        typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
      const headers: Record<string, string> = {};
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      const response = await fetch(`${API_URL}/auth/me`, {
        credentials: 'include',
        headers,
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.data.user);
      } else if (response.status === 401) {
        // Access token is dead (expired or never set on this device).
        // refreshToken() delegates to the same single-flight in api.ts so
        // this path and any concurrent apiRequest 401-retries share ONE
        // rotation instead of racing and tripping reuse-detection.
        const refreshed = await refreshToken();
        if (refreshed) {
          // Re-verify with the new access token to populate user state.
          const newAccessToken =
            typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
          const retryHeaders: Record<string, string> = {};
          if (newAccessToken) retryHeaders.Authorization = `Bearer ${newAccessToken}`;
          const retryResponse = await fetch(`${API_URL}/auth/me`, {
            credentials: 'include',
            headers: retryHeaders,
          });
          if (retryResponse.ok) {
            const retryData = await retryResponse.json();
            setUser(retryData.data.user);
          } else {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
          }
        } else {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
        }
      }
    } catch (error) {
      console.error('Auth check failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, [refreshToken]);

  // Request persistent storage so iOS ITP doesn't evict localStorage (and the
  // refresh token) after ~7 days of inactivity. Best-effort: no-ops on
  // unsupported browsers, never throws.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }, []);

  // Check auth ONCE on mount (skip on login page — no session to check).
  // We deliberately do NOT include `pathname` in the dependency array:
  // re-running /auth/me on every navigation is wasteful and, worse, creates
  // a race where the checkAuth refresh and the api.ts 401-retry refresh fire
  // concurrently, rotate the same token twice, and trip reuse-detection →
  // instant logout. In-memory `user` state already reflects the session;
  // individual API calls handle their own 401→refresh→retry via api.ts.
  useEffect(() => {
    if (pathname === '/login') {
      setIsLoading(false);
      return;
    }
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
    if (!isLoading && !user && pathname !== '/login') {
      const here =
        typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}`
          : pathname;
      const returnTo = here && here !== '/' ? `?returnTo=${encodeURIComponent(here)}` : '';
      router.push(`/login${returnTo}`);
    }
  }, [isLoading, user, pathname, router]);

  /**
   * Post-login destination: honor a validated internal ?returnTo= (set by the
   * session-kick redirect above) so a re-authenticating user lands back where
   * they were. `safeInternalPath` rejects offsite targets (absolute,
   * protocol-relative `//host`, AND backslash tricks `/\host` that a naive
   * `startsWith('//')` guard misses); we additionally reject the /login page
   * itself to avoid a redirect loop.
   */
  function postLoginDestination(): string {
    if (typeof window === 'undefined') return '/';
    const raw = new URLSearchParams(window.location.search).get('returnTo');
    const dest = safeInternalPath(raw, '/');
    if (dest === '/login' || dest.startsWith('/login/') || dest.startsWith('/login?')) {
      return '/';
    }
    return dest;
  }

  /** Shared token-storage logic used by both normal login and MFA completion. */
  function storeSession(data: {
    user: User;
    accessToken?: string;
    refreshToken: string;
    csrfToken?: string;
  }) {
    // Only persist tokens to localStorage on iOS/iPadOS WebKit, where the
    // cross-origin httpOnly cookie is unreliable for installed PWAs (ITP
    // purges it). On all other browsers (desktop Chrome/Firefox, Android
    // Chrome) auth rides the httpOnly cookie and we must NOT write tokens
    // to localStorage — they are JS-readable and expose them to XSS.
    if (isIosWebkit()) {
      if (data.accessToken) {
        localStorage.setItem('accessToken', data.accessToken);
      }
      localStorage.setItem('refreshToken', data.refreshToken);
    }
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
    document.cookie = 'force-session=1; path=/; max-age=' + 30 * 24 * 60 * 60 + '; SameSite=Lax';
    setUser(data.user);
  }

  async function login(email: string, password: string): Promise<void | MfaChallenge> {
    const response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Server returned an invalid response. Please try again.');
    }

    if (!response.ok) {
      throw new Error(data.error?.message || 'Login failed');
    }

    // MFA challenge: API returns { mfaRequired: true, challengeToken } instead
    // of tokens. Surface this to the login page so it can show the code-entry step.
    if (data.data?.mfaRequired) {
      return { mfaRequired: true, challengeToken: data.data.challengeToken } as MfaChallenge;
    }

    // Check if user is admin or staff
    const adminRoles = ['super_admin', 'store_admin', 'staff'];
    if (!adminRoles.includes(data.data.user.role)) {
      throw new Error('Access denied. Admin or staff privileges required.');
    }

    // Mirror the access token into localStorage for the iOS PWA path —
    // Safari/WebKit purges third-party cookies (the API is on a
    // different parent domain than the admin) so cookie-only auth
    // doesn't survive PWA backgrounding. lib/api.ts sends this token
    // as `Authorization: Bearer` on every request.
    storeSession(data.data);
    router.push(postLoginDestination());
  }

  async function completeMfaLogin(challengeToken: string, code: string): Promise<void> {
    const response = await fetch(`${API_URL}/auth/mfa/verify`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, code }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Server returned an invalid response. Please try again.');
    }

    if (!response.ok) {
      throw new Error(data.error?.message || 'Verification failed');
    }

    const adminRolesMfa = ['super_admin', 'store_admin', 'staff'];
    if (!adminRolesMfa.includes(data.data.user.role)) {
      throw new Error('Access denied. Admin or staff privileges required.');
    }

    storeSession(data.data);
    router.push(postLoginDestination());
  }

  async function logout() {
    const refreshTokenValue = localStorage.getItem('refreshToken');

    // Invalidate the refresh token server-side before clearing local state.
    // The API also clears the HTTP-only auth cookie in its response.
    // Awaiting ensures the token is revoked before we redirect, preventing
    // a window where a stolen token could still be used to obtain new access.
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshTokenValue }),
    }).catch(() => {
      // Best-effort: if the server is unreachable we still clear local state
    });

    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('csrfToken');
    // Clear session indicator cookie
    document.cookie = 'force-session=; path=/; max-age=0';
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
