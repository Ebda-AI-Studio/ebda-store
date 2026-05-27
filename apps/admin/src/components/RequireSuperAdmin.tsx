'use client';

import { notFound } from 'next/navigation';
import { useAuth } from '@/lib/auth';

interface RequireSuperAdminProps {
  children: React.ReactNode;
}

/**
 * Client-side guard: renders children only for super_admin users.
 * - Loading: returns null (layout already shows a spinner)
 * - Not super_admin: calls notFound() to surface a 404 (hides endpoint existence from store admins)
 * - super_admin: renders children
 */
export function RequireSuperAdmin({ children }: RequireSuperAdminProps) {
  const { user, isLoading } = useAuth();

  if (isLoading) return null;

  if (user?.role !== 'super_admin') {
    notFound();
  }

  return <>{children}</>;
}
