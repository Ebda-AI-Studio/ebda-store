'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../lib/api';

/**
 * "Allow cash on delivery and installments for gold" (Ruling SHARIA-GOLD-1). Default OFF. Turning it ON shows the
 * explanation and needs an explicit confirm; the API checks the confirm too and enforces the rule at order time.
 */
export function GoldPaymentPolicyCard({ storeId, canEdit }: { storeId: string; canEdit: boolean }) {
  const t = useT('goldRates.paymentPolicy');
  const url = `/api/v1/stores/${storeId}/gold-rates/payment-policy`;
  const [allow, setAllow] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void apiGet<{ allowDeferred: boolean }>(url).then(r => {
      if (live && r.data) setAllow(r.data.allowDeferred === true);
    });
    return () => {
      live = false;
    };
  }, [url]);

  const save = async () => {
    if (allow && !confirmed) {
      setMsg({ ok: false, text: t('needConfirm') });
      return;
    }
    setSaving(true);
    const { error } = await apiPut(url, {
      allowDeferred: allow,
      ...(allow ? { confirm: true } : {}),
    });
    setSaving(false);
    setMsg(error ? { ok: false, text: t('failed') } : { ok: true, text: t('saved') });
  };

  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      <label className="mt-4 flex min-h-11 items-start gap-3 text-sm">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={allow}
          onChange={e => {
            setAllow(e.target.checked);
            setConfirmed(false);
          }}
          className="mt-1 h-5 w-5"
        />
        <span className="font-medium">{t('allow')}</span>
      </label>
      {allow && (
        <div role="note" className="mt-3 rounded-md border bg-muted p-3 text-sm">
          <p>{t('explain')}</p>
          <label className="mt-3 flex min-h-11 items-start gap-3">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)}
              className="mt-1 h-5 w-5"
            />
            <span className="font-medium">{t('confirmCheck')}</span>
          </label>
        </div>
      )}
      {msg && (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`mt-3 text-sm ${msg.ok ? '' : 'text-destructive-ink'}`}
        >
          {msg.text}
        </p>
      )}
      {canEdit && (
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="mt-4 min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {t('save')}
        </button>
      )}
    </section>
  );
}
