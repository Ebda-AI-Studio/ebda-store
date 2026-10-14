'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { CartIcon } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ErrorState } from '../../../../components/ErrorState';
import { useFeatures } from '../../../../hooks/useFeatures';
import { AbandonedCartsTable } from './_components/AbandonedCartsTable';
import { RecoveryCampaignForm } from './_components/RecoveryCampaignForm';
import { StatsGrid } from './_components/StatsGrid';
import { useAbandonedCarts } from './_hooks/useAbandonedCarts';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

export default function AbandonedCartsPage() {
  const { gate } = useRequireFeature('abandoned_cart');

  const params = useParams();
  const storeId = params?.id as string;
  const { isEnabled } = useFeatures();

  const tPage = useT('abandonedCarts.page');
  const tEmpty = useT('abandonedCarts.featureDisabled');
  const tError = useT('components.errorState');

  const featureEnabled = isEnabled('abandoned_cart');

  const {
    stats,
    guestCheckout,
    config,
    records,
    meta,
    statusFilter,
    page,
    loading,
    error,
    retry,
    savingConfig,
    patchConfig,
    saveConfig,
    setPage,
    changeStatusFilter,
  } = useAbandonedCarts({
    storeId,
    enabled: featureEnabled,
  });

  if (gate) return gate;

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : !featureEnabled ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <CartIcon className="w-8 h-8 text-primary" strokeWidth={1.5} />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{tEmpty('title')}</h2>
          <p className="text-muted-foreground max-w-md">{tEmpty('description')}</p>
        </div>
      ) : error !== null ? (
        <ErrorState message={error || tError('loadFailed')} onRetry={retry} />
      ) : (
        <div className="space-y-6">
          <StatsGrid stats={stats} guestCheckout={guestCheckout} />

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
