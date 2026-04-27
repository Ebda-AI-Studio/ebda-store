'use client';

import { ReactNode } from 'react';
import { ToastProvider } from '@force/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { StoreProvider } from '../contexts/StoreContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import { OneSignalInit } from '../components/OneSignalInit';
import { PwaInstallHint } from '../components/PwaInstallHint';

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
      <AuthenticatedProviders>{children}</AuthenticatedProviders>
    </AuthProvider>
  );
}
