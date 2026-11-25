'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useT } from '@/i18n/useT';
import { useFeatures } from '../../../../../hooks/useFeatures';
import { formatCurrency, formatNumber } from './types';

interface Bucket {
  revenue: number;
  units: number;
}
export interface PriceSourceSplit {
  retail: Bucket;
  tier: Bucket;
  group: Bucket;
  wholesale: Bucket;
  wholesaleSharePercent: number;
}

/**
 * Wholesale vs retail line revenue for the picked period (`GET .../analytics/price-source`).
 * Only stores on the wholesale plan (`b2b.wholesale`) see it, and it makes no request otherwise.
 */
export function PriceSourceCard({ storeId, rangeQs }: { storeId: string; rangeQs: string }) {
  const t = useT('analytics.priceSource');
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  const enabled = !featuresLoading && isEnabled('b2b.wholesale');
  const [data, setData] = useState<PriceSourceSplit | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setData(null);
    setFailed(false);
    apiGet<PriceSourceSplit>(`/api/v1/stores/${storeId}/analytics/price-source?${rangeQs}`)
      .then(({ data: d, error }) => {
        if (!current) return;
        if (error || !d) setFailed(true);
        else setData(d);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [enabled, storeId, rangeQs]);

  if (!enabled) return null;

  const rows = data
    ? ([
        ['retail', data.retail],
        ['tier', data.tier],
        ['group', data.group],
      ] as const)
    : [];

  return (
    <section
      data-testid="price-source-card"
      className="bg-card rounded-md border p-6 shadow-sm mt-6"
    >
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      {failed ? (
        <p className="mt-3 text-xs text-muted-foreground">{t('loadFailed')}</p>
      ) : !data ? (
        <div className="mt-3 h-16 animate-pulse rounded-md bg-muted" />
      ) : data.wholesale.units === 0 && data.retail.units === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <p className="mt-3 text-sm text-foreground">
            <span className="text-2xl font-semibold tabular-nums">
              {data.wholesaleSharePercent}%
            </span>{' '}
            <span className="text-muted-foreground">{t('shareLabel')}</span>
          </p>
          <div
            className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={t('shareBar', { percent: data.wholesaleSharePercent })}
          >
            <div
              className="h-full bg-primary"
              style={{ width: `${data.wholesaleSharePercent}%` }}
            />
          </div>
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 text-start font-normal">{t('source')}</th>
                <th className="py-1 text-end font-normal">{t('units')}</th>
                <th className="py-1 text-end font-normal">{t('revenue')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, b]) => (
                <tr key={key} data-testid={`price-source-${key}`}>
                  <td className="py-1">{t(key)}</td>
                  <td className="py-1 text-end tabular-nums">{formatNumber(b.units)}</td>
                  <td className="py-1 text-end tabular-nums">{formatCurrency(b.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
