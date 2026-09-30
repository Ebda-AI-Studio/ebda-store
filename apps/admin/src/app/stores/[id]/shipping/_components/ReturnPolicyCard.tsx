'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../lib/api';

/**
 * Return-policy control.
 *
 * Feeds `hasMerchantReturnPolicy` in the storefront's Product JSON-LD, which is
 * one of the first fields an AI shopping agent filters on. That makes "empty"
 * meaningfully empty and worth spelling out in the copy:
 *
 *   blank -> publish NO return policy at all (we haven't said)
 *   0     -> publish "returns not accepted"
 *   N     -> publish an N-day return window
 *
 * A merchant typing a number here is making a public commitment that Google and
 * buying agents will treat as binding, so we never pre-fill a default.
 */
export function ReturnPolicyCard({ storeId }: { storeId: string }) {
  const t = useT('shipping.returnPolicy');
  const [days, setDays] = useState('');
  const [feesPaidBy, setFeesPaidBy] = useState('customer');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await apiGet<{
        store?: { returnWindowDays?: number | null; returnFeesPaidBy?: string | null };
      }>(`/api/v1/stores/${storeId}`);
      if (cancelled) return;
      const store = data?.store;
      // `?? ''` not `|| ''` — 0 is a real value here, not "empty".
      setDays(
        store?.returnWindowDays === null || store?.returnWindowDays === undefined
          ? ''
          : String(store.returnWindowDays)
      );
      setFeesPaidBy(store?.returnFeesPaidBy ?? 'customer');
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const trimmed = days.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      setError(t('invalid'));
      setSaving(false);
      return;
    }
    const { error: err } = await apiPut(`/api/v1/stores/${storeId}`, {
      returnWindowDays: parsed,
      // Clearing the window clears who pays too — a fee rule with no window
      // is meaningless and would linger as stale state.
      returnFeesPaidBy: parsed === null ? null : feesPaidBy,
    });
    if (err) setError(err.message);
    else setSaved(true);
    setSaving(false);
  };

  if (loading) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('help')}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="return-window-days" className="block text-xs font-medium text-foreground">
            {t('windowLabel')}
          </label>
          <input
            id="return-window-days"
            type="number"
            min={0}
            value={days}
            onChange={e => setDays(e.target.value)}
            placeholder={t('notDeclared')}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="return-fees-paid-by"
            className="block text-xs font-medium text-foreground"
          >
            {t('feesLabel')}
          </label>
          <select
            id="return-fees-paid-by"
            value={feesPaidBy}
            onChange={e => setFeesPaidBy(e.target.value)}
            disabled={days.trim() === ''}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="customer">{t('feesCustomer')}</option>
            <option value="merchant">{t('feesMerchant')}</option>
          </select>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {saving ? t('saving') : t('save')}
        </button>
        {saved && <span className="text-xs text-success-ink">{t('saved')}</span>}
        {error && <span className="text-xs text-destructive-ink">{error}</span>}
      </div>
    </div>
  );
}
