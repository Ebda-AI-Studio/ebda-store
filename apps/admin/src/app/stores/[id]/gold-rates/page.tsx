'use client';

/**
 * /stores/[id]/gold-rates: today's gold rate per karat, the automatic-rate settings, pending feed rates and the
 * audited history (Phase B5 Task 13). Writing a rate reprices every gold-priced product on the server.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/format';
import { GoldPaymentPolicyCard } from './_components/GoldPaymentPolicyCard';
import { GoldSettingsCard } from './_components/GoldSettingsCard';
import { PendingRateBanner } from './_components/PendingRateBanner';
import { RateEditor } from './_components/RateEditor';
import { RateHistory } from './_components/RateHistory';
import type { GoldState } from './_components/types';

export default function GoldRatesPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('goldRates.page');
  const [state, setState] = useState<GoldState | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    const { data, error: e } = await apiGet<GoldState>(`/api/v1/stores/${storeId}/gold-rates`);
    if (e || !data) setError(true);
    else {
      setError(false);
      setState(data);
    }
  }, [storeId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const refresh = () => setReload(n => n + 1);
  // The server refuses a write the role may not make; the controls only mirror it.
  const canEdit = true;
  const stale = state?.rates.some(r => r.stale && r.ratePerGram !== null) ?? false;
  const missing = state?.rates.every(r => r.ratePerGram === null) ?? false;

  return (
    <AdminLayout title={t('title')} mode="store_admin" storeId={storeId}>
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
          >
            {t('loadFailed')}
          </p>
        )}
        {!state && !error && (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</p>
        )}
        {state && (
          <>
            {(stale || (missing && state.goldProductCount > 0)) && (
              <p
                role="alert"
                className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
              >
                {stale ? t('staleBanner') : t('missingBanner')}
              </p>
            )}
            <p className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium">
              {t(
                !state.settings.enabled
                  ? 'modeOff'
                  : state.settings.feedEnabled
                    ? 'modeAuto'
                    : 'modeManual'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('productCount', { count: state.goldProductCount })}
              {state.rates.find(r => r.appliedAt)?.appliedAt
                ? ` · ${t('updated', { at: formatDateTime(state.rates.find(r => r.appliedAt)?.appliedAt) })}`
                : ''}
            </p>
            <PendingRateBanner
              storeId={storeId}
              pending={state.pending}
              canEdit={canEdit}
              onDecided={refresh}
            />
            <RateEditor
              key={`${String(reload)}-${state.rates.map(r => r.ratePerGram ?? 0).join('-')}`}
              storeId={storeId}
              rates={state.rates}
              feedEnabled={state.settings.feedEnabled}
              canEdit={canEdit}
              onSaved={refresh}
            />
            <GoldSettingsCard
              key={`s-${String(reload)}`}
              storeId={storeId}
              settings={state.settings}
              canEdit={canEdit}
              onSaved={refresh}
            />
            <GoldPaymentPolicyCard storeId={storeId} canEdit={canEdit} />
            <RateHistory storeId={storeId} reloadKey={reload} />
          </>
        )}
      </div>
    </AdminLayout>
  );
}
