'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { useT } from '@/i18n/useT';
import type { SearchInsightsResponse } from '@ebda/shared';

/** Top searches (last 7 days) that showed no products: the shoppers' unmet demand. */
export function ZeroResultSearchesCard({ storeId }: { storeId: string }) {
  const t = useT('insights.searches');
  const [data, setData] = useState<SearchInsightsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    apiGet<SearchInsightsResponse>(`/api/v1/stores/${storeId}/search-insights?days=7&filter=zero`)
      .then(({ data: d, error }) => (error ? setFailed(true) : setData(d ?? null)))
      .catch(() => setFailed(true));
  }, [storeId]);
  return (
    <section className="rounded-lg border border-border bg-card p-4 mt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t('cardTitle')}</h2>
        <Link
          href={`/stores/${storeId}/insights/searches`}
          className="inline-flex min-h-11 items-center text-xs text-primary"
        >
          {t('viewAll')}
        </Link>
      </div>
      {failed ? (
        <p className="mt-3 text-xs text-muted-foreground">{t('loadFailed')}</p>
      ) : !data ? (
        <div className="mt-3 h-16 animate-pulse rounded-md bg-muted" />
      ) : data.terms.length === 0 ? (
        <>
          <p className="mt-3 text-xs text-muted-foreground">{t('cardEmpty')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('floorNote')}</p>
        </>
      ) : (
        <ul className="mt-3 space-y-1">
          {data.terms.slice(0, 5).map(r => (
            <li key={r.term} className="flex justify-between gap-3 text-sm">
              <span dir="auto">{r.term}</span>
              <span
                className="text-muted-foreground tabular-nums"
                aria-label={t('cardCountLabel', { count: r.zeroResults })}
              >
                {r.zeroResults}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && data.terms.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">{t('floorNote')}</p>
      )}
    </section>
  );
}
