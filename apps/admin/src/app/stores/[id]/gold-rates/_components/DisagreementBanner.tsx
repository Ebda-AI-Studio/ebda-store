'use client';

import { useState } from 'react';
import { GOLD_KARATS } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiPost, apiPut } from '../../../../../lib/api';
import { formatPrice } from '../../../../../lib/format';
import type { GoldDisagreement, PendingRate, RateView } from './types';

import { Button, buttonVariants } from '@/components/ui/Button';
/**
 * The two automatic sources disagree: the STORE OWNER decides (Ruling GOLD-DISAGREE-MERCHANT-1). Shows both
 * values and the gap, and offers the four ways out, all on the existing paths: apply the first source =
 * confirm the pending rates (`/decision`), apply the second = write its rates through the manual PUT (the
 * owner's explicit choice, so `confirm: true`) and reject the pending rows, own rate = jump to the editor
 * (the page rejects the pending rows once it saves), keep current = reject the pending rows. Nothing here
 * applies by itself.
 */
export function DisagreementBanner({
  storeId,
  pending,
  disagreement,
  rates,
  canEdit,
  onDecided,
}: {
  storeId: string;
  pending: PendingRate[];
  disagreement: GoldDisagreement;
  rates: RateView[];
  canEdit: boolean;
  onDecided: () => void;
}) {
  const t = useT('goldRates.disagree');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    setError(null);
    const ok = await fn();
    setBusy(false);
    if (ok) onDecided();
    else setError(t('failed'));
  };
  const decideAll = async (decision: 'confirm' | 'reject') => {
    for (const p of pending) {
      const { error: e } = await apiPost(`/api/v1/stores/${storeId}/gold-rates/${p.id}/decision`, {
        decision,
      });
      if (e) return false;
    }
    return true;
  };
  const applyFallback = async () => {
    const { error: e } = await apiPut(`/api/v1/stores/${storeId}/gold-rates`, {
      rates: GOLD_KARATS.map(k => ({
        karat: k,
        ratePerGram: disagreement.fallbackRates[String(k)],
      })),
      confirm: true,
    });
    if (e) return false;
    return decideAll('reject');
  };
  const current24 = rates.find(r => r.karat === 24)?.ratePerGram ?? null;

  return (
    <section role="status" className="rounded-xl border border-warning/40 bg-warning/10 p-4 sm:p-6">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('body', { pct: (disagreement.diffBps / 100).toFixed(1) })}
      </p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t('primary')}</dt>
          <dd className="font-medium">{formatPrice(disagreement.primary24k)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('fallback')}</dt>
          <dd className="font-medium">{formatPrice(disagreement.fallback24k)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('current')}</dt>
          <dd className="font-medium">{current24 === null ? '-' : formatPrice(current24)}</dd>
        </div>
      </dl>
      {canEdit && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={busy}
            onClick={() => void run(() => decideAll('confirm'))}
            variant="default"
          >
            {t('applyPrimary')}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void run(applyFallback)}
            variant="default"
          >
            {t('applyFallback')}
          </Button>
          <a href="#gold-rate-editor" className={buttonVariants({ variant: 'outline' })}>
            {t('manual')}
          </a>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void run(() => decideAll('reject'))}
            variant="outline"
          >
            {t('keep')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-ink">
          {error}
        </p>
      )}
    </section>
  );
}
