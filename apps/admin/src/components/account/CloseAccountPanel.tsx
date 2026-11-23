'use client';

import { useState } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';

/**
 * Security settings: the merchant / staff "close my account" button (M-024, Ruling M024-1, plan row 33 / S2c). It calls
 * `POST /auth/me/close-account`, which runs the PDPL erasure job when `PDPL_CF_ERASURE_ENABLED` is on. Irreversible, so the
 * button stays disabled until the person types the confirmation word. The server owns every refusal (live billed store,
 * money in flight, flag off = 503 ERASURE_NOT_ENABLED with an honest bilingual message) and its message is shown as is; a
 * success ends the session (the server already cleared the cookies).
 */
export function CloseAccountPanel({ onClosed }: { onClosed: () => void }) {
  const t = useT('account.security.closeAccount');
  const { success: toastSuccess } = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = async () => {
    setBusy(true);
    setError(null);
    const { data, error: err } = await apiPost<{ status: string }>('/auth/me/close-account');
    setBusy(false);
    if (err || !data) {
      setError(err?.message || t('errorGeneric'));
      return;
    }
    toastSuccess(t('done'));
    onClosed();
  };

  return (
    <section
      className="space-y-3 rounded-lg border border-destructive/40 bg-card p-4"
      aria-labelledby="close-account-title"
    >
      <h2 id="close-account-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="grid gap-2 sm:max-w-sm">
        <label className="text-sm" htmlFor="close-account-confirm">
          {t('confirmLabel', { word: t('confirmWord') })}
        </label>
        <Input
          id="close-account-confirm"
          autoComplete="off"
          value={typed}
          onChange={e => setTyped(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {error}
          </p>
        )}
        <Button
          type="button"
          variant="destructive"
          onClick={() => void close()}
          disabled={busy || typed.trim() !== t('confirmWord')}
        >
          {busy ? t('closing') : t('button')}
        </Button>
      </div>
    </section>
  );
}
