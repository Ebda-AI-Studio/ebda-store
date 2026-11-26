'use client';

import { useCallback, useEffect, useState } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AccountsError, accountsFetch, accountsToken } from '../../lib/accounts';
import { useT } from '../../i18n/useT';

/**
 * Security settings: MFA recovery codes (self-service gap A23). The identity service keeps only hashes and counts the
 * unused ones (`GET /mfa/recovery-codes`); making a new set (`POST /mfa/recovery-codes/regenerate`) needs the password AND
 * a live authenticator code and retires every old code. The new codes are shown once, here, and never stored in the browser.
 */
export function RecoveryCodesPanel() {
  const t = useT('account.security.recovery');
  const { success: toastSuccess } = useToast();
  const [remaining, setRemaining] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);

  // The old set is already dead once new codes exist: warn before the page is left with codes not yet saved.
  useEffect(() => {
    if (fresh.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [fresh]);

  const load = useCallback(async () => {
    try {
      const grant = await accountsToken();
      const r = await accountsFetch<{ remaining: number }>('/mfa/recovery-codes', {
        bearer: grant.access_token,
      });
      setRemaining(r.remaining);
    } catch {
      setRemaining(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const message = (e: AccountsError): string => {
    if (e.code === 'STEP_UP_REQUIRED') return t('errorPassword');
    if (e.code === 'INVALID_CODE') return t('errorCode');
    if (e.status === 429) return t('errorThrottle');
    return t('errorGeneric');
  };

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const grant = await accountsToken();
      const r = await accountsFetch<{ backupCodes: string[] }>('/mfa/recovery-codes/regenerate', {
        json: { password, code },
        bearer: grant.access_token,
      });
      setFresh(r.backupCodes);
      setRemaining(r.backupCodes.length);
      setPassword('');
      setCode('');
      toastSuccess(t('done'));
    } catch (e) {
      setError(e instanceof AccountsError ? message(e) : t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded-lg border bg-card p-4"
      aria-labelledby="recovery-title"
      data-testid="recovery-codes-panel"
    >
      <h2 id="recovery-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      {remaining !== null && (
        <p className="text-sm">{t('remaining', { count: String(remaining) })}</p>
      )}
      {fresh.length > 0 && (
        <div>
          <p className="text-sm font-medium">{t('saveNow')}</p>
          <div
            dir="ltr"
            className="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-4 font-mono text-sm"
          >
            {fresh.map(c => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <Button type="button" variant="outline" className="mt-2" onClick={() => setFresh([])}>
            {t('saved')}
          </Button>
        </div>
      )}
      <div className="grid gap-2 sm:max-w-sm">
        <label className="text-sm" htmlFor="recovery-password">
          {t('passwordLabel')}
        </label>
        <Input
          id="recovery-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        <label className="text-sm" htmlFor="recovery-code">
          {t('codeLabel')}
        </label>
        <Input
          id="recovery-code"
          inputMode="numeric"
          dir="ltr"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={e => setCode(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {error}
          </p>
        )}
        <Button onClick={() => void regenerate()} disabled={busy || !password || code.length !== 6}>
          {busy ? t('working') : t('regenerate')}
        </Button>
      </div>
    </section>
  );
}
