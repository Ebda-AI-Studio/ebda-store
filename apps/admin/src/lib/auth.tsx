'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getApiUrl } from './api';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'store_admin' | 'customer';
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

  const refreshToken = useCallback(async (): Promise<boolean> => {
    const refreshTokenValue = localStorage.getItem('refreshToken');
    if (!refreshTokenValue) return false;

    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshTokenValue }),
      });

      if (response.ok) {
        const data = await response.json();
        // The new access token is set as an HTTP-only cookie by the API
        // for browser-cookie clients, AND returned in the body so we can
        // mirror it into localStorage for the iOS PWA path (where WebKit
        // purges third-party cookies). lib/api.ts reads `accessToken`
        // from localStorage and sends it as `Authorization: Bearer`.
        if (data.data.accessToken) {
          localStorage.setItem('accessToken', data.data.accessToken);
        }
        if (data.data.refreshToken) {
          localStorage.setItem('refreshToken', data.data.refreshToken);
        }
        setUser(data.data.user);
        return true;
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
    }

    return false;
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
        // Try the refresh flow, which uses the long-lived refresh token
        // from localStorage and is independent of cookie state.
        const refreshed = await refreshToken();
        if (!refreshed) {
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

  // Check auth on mount (skip on login page — no session to check)
  useEffect(() => {
    if (pathname === '/login') {
      setIsLoading(false);
      return;
    }
    checkAuth();
  }, [checkAuth, pathname]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!isLoading && !user && pathname !== '/login') {
      router.push('/login');
    }
  }, [isLoading, user, pathname, router]);

  /** Shared token-storage logic used by both normal login and MFA completion. */
  function storeSession(data: {
    user: User;
    accessToken?: string;
    refreshToken: string;
    csrfToken?: string;
  }) {
    if (data.accessToken) {
      localStorage.setItem('accessToken', data.accessToken);
    }
    localStorage.setItem('refreshToken', data.refreshToken);
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

    // Check if user is admin
    if (data.data.user.role !== 'super_admin' && data.data.user.role !== 'store_admin') {
      throw new Error('Access denied. Admin privileges required.');
    }

    // Mirror the access token into localStorage for the iOS PWA path —
    // Safari/WebKit purges third-party cookies (the API is on a
    // different parent domain than the admin) so cookie-only auth
    // doesn't survive PWA backgrounding. lib/api.ts sends this token
    // as `Authorization: Bearer` on every request.
    storeSession(data.data);
    router.push('/');
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

    if (data.data.user.role !== 'super_admin' && data.data.user.role !== 'store_admin') {
      throw new Error('Access denied. Admin privileges required.');
    }

    storeSession(data.data);
    router.push('/');
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
