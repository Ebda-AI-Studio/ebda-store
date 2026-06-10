'use client';

import { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { ToastProvider } from '@force/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { StoreProvider } from '../contexts/StoreContext';
import { NotificationProvider } from '../contexts/NotificationContext';
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
        <ToastProvider>
          <OneSignalInit />
          <PwaInstallHint />
          {children}
        </ToastProvider>
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
