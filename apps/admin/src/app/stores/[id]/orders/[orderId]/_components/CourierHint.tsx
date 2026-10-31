'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../../lib/api';

interface Row {
  carrier: string;
  status: 'ok' | 'insufficient';
  deliveredRate?: number;
  n?: number;
}
type Result = { enabled: false } | { enabled: true; ranked: Row[]; suggested: string | null };

/** One line under the carrier picker. Never changes the selection: the merchant's choice stays one click. */
export function CourierHint({
  storeId,
  orderId,
  carriers,
  names,
}: {
  storeId: string;
  orderId: string;
  /** Real carrier codes only (not "manual"). */
  carriers: string[];
  names: Record<string, string>;
}) {
  const t = useT('customerIntelligence.courier');
  const [result, setResult] = useState<Result | null>(null);
  const key = carriers.join(',');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void apiGet<Result>(
      `/api/v1/stores/${storeId}/ci/courier?orderId=${orderId}&carriers=${encodeURIComponent(key)}`
    ).then(({ data }) => {
      if (alive) setResult(data ?? null);
    });
    return () => {
      alive = false;
    };
  }, [storeId, orderId, key]);

  if (!result || !result.enabled || !result.suggested) return null;
  const top = result.ranked.find(r => r.carrier === result.suggested);
  if (!top || top.deliveredRate == null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t('best', {
        carrier: names[top.carrier] ?? top.carrier,
        rate: `${Math.round(top.deliveredRate * 100)}%`,
        n: top.n ?? 0,
      })}
    </p>
  );
}
