'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api, type User } from '../lib/api';

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
  }) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    if (!token) {
      setUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const result = await api.getProfile();
      if (result.success && result.data) {
        setUser(result.data.user);
      } else {
        setUser(null);
        api.setToken(null);
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

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    if (result.success && result.data) {
      setUser(result.data.user);
      return { success: true };
    }
    return { success: false, error: result.error?.message || 'Failed to login' };
  }, []);

  const register = useCallback(
    async (data: { email: string; password: string; firstName: string; lastName: string }) => {
      const result = await api.register(data);
      if (result.success && result.data) {
        api.setToken(result.data.accessToken);
        if (typeof window !== 'undefined') {
          localStorage.setItem('refreshToken', result.data.refreshToken);
        }
        setUser(result.data.user);
        return { success: true };
      }
      return { success: false, error: result.error?.message || 'Failed to register' };
    },
    []
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
