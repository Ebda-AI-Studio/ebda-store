'use client';

import { ReactNode, Suspense } from 'react';
import { ToastProvider } from '@ebda/ui';
import { usePathname } from 'next/navigation';
import { AuthProvider, useAuth, isPublicPath } from '../lib/auth';
import { shouldRenderShell } from '../lib/auth-gate';
import { StoreProvider } from '../contexts/StoreContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import { FocusModeProvider } from '../contexts/FocusModeContext';
import { PwaInstallHint } from '../components/PwaInstallHint';
import { PostHogProvider } from '../components/PostHogProvider';
import { UpsellDialog } from '../components/billing/UpsellDialog';
import { EbdaFunnelTracking } from '../components/EbdaFunnelTracking';

function AuthenticatedProviders({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <ToastProvider>{children}</ToastProvider>;
  }

  return (
    <StoreProvider>
      <NotificationProvider>
        {/* FocusModeProvider reads useSearchParams — must be wrapped in Suspense
            to satisfy Next.js App Router's static-rendering rules. */}
        <Suspense>
          <FocusModeProvider>
            <ToastProvider>
              <PwaInstallHint />
              <UpsellDialog />
              {children}
            </ToastProvider>
          </FocusModeProvider>
        </Suspense>
      </NotificationProvider>
    </StoreProvider>
  );
}

/**
 * Holds the protected shell back until a session is known (Ruling AUTH-FLASH-1): a logged-out visitor
 * sees a neutral loader while AuthProvider redirects to /login, never a frame of the dashboard.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const pathname = usePathname();
  if (shouldRenderShell({ isLoading, hasUser: !!user, isPublic: isPublicPath(pathname) })) {
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

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <PostHogProvider>
        <EbdaFunnelTracking />
        <AuthenticatedProviders>
          <AuthGate>{children}</AuthGate>
        </AuthenticatedProviders>
      </PostHogProvider>
    </AuthProvider>
  );
}
