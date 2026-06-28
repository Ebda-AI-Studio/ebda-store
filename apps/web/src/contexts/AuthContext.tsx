'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api, type User } from '../lib/api';
import { useStore } from './StoreContext';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }) => Promise<{ success: boolean; verifyEmailRequired?: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // The current tenant. Customer registrations + logins must be scoped to
  // this store so a single email can belong to different accounts on
  // different storefronts (the schema's `@@unique([storeId, email])`).
  const { store } = useStore();

  const refreshUser = useCallback(async () => {
    // Auth is handled via HTTP-only cookies sent automatically with
    // credentials: 'include'. The cookie is scoped to the API domain
    // (api.force-ai.co), so an admin signed in at
    // app.forcemediakw.com sends the SAME cookie to /auth/me when the
    // storefront calls it — making the storefront think the admin is
    // a logged-in customer.
    //
    // Guard: only treat the response as a customer if the role is
    // explicitly 'customer'. Admin/super_admin tokens are rejected here
    // so the storefront UI never accidentally shows merchant info as
    // the customer's profile.
    try {
      const result = await api.getProfile();
      if (result.success && result.data && result.data.user.role === 'customer') {
        setUser(result.data.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.login(email, password, store.id);
      if (result.success && result.data) {
        setUser(result.data.user);
        return { success: true };
      }
      return { success: false, error: result.error?.message || 'Failed to login' };
    },
    [store.id]
  );

  const register = useCallback(
    async (data: { email: string; password: string; firstName: string; lastName: string }) => {
      const result = await api.register({ ...data, storeId: store.id });
      if (!result.success) {
        return { success: false, error: result.error?.message || 'Failed to register' };
      }
      // T1-4: register no longer issues tokens. The API responds with
      // `{ emailVerificationSent: true }` for both new and existing
      // emails (closes the enumeration channel). Caller redirects to
      // a "check your email" page; the user signs in via /auth/login
      // after verifying their address.
      return { success: true, verifyEmailRequired: true };
    },
    [store.id]
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
