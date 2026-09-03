'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getApiUrl, refreshAccessToken } from './api';

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
    if (typeof window !== 'undefined' && isIosWebkit() && !localStorage.getItem('refreshToken')) {
      return false;
    }
    try {
      const newAccessToken = await refreshAccessToken();
      if (newAccessToken) {
        // On iOS, token rotation writes accessToken + refreshToken +
        // csrfToken to localStorage inside refreshAccessToken(). On other
        // browsers the server rotates the httpOnly cookie in the response.
        return true;
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
    }
    return false;
  }, []);

  const checkAuth = useCallback(async () => {
    try {
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
        const refreshed = await refreshToken();
        if (refreshed) {
          // Re-verify with the new access token so we can set the user object.
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

  useEffect(() => {
    if (pathname === '/login') {
      setIsLoading(false);
      return;
    }
    checkAuth();
  }, [checkAuth, pathname]);

  useEffect(() => {
    if (!isLoading && !user && pathname !== '/login') {
      router.push('/login');
    }
  }, [isLoading, user, pathname, router]);

  function storeSession(data: {
    user: AuthUser;
    accessToken?: string;
    refreshToken: string;
    csrfToken?: string;
  }) {
    // Only persist tokens to localStorage on iOS/iPadOS WebKit, where the
    // cross-origin httpOnly cookie is unreliable for installed PWAs (ITP
    // purges it). On all other browsers auth rides the httpOnly cookie and
    // writing tokens to localStorage would expose them to XSS unnecessarily.
    if (isIosWebkit()) {
      if (data.accessToken) localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
    }
    // The CSRF token is stored on EVERY platform, not just iOS: it is a
    // double-submit token, meant to be JS-readable, and a session without it
    // cannot make a state-changing request. Admin and orders are safe today
    // only because they sit on PLATFORM origins, which remain CSRF-exempt —
    // this is the same latent defect that broke storefront writes on merchant
    // custom domains, fixed here so the copies cannot diverge again.
    if (data.csrfToken) localStorage.setItem('csrfToken', data.csrfToken);
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

    // MFA challenge: API returns { mfaRequired: true, challengeToken } instead of
    // tokens. Surface it to the login page so it can show the code-entry step.
    // (Staff enroll 2FA in the full admin; here we only complete the challenge.)
    if (data.data?.mfaRequired) {
      return { mfaRequired: true, challengeToken: data.data.challengeToken };
    }

    if (!ADMIN_ROLES.includes(data.data.user.role)) {
      throw new Error('ADMIN_ONLY');
    }

    storeSession(data.data);
    router.push('/orders');
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

    if (!ADMIN_ROLES.includes(data.data.user.role)) {
      throw new Error('ADMIN_ONLY');
    }

    storeSession(data.data);
    router.push('/orders');
  }

  async function logout() {
    const refreshTokenValue =
      typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshTokenValue }),
    }).catch(() => {
      // best-effort
    });
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('csrfToken');
    setUser(null);
    router.push('/login');
  }

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAuthenticated: !!user, login, completeMfaLogin, logout }}
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
