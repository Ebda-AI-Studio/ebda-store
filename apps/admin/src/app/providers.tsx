'use client';

import { ReactNode } from 'react';
import { ToastProvider } from '@force/ui';
import { AuthProvider } from '../lib/auth';
import { StoreProvider } from '../contexts/StoreContext';
import { NotificationProvider } from '../contexts/NotificationContext';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <StoreProvider>
        <NotificationProvider>
          <ToastProvider>{children}</ToastProvider>
        </NotificationProvider>
      </StoreProvider>
    </AuthProvider>
  );
}
