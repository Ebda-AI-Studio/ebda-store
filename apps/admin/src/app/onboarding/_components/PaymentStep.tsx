'use client';

import { useState } from 'react';
import { Button } from '@force/ui';
import { apiPut } from '../../../lib/api';
import { useT } from '@/i18n/useT';

export function PaymentStep({
  storeId,
  initialCod,
  onBack,
  onDone,
}: {
  storeId: string;
  initialCod: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const t = useT('onboarding.flow.payment');
  const tFlow = useT('onboarding.flow');
  // COD is on by default; the store is seeded with it enabled.
  const [cod, setCod] = useState(initialCod);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleNext() {
    setError('');
    setSaving(true);
    const { error: apiError } = await apiPut(
      `/api/v1/onboarding/stores/${storeId}/payment-methods`,
      {
        cod,
      }
    );
    setSaving(false);
    if (apiError) {
      setError(apiError.code === 'NO_PAYMENT_METHOD' ? t('needOne') : t('saveFailed'));
      return;
    }
    onDone();
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {error}
        </div>
      )}
      <ul className="space-y-3">
        <li className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t('cod')}</p>
            <p className="text-xs text-muted-foreground">{t('codDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cod}
            aria-label={t('cod')}
            onClick={() => setCod(v => !v)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              cod ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                cod ? 'start-[1.375rem]' : 'start-0.5'
              }`}
            />
          </button>
        </li>
      </ul>
      <p className="text-sm text-muted-foreground">{t('moreLater')}</p>
      {!cod && <p className="text-sm text-destructive-ink">{t('needOne')}</p>}
      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {tFlow('back')}
        </Button>
        <Button type="button" className="flex-1" disabled={saving || !cod} onClick={handleNext}>
          {tFlow('next')}
        </Button>
      </div>
    </div>
  );
}
