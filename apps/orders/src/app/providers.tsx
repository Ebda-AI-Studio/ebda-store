'use client';

import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { StoreProvider } from '@/contexts/StoreContext';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { registerServiceWorker } from '@/pwa/register-sw';

/**
 * StoreProvider depends on auth state, so it only mounts once an AuthProvider is
 * present. We keep it inside a small wrapper so it can read `isAuthenticated`.
 */
function AuthedProviders({ children }: { children: React.ReactNode }) {
  // StoreProvider internally gates its fetch on isAuthenticated, so it's safe to
  // always mount it under AuthProvider.
  return <StoreProvider>{children}</StoreProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    registerServiceWorker();
  }, []);

  return (
    <LanguageProvider>
      <ToastProvider>
        <AuthProvider>
          <AuthedProviders>{children}</AuthedProviders>
        </AuthProvider>
      </ToastProvider>
    </LanguageProvider>
  );
}

// Re-export so pages can import the hook from one place if desired.
export { useAuth };
