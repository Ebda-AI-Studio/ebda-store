'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../../lib/api';

interface Hint {
  band: 'typical' | 'elevated' | 'insufficient';
  source: 'store' | 'cohort' | 'none';
  n: number;
  rate: number | null;
  reasons: Array<'area' | 'buyer'>;
  suggestions: Array<'confirm_by_phone' | 'ask_instapay_deposit'>;
}
type Result =
  | { enabled: false }
  | { enabled: true; applicable: false }
  | { enabled: true; applicable: true; hint: Hint };

const TONE = {
  typical: 'text-foreground',
  elevated: 'text-warning-ink',
  insufficient: 'text-muted-foreground',
} as const;

/** COD risk note (Customer Intelligence, Ruling CI-10). Advice only: nothing here holds or changes the order. */
export function OrderCodRiskCard({ storeId, orderId }: { storeId: string; orderId: string }) {
  const t = useT('customerIntelligence.order');
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    let alive = true;
    void apiGet<Result>(`/api/v1/stores/${storeId}/ci/orders/${orderId}/hint`).then(({ data }) => {
      if (alive) setResult(data ?? null);
    });
    return () => {
      alive = false;
    };
  }, [storeId, orderId]);

  if (!result || !result.enabled || !result.applicable) return null;
  const h = result.hint;
  return (
    <section
      className="rounded-2xl border border-border bg-card p-5"
      aria-labelledby="order-ci-title"
    >
      <h2
        id="order-ci-title"
        className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground"
      >
        {t('title')}
      </h2>
      <p className={`text-sm font-medium ${TONE[h.band]}`}>{t(`band.${h.band}`)}</p>
      {h.band !== 'insufficient' && h.reasons.length > 0 && (
        <ul className="mt-1 list-disc ps-5 text-sm text-muted-foreground">
          {h.reasons.map(r => (
            <li key={r}>{t(`reason.${r}`)}</li>
          ))}
        </ul>
      )}
      {h.n > 0 && h.band !== 'insufficient' && (
        <p className="mt-1 text-xs text-muted-foreground">{t('basedOn', { n: h.n })}</p>
      )}
      {h.suggestions.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-foreground">
          {h.suggestions.map(s => (
            <li key={s}>{t(`suggest.${s}`)}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t('advisory')}</p>
    </section>
  );
}
