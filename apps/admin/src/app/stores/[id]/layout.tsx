'use client';

import { ReactNode, useEffect } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { AdminFeatureProvider } from '../../../hooks/useFeatures';
import { useNotifications } from '../../../contexts/NotificationContext';
import { BillingStatusBanner } from '../../../components/billing/BillingStatusBanner';
import { LegalNoticeBanner } from '../../../components/legal/LegalNoticeBanner';
import { PlanGate } from '../../../components/PlanGate';
import { featureForStorePath } from '../../../lib/route-feature-gates';

/**
 * Store-level layout.
 *
 * Wraps all pages under /stores/[id]/ with AdminFeatureProvider so that every
 * child page can call useFeatures() to gate UI elements based on the store's
 * active feature flags.
 *
 * Reads the entitlements ONCE here and renders the locked-plan card in place of a plan-gated page
 * (`<PlanGate>`, route map in lib/route-feature-gates.ts), so the page never mounts and never
 * fetches-then-fails with a raw 402/403 (audit G-2/G-3).
 *
 * Also subscribes to WebSocket notifications for the current store so the
 * NotificationBell in AdminLayout receives real-time events (new orders,
 * low stock, reviews, etc.) while any store page is mounted.
 */
export default function StoreLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const storeId = params?.id as string;
  const pathname = usePathname();
  const gatedFeature = storeId && pathname ? featureForStorePath(pathname, storeId) : null;
  const { subscribeToStore, unsubscribeFromStore } = useNotifications();

  useEffect(() => {
    if (!storeId) return;
    subscribeToStore(storeId);
    return () => {
      unsubscribeFromStore(storeId);
    };
  }, [storeId, subscribeToStore, unsubscribeFromStore]);

  return (
    <AdminFeatureProvider storeId={storeId}>
      {storeId && <BillingStatusBanner storeId={storeId} />}
      {storeId && <LegalNoticeBanner storeId={storeId} />}
      <PlanGate storeId={storeId} featureKey={gatedFeature}>
        {children}
      </PlanGate>
    </AdminFeatureProvider>
  );
}
