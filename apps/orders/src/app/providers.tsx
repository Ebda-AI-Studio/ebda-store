'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { AuthProvider, useAuth } from '@/lib/auth';
import { shouldRenderShell } from '@/lib/auth-gate';
import { StoreProvider } from '@/contexts/StoreContext';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { PostHogProvider } from '@/components/PostHogProvider';
import { registerServiceWorker } from '@/pwa/register-sw';

// OneSignalInit is a render-null leaf that only runs post-auth — keep the heavy
// react-onesignal lib out of the first-load (login-page) bundle.
const OneSignalInit = dynamic(
  () => import('@/components/OneSignalInit').then(m => m.OneSignalInit),
  { ssr: false }
);

/**
 * StoreProvider depends on auth state, so it only mounts once an AuthProvider is
 * present. We keep it inside a small wrapper so it can read `isAuthenticated`.
 */
function AuthedProviders({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  // StoreProvider internally gates its fetch on isAuthenticated, so it's safe to
  // always mount it under AuthProvider.
  return (
    <StoreProvider>
      {isAuthenticated && <OneSignalInit />}
      {children}
    </StoreProvider>
  );
}

/** Holds the protected shell back until a session is known (Ruling AUTH-FLASH-1); /login always renders. */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const pathname = usePathname();
  if (shouldRenderShell({ isLoading, hasUser: !!user, isPublic: pathname === '/login' })) {
    return <>{children}</>;
  }
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-screen items-center justify-center bg-background"
    >
      <div className="h-10 w-10 motion-safe:animate-spin rounded-full border-4 border-muted border-t-primary" />
    </div>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    registerServiceWorker();
  }, []);

  return (
    <LanguageProvider>
      <ToastProvider>
        <PostHogProvider>
          <AuthProvider>
            <AuthedProviders>
              <AuthGate>{children}</AuthGate>
            </AuthedProviders>
          </AuthProvider>
        </PostHogProvider>
      </ToastProvider>
    </LanguageProvider>
  );
}

// Re-export so pages can import the hook from one place if desired.
export { useAuth };
