'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
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
  // InstaPay is a manual method: the customer transfers to this handle/phone and the
  // merchant confirms receipt. Off by default; a handle or phone is required when on.
  const [instapay, setInstapay] = useState(false);
  const [handle, setHandle] = useState('');
  const [phone, setPhone] = useState('');
  const [accountName, setAccountName] = useState('');
  const instapayIncomplete = instapay && !handle.trim() && !phone.trim();
  const noMethod = !cod && !instapay;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleNext() {
    setError('');
    setSaving(true);
    const { error: apiError } = await apiPut(
      `/api/v1/onboarding/stores/${storeId}/payment-methods`,
      instapay
        ? {
            cod,
            instapay: {
              enabled: true,
              ...(handle.trim() ? { handle: handle.trim() } : {}),
              ...(phone.trim() ? { phone: phone.trim() } : {}),
              ...(accountName.trim() ? { accountName: accountName.trim() } : {}),
            },
          }
        : { cod }
    );
    setSaving(false);
    if (apiError) {
      setError(
        apiError.code === 'NO_PAYMENT_METHOD'
          ? t('needOne')
          : apiError.code === 'INVALID_PAYMENT_SETTINGS'
            ? t('instapayInvalid')
            : t('saveFailed')
      );
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
        <li className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('instapay')}</p>
              <p className="text-xs text-muted-foreground">{t('instapayDesc')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={instapay}
              aria-label={t('instapay')}
              onClick={() => setInstapay(v => !v)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                instapay ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                  instapay ? 'start-[1.375rem]' : 'start-0.5'
                }`}
              />
            </button>
          </div>
          {instapay && (
            <div className="space-y-3">
              <label className="block text-sm text-foreground">
                {t('handleLabel')}
                <input
                  type="text"
                  dir="ltr"
                  value={handle}
                  onChange={e => setHandle(e.target.value)}
                  placeholder={t('handlePlaceholder')}
                  autoComplete="off"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm text-foreground">
                {t('phoneLabel')}
                <input
                  type="tel"
                  dir="ltr"
                  inputMode="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder={t('phonePlaceholder')}
                  autoComplete="off"
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm text-foreground">
                {t('accountNameLabel')}
                <input
                  type="text"
                  value={accountName}
                  maxLength={80}
                  onChange={e => setAccountName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </label>
              {instapayIncomplete && (
                <p className="text-sm text-destructive-ink">{t('needHandleOrPhone')}</p>
              )}
            </div>
          )}
        </li>
      </ul>
      <div className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
        <p>{t('moreLater')}</p>
        <p className="mt-2">{t('manualNote')}</p>
      </div>
      {noMethod && <p className="text-sm text-destructive-ink">{t('needOne')}</p>}
      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {tFlow('back')}
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={saving || noMethod || instapayIncomplete}
          onClick={handleNext}
        >
          {tFlow('next')}
        </Button>
      </div>
    </div>
  );
}
