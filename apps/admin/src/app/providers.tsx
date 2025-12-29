'use client';

import { ReactNode } from 'react';
import { ToastProvider } from '@force/ui';
import { AuthProvider } from '../lib/auth';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        {children}
      </ToastProvider>
    </AuthProvider>
  );
}
