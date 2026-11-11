'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ErrorState } from '../../../../components/ErrorState';
import { useFeatures } from '../../../../hooks/useFeatures';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { usePaymentAbandonments } from './_hooks/usePaymentAbandonments';
import { AbandonmentStatsGrid } from './_components/AbandonmentStatsGrid';
import { AbandonmentsTable } from './_components/AbandonmentsTable';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';

export default function PaymentAbandonmentsPage() {
  // Feature gate — shows an upsell card for store_admins without the Enterprise feature.
  // Must be called before any conditional logic per React rules of hooks.
  const { gate } = useRequireFeature('payment_abandonment');

  const params = useParams();
  const storeId = params?.id as string;
  const { isEnabled } = useFeatures();
  const t = useT('paymentAbandonments.page');
  const tError = useT('components.errorState');

  const featureEnabled = isEnabled('payment_abandonment');

  const [localFrom, setLocalFrom] = useState('');
  const [localTo, setLocalTo] = useState('');

  const {
    stats,
    records,
    meta,
    page,
    dateFrom,
    dateTo,
    loading,
    error,
    retry,
    setPage,
    applyDateFilter,
  } = usePaymentAbandonments({ storeId, enabled: featureEnabled });

  if (gate) return gate;

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : error !== null ? (
        <ErrorState message={error || tError('loadFailed')} onRetry={retry} />
      ) : (
        <div className="space-y-6">
          <AbandonmentStatsGrid stats={stats} />

          {/* Date range filter */}
          <div className="bg-card rounded-xl border border-border p-4 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="pa-from" className="text-xs text-muted-foreground">
                {t('dateFrom')}
              </label>
              <input
                id="pa-from"
                type="date"
                value={localFrom}
                onChange={e => setLocalFrom(e.target.value)}
                className={FIELD_CLASSES}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="pa-to" className="text-xs text-muted-foreground">
                {t('dateTo')}
              </label>
              <input
                id="pa-to"
                type="date"
                value={localTo}
                onChange={e => setLocalTo(e.target.value)}
                className={FIELD_CLASSES}
              />
            </div>
            <Button
              variant="default"
              size="md"
              type="button"
              onClick={() => applyDateFilter(localFrom, localTo)}
            >
              {t('dateApply')}
            </Button>
            {(dateFrom || dateTo) && (
              <Button
                variant="outline"
                size="md"
                type="button"
                onClick={() => {
                  setLocalFrom('');
                  setLocalTo('');
                  applyDateFilter('', '');
                }}
              >
                &times;
              </Button>
            )}
          </div>

          {/* Retarget hint */}
          <p className="text-xs text-muted-foreground">{t('retargetHint')}</p>

          <AbandonmentsTable
            storeId={storeId}
            records={records}
            meta={meta}
            page={page}
            onPageChange={setPage}
          />
        </div>
      )}
    </AdminLayout>
  );
}
