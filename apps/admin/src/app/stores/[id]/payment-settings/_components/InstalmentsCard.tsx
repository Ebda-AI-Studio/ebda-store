'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { instalmentsSchema, minorToDecimalString } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../lib/api';
import { buildInstalmentsPayload } from '../../../../../lib/instalments-payload';

/**
 * The merchant's PDP instalment estimate (`settings.instalments`, Ruling B2-9). One small card:
 * an honesty line first, then the numbers. Saved with a shallow settings merge; "Remove" sends an
 * explicit null (an omitted key would leave the stored value, the clear-on-empty rule).
 */
export function InstalmentsCard({ storeId }: { storeId: string }) {
  const t = useT('paymentSettings.instalments');
  const [enabled, setEnabled] = useState(false);
  const [months, setMonths] = useState('12');
  const [markup, setMarkup] = useState('0');
  const [providerEn, setProviderEn] = useState('');
  const [providerAr, setProviderAr] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await apiGet<{ settings?: Record<string, unknown> }>(
      `/api/v1/stores/${storeId}`
    );
    if (error) {
      setMsg({ ok: false, text: t('loadFailed') });
      return;
    }
    const parsed = instalmentsSchema.safeParse(data?.settings?.instalments);
    if (!parsed.success) return;
    const s = parsed.data;
    setEnabled(s.enabled);
    setMonths(String(s.months));
    setMarkup(String(s.markupPct));
    setProviderEn(s.providerEn ?? '');
    setProviderAr(s.providerAr ?? '');
    setMinPrice(s.minPrice ? minorToDecimalString(s.minPrice) : '');
  }, [storeId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (remove: boolean) => {
    setBusy(true);
    setMsg(null);
    const instalments = remove
      ? null
      : buildInstalmentsPayload({ enabled, months, markup, providerEn, providerAr, minPrice });
    if (instalments === 'invalid') {
      setMsg({ ok: false, text: t('failed') });
      setBusy(false);
      return;
    }
    const { error } = await apiPut(`/api/v1/stores/${storeId}`, { settings: { instalments } });
    setMsg(
      error
        ? { ok: false, text: t('failed') }
        : { ok: true, text: remove ? t('removed') : t('saved') }
    );
    if (!error && remove) {
      setEnabled(false);
      setProviderEn('');
      setProviderAr('');
      setMinPrice('');
    }
    setBusy(false);
  };

  const input = 'rounded-lg border border-border bg-background px-3 py-2 text-sm';
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm"
      data-testid="instalments-card"
      data-setting-id="payment.instalments"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs font-medium text-foreground">{t('honesty')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        {t('enable')}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('months')}</span>
          <input
            type="number"
            inputMode="numeric"
            min={3}
            max={60}
            step={1}
            value={months}
            onChange={e => setMonths(e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('markup')}</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="0.1"
            value={markup}
            onChange={e => setMarkup(e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('providerAr')}</span>
          <input
            type="text"
            maxLength={40}
            value={providerAr}
            onChange={e => setProviderAr(e.target.value)}
            className={input}
            dir="rtl"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('providerEn')}</span>
          <input
            type="text"
            maxLength={40}
            value={providerEn}
            onChange={e => setProviderEn(e.target.value)}
            className={input}
            dir="ltr"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('minPrice')}</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={minPrice}
            onChange={e => setMinPrice(e.target.value)}
            className={input}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => save(false)} disabled={busy}>
          {t('save')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          type="button"
          onClick={() => save(true)}
          disabled={busy}
        >
          {t('remove')}
        </Button>
        {msg && (
          <span
            role="status"
            className={`text-xs ${msg.ok ? 'text-success-ink' : 'text-destructive-ink'}`}
          >
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}
