'use client';

/**
 * A line on the store dashboard when gold pricing is on and needs the merchant: a rate past its limit
 * (gold products cannot be bought) or an automatic rate waiting for confirmation. Renders nothing for a
 * store that does not use gold pricing, and nothing if the read fails (the rates page shows the error).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../lib/api';

interface State {
  settings: { enabled: boolean };
  goldProductCount: number;
  rates: { ratePerGram: number | null; stale: boolean }[];
  pending: unknown[];
  disagreement?: unknown;
}

export function GoldRateBanner({ storeId }: { storeId: string }) {
  const t = useT('goldRates.banner');
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let live = true;
    void apiGet<State>(`/api/v1/stores/${storeId}/gold-rates`).then(({ data }) => {
      if (live && data) setState(data);
    });
    return () => {
      live = false;
    };
  }, [storeId]);

  if (!state?.settings?.enabled || !state.goldProductCount) return null;
  const stale = (state.rates ?? []).some(r => r.ratePerGram === null || r.stale);
  const pending = (state.pending ?? []).length > 0;
  if (!stale && !pending) return null;

  return (
    <div
      role="alert"
      className="mb-6 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
    >
      <p className="font-medium">
        {state.disagreement ? t('disagree') : stale ? t('stale') : t('pending')}
      </p>
      <Link
        href={`/stores/${storeId}/gold-rates`}
        className="mt-1 inline-flex min-h-11 items-center text-primary underline underline-offset-4"
      >
        {t('open')}
      </Link>
    </div>
  );
}
