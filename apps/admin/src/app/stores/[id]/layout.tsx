'use client';

import { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { AdminFeatureProvider } from '../../../hooks/useFeatures';

/**
 * Store-level layout.
 *
 * Wraps all pages under /stores/[id]/ with AdminFeatureProvider so that every
 * child page can call useFeatures() to gate UI elements based on the store's
 * active feature flags.
 */
export default function StoreLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const storeId = params?.id as string;

  return <AdminFeatureProvider storeId={storeId}>{children}</AdminFeatureProvider>;
}
