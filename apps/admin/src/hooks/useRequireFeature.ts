'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useFeatures } from './useFeatures';
import { useAuth } from '../lib/auth';

/**
 * Page-level guard for feature-gated store-admin routes.
 *
 * Sidebar nav already hides nav items for disabled features, but a user can
 * type the URL or follow a stale bookmark. This hook:
 *
 * 1. Reads the feature toggle from `useFeatures()` (which is itself wired
 *    to the per-role endpoint — store_admin sees `/stores/:id/my-features`).
 * 2. Once the toggle has resolved (no longer loading), if the feature is
 *    disabled it redirects to the store dashboard.
 *
 * Use as the first hook in a page component:
 *
 *   useRequireFeature('coupons');
 *
 * The hook returns the resolved `isEnabled` state in case the page wants
 * to render a placeholder during the redirect frame.
 */
export function useRequireFeature(featureKey: string): {
  enabled: boolean;
  isLoading: boolean;
} {
  const params = useParams();
  const storeId = params?.id as string | undefined;
  const router = useRouter();
  const { isEnabled, isLoading } = useFeatures();
  const { user } = useAuth();

  const enabled = isEnabled(featureKey);

  useEffect(() => {
    if (isLoading) return;
    if (enabled) return;
    if (!storeId) return;
    // Super admin always gets through — they're the one who flips the
    // feature on, so redirecting them away from a disabled feature
    // editor would prevent them from ever enabling it. Store admins
    // still get bounced back to the dashboard.
    if (user?.role === 'super_admin') return;
    router.replace(`/stores/${storeId}`);
  }, [enabled, isLoading, storeId, router, user?.role]);

  return { enabled, isLoading };
}
