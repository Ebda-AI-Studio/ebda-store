'use client';

import { useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiPost } from '../../../../../lib/api';
import { formatPrice } from '../../../../../lib/format';
import type { PendingRate } from './types';

import { Button } from '@/components/ui/Button';
/** A feed rate that jumped past the store's gate waits here until the merchant confirms or rejects it. */
export function PendingRateBanner({
  storeId,
  pending,
  canEdit,
  onDecided,
}: {
  storeId: string;
  pending: PendingRate[];
  canEdit: boolean;
  onDecided: () => void;
}) {
  const t = useT('goldRates.pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (pending.length === 0) return null;

  const decide = async (id: string, decision: 'confirm' | 'reject') => {
    setBusy(id);
    setError(null);
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/gold-rates/${id}/decision`,
      {
        decision,
      }
    );
    setBusy(null);
    if (apiError) setError(t('failed'));
    else onDecided();
  };

  return (
    <section role="status" className="rounded-md border border-warning/40 bg-warning/10 p-4 sm:p-6">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('body')}</p>
      <ul className="mt-3 space-y-3">
        {pending.map(p => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>
              {t('row', {
                karat: p.karat,
                rate: formatPrice(p.ratePerGram),
                pct: p.jumpBps === null ? '-' : (p.jumpBps / 100).toFixed(1),
              })}
            </span>
            {canEdit && (
              <span className="flex gap-2">
                <Button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => void decide(p.id, 'reject')}
                  variant="outline"
                >
                  {t('reject')}
                </Button>
                <Button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => void decide(p.id, 'confirm')}
                  variant="default"
                >
                  {t('confirm')}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-ink">
          {error}
        </p>
      )}
    </section>
  );
}
