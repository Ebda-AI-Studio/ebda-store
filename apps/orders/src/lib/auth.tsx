'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getApiUrl } from './api';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'store_admin' | 'staff' | 'customer';
  /** Forward-compat: explicit per-staff permission array once the API returns one. */
  permissions?: string[];
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
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

  // Silent refresh using the long-lived rotating refresh token. Independent of
  // cookie state — required for the iOS PWA path where WebKit purges the
  // cross-origin cookie.
  const refreshToken = useCallback(async (): Promise<boolean> => {
    const refreshTokenValue =
      typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
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
        if (data.data?.accessToken) localStorage.setItem('accessToken', data.data.accessToken);
        if (data.data?.refreshToken) localStorage.setItem('refreshToken', data.data.refreshToken);
        if (data.data?.csrfToken) localStorage.setItem('csrfToken', data.data.csrfToken);
        if (data.data?.user) setUser(data.data.user);
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
    if (data.accessToken) localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    if (data.csrfToken) localStorage.setItem('csrfToken', data.csrfToken);
    setUser(data.user);
  }

  async function login(email: string, password: string): Promise<void> {
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

    // This app does not handle MFA enrollment — staff enroll via the full admin.
    // If the API returns an MFA challenge, surface a clear message rather than
    // a half-finished flow.
    if (data.data?.mfaRequired) {
      throw new Error('Two-factor authentication is required. Complete it in the admin app first.');
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
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, logout }}>
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
