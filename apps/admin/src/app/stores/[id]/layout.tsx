'use client';

import { ReactNode, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { AdminFeatureProvider } from '../../../hooks/useFeatures';
import { useNotifications } from '../../../contexts/NotificationContext';
import { BillingStatusBanner } from '../../../components/billing/BillingStatusBanner';
import { LegalNoticeBanner } from '../../../components/legal/LegalNoticeBanner';

/**
 * Store-level layout.
 *
 * Wraps all pages under /stores/[id]/ with AdminFeatureProvider so that every
 * child page can call useFeatures() to gate UI elements based on the store's
 * active feature flags.
 *
 * Also subscribes to WebSocket notifications for the current store so the
 * NotificationBell in AdminLayout receives real-time events (new orders,
 * low stock, reviews, etc.) while any store page is mounted.
 */
export default function StoreLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const storeId = params?.id as string;
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
      {children}
    </AdminFeatureProvider>
  );
}
