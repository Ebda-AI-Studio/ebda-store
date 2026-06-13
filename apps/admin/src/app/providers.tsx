'use client';

import { ReactNode, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { ToastProvider } from '@force/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { StoreProvider } from '../contexts/StoreContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import { FocusModeProvider } from '../contexts/FocusModeContext';
import { PwaInstallHint } from '../components/PwaInstallHint';
import { PostHogProvider } from '../components/PostHogProvider';
// OneSignalInit is a render-null leaf that only runs post-auth — keep the heavy
// react-onesignal lib out of the first-load bundle (irrelevant on the login page).
const OneSignalInit = dynamic(
  () => import('../components/OneSignalInit').then(m => m.OneSignalInit),
  { ssr: false }
);

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
              <OneSignalInit />
              <PwaInstallHint />
              {children}
            </ToastProvider>
          </FocusModeProvider>
        </Suspense>
      </NotificationProvider>
    </StoreProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <PostHogProvider>
        <AuthenticatedProviders>{children}</AuthenticatedProviders>
      </PostHogProvider>
    </AuthProvider>
  );
}
