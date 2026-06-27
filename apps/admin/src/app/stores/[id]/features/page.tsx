'use client';

import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { RequireSuperAdmin } from '@/components/RequireSuperAdmin';
import { FeatureMatrix } from './FeatureMatrix';
import { useT } from '@/i18n/useT';

/**
 * Super-admin feature matrix for a store.
 *
 * Shows the tri-state feature view (baseline on / override on / override off /
 * baseline off) with plan picker, per-feature overrides, and danger-zone
 * actions (suspend, reset). Gated by RequireSuperAdmin — store admins see 404.
 *
 * The store-admin-facing simple toggle page has been superseded by this
 * view (Phase C of the 3-tier plan system, 2026-05-27).
 */
export default function StoreFeaturesPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('features.page');

  return (
    <RequireSuperAdmin>
      <AdminLayout title={t('manageTitle')} subtitle={t('manageSubtitle')}>
        <FeatureMatrix storeId={storeId} />
      </AdminLayout>
    </RequireSuperAdmin>
  );
}
