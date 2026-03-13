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

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
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
        // The new access token is set as an HTTP-only cookie by the API.
        // Store the new refresh token in localStorage (not sensitive the
        // same way since it can only be used once and is paired with the
        // server-side record).
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
      // The HTTP-only cookie is sent automatically with credentials: 'include'.
      // No need to check localStorage for a token first.
      const response = await fetch(`${API_URL}/auth/me`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.data.user);
      } else if (response.status === 401) {
        // Try to refresh token
        const refreshed = await refreshToken();
        if (!refreshed) {
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

  async function login(email: string, password: string) {
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

    // Check if user is admin
    if (data.data.user.role !== 'super_admin' && data.data.user.role !== 'store_admin') {
      throw new Error('Access denied. Admin privileges required.');
    }

    // The access token is set as an HTTP-only cookie by the API response.
    // Only store the refresh token in localStorage.
    localStorage.setItem('refreshToken', data.data.refreshToken);
    setUser(data.data.user);
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

    localStorage.removeItem('refreshToken');
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

// HOC for protected pages
export function withAuth<P extends object>(Component: React.ComponentType<P>) {
  return function ProtectedComponent(props: P) {
    const { user, isLoading } = useAuth();

    if (isLoading) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      );
    }

    if (!user) {
      return null; // Will redirect via useEffect
    }

    return <Component {...props} />;
  };
}
