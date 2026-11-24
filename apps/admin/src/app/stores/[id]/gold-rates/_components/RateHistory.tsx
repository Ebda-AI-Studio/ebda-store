'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../lib/api';
import { formatDateTime, formatPrice } from '../../../../../lib/format';
import type { HistoryItem } from './types';

import { Button } from '@/components/ui/Button';
export function RateHistory({ storeId, reloadKey }: { storeId: string; reloadKey: number }) {
  const t = useT('goldRates.history');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(
    async (from: string | null) => {
      const q = from ? `?cursor=${encodeURIComponent(from)}` : '';
      const { data, error: e } = await apiGet<{ items: HistoryItem[]; nextCursor: string | null }>(
        `/api/v1/stores/${storeId}/gold-rates/history${q}`
      );
      if (e || !data) setError(true);
      else {
        setError(false);
        setItems(prev => (from ? [...prev, ...data.items] : data.items));
        setCursor(data.nextCursor);
      }
      setLoading(false);
    },
    [storeId]
  );

  useEffect(() => {
    void load(null);
  }, [load, reloadKey]);

  return (
    <section className="rounded-md border bg-card p-4 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-ink">
          {t('failed')}
        </p>
      )}
      {!loading && items.length === 0 && !error && (
        <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
      )}
      <ul className="mt-3 divide-y text-sm">
        {items.map(i => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {t('row', { karat: i.karat, rate: formatPrice(i.ratePerGram) })}
              <span className="ms-2 text-xs text-muted-foreground">
                {i.source === 'feed' ? t('sourceFeed') : t('sourceManual')}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {t(`status_${i.status}` as 'status_applied')} · {formatDateTime(i.createdAt)}
            </span>
          </li>
        ))}
      </ul>
      {cursor && (
        <Button type="button" onClick={() => void load(cursor)} variant="outline" className="mt-3">
          {t('more')}
        </Button>
      )}
    </section>
  );
}
