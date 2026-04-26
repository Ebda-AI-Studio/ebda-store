'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useFeatures } from '../../../../hooks/useFeatures';
import { AbandonedCartsTable } from './_components/AbandonedCartsTable';
import { RecoveryCampaignForm } from './_components/RecoveryCampaignForm';
import { StatsGrid } from './_components/StatsGrid';
import { useAbandonedCarts } from './_hooks/useAbandonedCarts';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

export default function AbandonedCartsPage() {
  // Hide this page when the super_admin disabled the abandoned_cart feature for
  // this store. The hook redirects to the store dashboard if disabled.
  useRequireFeature('abandoned_cart');

  const params = useParams();
  const storeId = params?.id as string;
  const { isEnabled } = useFeatures();

  const tPage = useT('abandonedCarts.page');
  const tEmpty = useT('abandonedCarts.featureDisabled');

  const featureEnabled = isEnabled('abandoned_cart');

  const {
    stats,
    config,
    records,
    meta,
    statusFilter,
    page,
    loading,
    savingConfig,
    patchConfig,
    saveConfig,
    setPage,
    changeStatusFilter,
  } = useAbandonedCarts({
    storeId,
    enabled: featureEnabled,
  });

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : !featureEnabled ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{tEmpty('title')}</h2>
          <p className="text-muted-foreground max-w-md">{tEmpty('description')}</p>
        </div>
      ) : (
        <div className="space-y-6">
          <StatsGrid stats={stats} />

          <RecoveryCampaignForm
            config={config}
            saving={savingConfig}
            onPatch={patchConfig}
            onSave={saveConfig}
          />

          <AbandonedCartsTable
            records={records}
            meta={meta}
            statusFilter={statusFilter}
            page={page}
            onStatusFilterChange={changeStatusFilter}
            onPageChange={setPage}
          />
        </div>
      )}
    </AdminLayout>
  );
}
