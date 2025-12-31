'use client';

import { ReactNode } from 'react';
import { ToastProvider } from '@force/ui';
import { AuthProvider } from '../lib/auth';
import { NotificationProvider } from '../contexts/NotificationContext';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <NotificationProvider>
        <ToastProvider>{children}</ToastProvider>
      </NotificationProvider>
    </AuthProvider>
  );
}
