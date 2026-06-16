'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

/**
 * Entry route. Sends authenticated staff to /orders and everyone else to
 * /login. AuthProvider already redirects unauthenticated users, but routing
 * here keeps `/` from rendering a blank shell.
 */
export default function Home() {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    router.replace(isAuthenticated ? '/orders' : '/login');
  }, [isLoading, isAuthenticated, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
      …
    </div>
  );
}
