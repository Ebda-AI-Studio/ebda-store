'use client';

import { createElement, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useFeatures } from './useFeatures';
import { useAuth } from '../lib/auth';
import { FeatureUpgradeGate } from '../components/FeatureUpgradeGate';

/**
 * Page-level guard for feature-gated store-admin routes.
 *
 * Sidebar nav already hides nav items for disabled features, but a user can
 * type the URL or follow a stale bookmark. This hook:
 *
 * 1. Reads the feature toggle from `useFeatures()` (which is itself wired
 *    to the per-role endpoint — store_admin sees `/stores/:id/my-features`).
 * 2. Once the toggle has resolved (no longer loading), if the feature is
 *    disabled for a store_admin, `gate` will be a <FeatureUpgradeGate>
 *    marketing element. Each page renders `if (gate) return gate;` after all
 *    its own hooks so the user sees a polished upsell instead of a silent
 *    redirect.
 *
 * Super-admin behavior is unchanged: they always see the real page so they
 * can configure the feature. They never receive the gate.
 *
 * Usage pattern (place AFTER all hooks in the page component):
 *
 *   const { enabled, isLoading, gate } = useRequireFeature('coupons');
 *   // ... other hooks (useState, useEffect, etc.) ...
 *   if (gate) return gate;   ← after all hooks
 *   return <AdminLayout ...>;
 *
 * The hook still returns `enabled` and `isLoading` so pages can use them
 * for their own loading spinners and logic.
 */
export function useRequireFeature(
  featureKey: string,
  opts?: { pageTitle?: string }
): {
  enabled: boolean;
  isLoading: boolean;
  /**
   * Non-null when the current store_admin does not have access to this
   * feature. Pages should do `if (gate) return gate;` AFTER all their own
   * hooks and just before the main JSX return. Null while loading (no
   * flash) and null for super_admin (always passes through).
   */
  gate: ReactNode | null;
} {
  const params = useParams();
  const storeId = params?.id as string | undefined;
  const { isEnabled, isLoading } = useFeatures();
  const { user } = useAuth();

  const enabled = isEnabled(featureKey);

  // Super admin always passes through — they configure features, so bouncing
  // them away from a disabled feature page would prevent them from enabling it.
  const isSuperAdmin = user?.role === 'super_admin';

  // Show nothing (null gate) while features are still loading to avoid
  // flashing the upsell card for a frame before the real content appears.
  const showGate = !isLoading && !enabled && !isSuperAdmin && !!storeId;

  // Use createElement so this .ts file (no JSX transform) can return a React
  // element without needing the .tsx extension.
  const gate: ReactNode | null = showGate
    ? createElement(FeatureUpgradeGate, { featureKey, storeId: storeId!, pageTitle: opts?.pageTitle })
    : null;

  return { enabled, isLoading, gate };
}
