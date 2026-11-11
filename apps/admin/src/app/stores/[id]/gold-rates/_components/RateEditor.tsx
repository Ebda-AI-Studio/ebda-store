'use client';

/**
 * The manual rate editor. Rates are typed in EGP per gram (two decimals) and travel as integer piastres.
 * A rate far from the last one (or a 21k / 18k rate that disagrees with 24k) is refused by the server with
 * GOLD_RATE_CONFIRM_REQUIRED and nothing is written; the dialog shows what is off and the merchant confirms
 * or goes back (Ruling B5-20).
 */

import { useState } from 'react';
import { GOLD_KARATS, minorToDecimalString, tryToMinor, type GoldKarat } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiPut } from '../../../../../lib/api';
import { formatPrice } from '../../../../../lib/format';
import { RateAttribution } from './RateAttribution';
import type { RateView } from './types';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
interface ConfirmItem {
  karat: GoldKarat;
  jumpBps: number | null;
  coherenceBps: number | null;
  previous?: number | null;
}

export function RateEditor({
  storeId,
  rates,
  feedEnabled,
  canEdit,
  onSaved,
}: {
  storeId: string;
  rates: RateView[];
  feedEnabled: boolean;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const t = useT('goldRates.editor');
  const [values, setValues] = useState<Record<GoldKarat, string>>(() => {
    const init = {} as Record<GoldKarat, string>;
    for (const k of GOLD_KARATS) {
      const r = rates.find(x => x.karat === k)?.ratePerGram;
      init[k] = r ? minorToDecimalString(r) : '';
    }
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmItem[] | null>(null);

  const fillFrom24 = () => {
    const base = tryToMinor(values[24]);
    if (!base) return;
    setValues(v => ({
      ...v,
      21: minorToDecimalString(Math.round((base * 21) / 24)),
      18: minorToDecimalString(Math.round((base * 18) / 24)),
    }));
  };

  const submit = async (confirmed: boolean) => {
    const payload: { karat: GoldKarat; ratePerGram: number }[] = [];
    for (const k of GOLD_KARATS) {
      if (values[k].trim() === '') continue;
      const minor = tryToMinor(values[k]);
      if (!minor) {
        setError(t('invalid'));
        return;
      }
      payload.push({ karat: k, ratePerGram: minor });
    }
    if (payload.length === 0) {
      setError(t('nothing'));
      return;
    }
    setSaving(true);
    setError(null);
    const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/gold-rates`, {
      rates: payload,
      ...(confirmed ? { confirm: true } : {}),
    });
    setSaving(false);
    if (apiError) {
      if (apiError.code === 'GOLD_RATE_CONFIRM_REQUIRED') {
        const items = (apiError.details?.items as ConfirmItem[] | undefined) ?? [];
        setConfirm(items.length ? items : [{ karat: 24, jumpBps: null, coherenceBps: null }]);
        return;
      }
      setError(apiError.code === 'VALIDATION_ERROR' ? t('invalid') : t('saveFailed'));
      return;
    }
    setConfirm(null);
    onSaved();
  };

  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {feedEnabled ? t('bodyAuto') : t('bodyManual')}
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {GOLD_KARATS.map(k => {
          const current = rates.find(r => r.karat === k);
          return (
            <label key={k} className="block text-sm">
              <span className="font-medium">{t('karat', { karat: k })}</span>
              <input
                type="text"
                inputMode="decimal"
                dir="ltr"
                disabled={!canEdit}
                value={values[k]}
                onChange={e => setValues(v => ({ ...v, [k]: e.target.value }))}
                className={`${FIELD_CLASSES} mt-1 block`}
                aria-describedby={`gold-current-${String(k)}`}
              />
              <span
                id={`gold-current-${String(k)}`}
                className="mt-1 block text-xs text-muted-foreground"
              >
                {current?.ratePerGram
                  ? t('current', { rate: formatPrice(current.ratePerGram) })
                  : t('none')}
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive-ink">
          {error}
        </p>
      )}
      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={saving}
            onClick={() => void submit(false)}
            variant="default"
          >
            {t('save')}
          </Button>
          <Button type="button" onClick={fillFrom24} variant="outline">
            {t('fillFrom24')}
          </Button>
        </div>
      )}
      {feedEnabled && <RateAttribution className="mt-3" />}

      {confirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="gold-confirm-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
        >
          <div className="w-full max-w-md rounded-xl bg-card p-5 shadow-xl">
            <h3 id="gold-confirm-title" className="text-base font-semibold">
              {t('confirmTitle')}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('confirmBody')}</p>
            <ul className="mt-3 space-y-1 text-sm">
              {confirm.map(i => (
                <li key={i.karat}>
                  {t('karat', { karat: i.karat })}
                  {i.jumpBps !== null && i.jumpBps !== undefined
                    ? ` · ${t('jump', { pct: (i.jumpBps / 100).toFixed(1) })}`
                    : ''}
                  {i.coherenceBps
                    ? ` · ${t('coherence', { pct: (i.coherenceBps / 100).toFixed(1) })}`
                    : ''}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-3">
              <Button type="button" onClick={() => setConfirm(null)} variant="outline">
                {t('back')}
              </Button>
              <Button
                type="button"
                disabled={saving}
                onClick={() => void submit(true)}
                variant="default"
              >
                {t('confirmApply')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
