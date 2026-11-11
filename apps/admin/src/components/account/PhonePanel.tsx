'use client';

import { useCallback, useEffect, useState } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AccountsError, accountsFetch, accountsToken } from '../../lib/accounts';
import { useT } from '../../i18n/useT';

/**
 * Security settings: the merchant's account phone (Ruling PHONE-CHANGE-1). The identity service owns the number
 * (`POST /phone`); changing it is a recovery-channel change, so it asks for the current password and, when the account
 * has an authenticator, a code. Each call gets a fresh 15 minute token as Bearer, like the other panels on this page.
 */
export function PhonePanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const t = useT('account.security.phone');
  const { success: toastSuccess } = useToast();
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const grant = await accountsToken();
      const me = await accountsFetch<{ user: { phone: string | null } }>('/me', {
        bearer: grant.access_token,
      });
      setCurrent(me.user.phone ?? null);
    } catch {
      setCurrent(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const message = (e: AccountsError): string => {
    if (e.code === 'STEP_UP_REQUIRED') return t('errorPassword');
    if (e.code === 'MFA_REQUIRED') return t('errorCode');
    if (e.status === 429) return t('errorThrottle');
    if (e.status === 400) return t('errorInvalid');
    return t('errorGeneric');
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const grant = await accountsToken();
      const r = await accountsFetch<{ phone: string }>('/phone', {
        json: { phone, password, ...(mfaEnabled && code ? { code } : {}) },
        bearer: grant.access_token,
      });
      setCurrent(r.phone);
      setPhone('');
      setPassword('');
      setCode('');
      toastSuccess(t('saved'));
    } catch (e) {
      setError(e instanceof AccountsError ? message(e) : t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="phone-title">
      <h2 id="phone-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <p className="text-sm" dir="ltr">
        <span className="text-muted-foreground">{t('current')}: </span>
        {current === undefined ? '…' : (current ?? t('none'))}
      </p>
      <div className="grid gap-2 sm:max-w-sm">
        <label className="text-sm" htmlFor="phone-new">
          {t('newLabel')}
        </label>
        <Input
          id="phone-new"
          type="tel"
          inputMode="tel"
          dir="ltr"
          autoComplete="tel"
          placeholder={t('newPlaceholder')}
          value={phone}
          onChange={e => setPhone(e.target.value)}
        />
        <label className="text-sm" htmlFor="phone-password">
          {t('passwordLabel')}
        </label>
        <Input
          id="phone-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        {mfaEnabled && (
          <>
            <label className="text-sm" htmlFor="phone-code">
              {t('codeLabel')}
            </label>
            <Input
              id="phone-code"
              inputMode="numeric"
              dir="ltr"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value)}
            />
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {error}
          </p>
        )}
        <Button onClick={() => void save()} disabled={busy || !phone || !password}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </section>
  );
}
