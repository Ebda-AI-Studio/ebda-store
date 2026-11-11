'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { withNumerals } from '@ebda/shared';
import { AccountsError, accountsFetch, accountsToken } from '../../lib/accounts';
import { isPasskeyCancel, passkeyRegistration, passkeysSupported } from '../../lib/passkeys';
import { useT } from '../../i18n/useT';

/**
 * Security settings: the signed-in merchant's passkeys (list with created / last used so an unknown one
 * stands out, add, rename, remove). Adding, renaming and removing need a recent step-up (password, plus a
 * TOTP code when TOTP is on): the API answers 403 STEP_UP_REQUIRED and this panel asks, then retries
 * (Ruling PASSKEY-7). Removing a passkey signs the account out everywhere (PASSKEY-9).
 */
/** An identity-service refusal in the shape this panel's error handling expects. */
interface ApiError {
  code?: string;
  message?: string;
}

/** Authenticated call to the identity service: a fresh 15 minute token as Bearer. */
async function acct<T>(path: string, json?: unknown): Promise<T> {
  const grant = await accountsToken();
  try {
    return await accountsFetch<T>(path, { json, bearer: grant.access_token });
  } catch (e) {
    if (e instanceof AccountsError) throw { code: e.code, message: e.message } satisfies ApiError;
    throw e;
  }
}

interface PasskeyItem {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  needsReenrol: boolean;
}

type Action = () => Promise<void>;

export function PasskeysPanel({
  mfaEnabled,
  isAdmin = false,
  onCount,
  onSignInAgain,
}: {
  mfaEnabled: boolean;
  /** A platform administrator's FIRST factor also needs the operator's one-time enrolment token. */
  isAdmin?: boolean;
  /** Reports how many passkeys the account has (the page needs it to know whether a TOTP would be a FIRST factor). */
  onCount?: (n: number) => void;
  /** The first factor of a platform admin ends every session: the page signs them out to sign in again with it. */
  onSignInAgain?: () => void;
}) {
  const t = useT('account.security.passkeys');
  const ts = useT('account.security');
  const tc = useT('common');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { success: toastSuccess, error: toastError } = useToast();

  const [supported, setSupported] = useState(false);
  const [items, setItems] = useState<PasskeyItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  // Step-up form: shown when an action was refused for lack of a recent re-auth.
  const pending = useRef<Action | null>(null);
  // The identity service asks for the password (and a TOTP code when TOTP is on) with EACH sensitive call; they are held only
  // for the one retry after the step-up form and then dropped.
  const creds = useRef<{
    password: string;
    code?: string;
    emailCode?: string;
    enrolmentToken?: string;
  } | null>(null);
  const [askStepUp, setAskStepUp] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stepUpError, setStepUpError] = useState('');
  // The FIRST sign-in factor of an account (no TOTP, no passkey) also needs a code e-mailed to the account.
  const [emailCode, setEmailCode] = useState('');
  const [enrolToken, setEnrolToken] = useState('');
  const [codeSent, setCodeSent] = useState(false);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(
      locale,
      withNumerals({ year: 'numeric', month: 'short', day: 'numeric' })
    );

  const load = useCallback(async () => {
    try {
      const data = await acct<{
        passkeys: Array<{
          id: string;
          name: string;
          rp_id: string;
          backed_up: number;
          created_at: string;
          last_used_at: string | null;
        }>;
      }>('/passkeys');
      onCount?.(data.passkeys.length);
      setItems(
        data.passkeys.map(p => ({
          id: p.id,
          name: p.name,
          createdAt: p.created_at,
          lastUsedAt: p.last_used_at,
          backedUp: !!p.backed_up,
          // Registered for a different host than this page: the browser will not offer it here.
          needsReenrol: p.rp_id !== window.location.hostname,
        }))
      );
    } catch {
      toastError(t('errorLoad'), undefined);
      setItems([]);
    }
  }, [t, toastError, onCount]);

  useEffect(() => {
    setSupported(passkeysSupported());
    void load();
  }, [load]);

  /** Run an action; if the API wants a step-up first, park it, ask, and retry once confirmed. */
  async function run(action: Action) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      const err = e as Partial<ApiError> & { name?: string };
      if (
        err.code === 'STEP_UP_REQUIRED' ||
        err.code === 'MFA_REQUIRED' ||
        err.code === 'EMAIL_CODE_REQUIRED' ||
        err.code === 'EMAIL_CODE_INVALID'
      ) {
        pending.current = action;
        setStepUpError('');
        setAskStepUp(true);
      } else if (!isPasskeyCancel(e)) {
        toastError(err.message || t('errorGeneric'), undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  const needCreds = (): {
    password: string;
    code?: string;
    emailCode?: string;
    enrolmentToken?: string;
  } => {
    if (!creds.current) throw { code: 'STEP_UP_REQUIRED' } satisfies ApiError;
    return creds.current;
  };

  const addPasskey: Action = async () => {
    const c = needCreds();
    try {
      const options = await acct<never>('/passkey/register/options', c);
      creds.current = null; // one use
      const response = await passkeyRegistration(options);
      const done = await acct<{ requiresSignIn?: boolean }>('/passkey/register/verify', {
        response,
        name: name.trim() || undefined,
        ...(c.emailCode ? { emailCode: c.emailCode } : {}),
        ...(c.enrolmentToken ? { enrolmentToken: c.enrolmentToken } : {}),
      });
      if (done?.requiresSignIn) {
        toastSuccess(t('added'), undefined);
        onSignInAgain?.();
        return;
      }
    } catch (e) {
      creds.current = null;
      throw e;
    }
    setName('');
    toastSuccess(t('added'), undefined);
    await load();
  };

  const renamePasskey =
    (id: string, value: string): Action =>
    async () => {
      await acct(`/passkeys/${id}/rename`, { name: value });
      setRenameId(null);
      toastSuccess(t('renamed'), undefined);
      await load();
    };

  const removePasskey =
    (id: string): Action =>
    async () => {
      const c = needCreds();
      creds.current = null;
      await acct(`/passkeys/${id}/delete`, c);
      setRemoveId(null);
      toastSuccess(t('removed'), undefined);
      await load();
    };

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setStepUpError('');
    setBusy(true);
    try {
      creds.current = {
        password,
        ...(mfaEnabled ? { code: code.trim() } : {}),
        ...(emailCode.trim() ? { emailCode: emailCode.trim() } : {}),
        ...(enrolToken.trim() ? { enrolmentToken: enrolToken.trim() } : {}),
      };
      setPassword('');
      setCode('');
      setEmailCode('');
      setEnrolToken('');
      setCodeSent(false);
      setAskStepUp(false);
      const next = pending.current;
      pending.current = null;
      if (next) await run(next);
    } finally {
      setBusy(false);
    }
  }

  if (!supported && items !== null && items.length === 0) {
    return (
      <section
        className="rounded-2xl border border-border bg-card p-6"
        aria-labelledby="passkeys-title"
      >
        <h3 id="passkeys-title" className="font-semibold text-foreground">
          {t('title')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('unsupported')}</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-card" aria-labelledby="passkeys-title">
      <div className="border-b border-border p-5">
        <h3 id="passkeys-title" className="font-semibold text-foreground">
          {t('title')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {askStepUp && (
        <form onSubmit={submitStepUp} className="space-y-3 border-b border-border bg-muted/40 p-5">
          <p className="text-sm font-medium text-foreground">{t('stepUpTitle')}</p>
          <p className="text-sm text-muted-foreground">
            {mfaEnabled ? t('stepUpDescriptionMfa') : t('stepUpDescription')}
          </p>
          {stepUpError && (
            <div
              role="alert"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
            >
              {stepUpError}
            </div>
          )}
          <div>
            <label
              htmlFor="passkey-stepup-password"
              className="block text-sm font-medium text-foreground"
            >
              {t('passwordLabel')}
            </label>
            <Input
              id="passkey-stepup-password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="mt-1"
            />
          </div>
          {mfaEnabled && (
            <div>
              <label
                htmlFor="passkey-stepup-code"
                className="block text-sm font-medium text-foreground"
              >
                {t('codeLabel')}
              </label>
              <Input
                id="passkey-stepup-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={e => setCode(e.target.value)}
                className="mt-1 text-center tracking-widest"
                maxLength={6}
              />
            </div>
          )}
          {!mfaEnabled && (items?.length ?? 0) === 0 && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{ts('firstFactorEmailHint')}</p>
              {isAdmin && (
                <div>
                  <label
                    htmlFor="passkey-enrol-token"
                    className="block text-sm font-medium text-foreground"
                  >
                    {ts('bootstrapTokenLabel')}
                  </label>
                  <Input
                    id="passkey-enrol-token"
                    type="text"
                    dir="ltr"
                    autoComplete="off"
                    value={enrolToken}
                    onChange={e => setEnrolToken(e.target.value)}
                    className="mt-1"
                  />
                </div>
              )}
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label
                    htmlFor="passkey-email-code"
                    className="block text-sm font-medium text-foreground"
                  >
                    {ts('bootstrapCodeLabel')}
                  </label>
                  <Input
                    id="passkey-email-code"
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    autoComplete="off"
                    maxLength={6}
                    value={emailCode}
                    onChange={e => setEmailCode(e.target.value)}
                    className="mt-1 text-center tracking-widest"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !password}
                  onClick={async () => {
                    setStepUpError('');
                    try {
                      await acct('/mfa/bootstrap/code', { password });
                      setCodeSent(true);
                    } catch (e) {
                      setStepUpError((e as ApiError).message || t('errorGeneric'));
                    }
                  }}
                >
                  {codeSent ? ts('bootstrapResend') : ts('bootstrapSend')}
                </Button>
              </div>
            </div>
          )}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => {
                pending.current = null;
                setAskStepUp(false);
                setPassword('');
                setCode('');
              }}
            >
              {tc('cancel')}
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={
                busy ||
                !password ||
                (!mfaEnabled &&
                  (items?.length ?? 0) === 0 &&
                  (emailCode.trim().length !== 6 || (isAdmin && !enrolToken.trim())))
              }
            >
              {t('stepUpConfirm')}
            </Button>
          </div>
        </form>
      )}

      <ul className="divide-y divide-border">
        {items === null && <li className="p-5 text-sm text-muted-foreground">{t('loading')}</li>}
        {items?.length === 0 && <li className="p-5 text-sm text-muted-foreground">{t('empty')}</li>}
        {items?.map(p => (
          <li key={p.id} className="space-y-3 p-5">
            {renameId === p.id ? (
              <form
                className="flex gap-3"
                onSubmit={e => {
                  e.preventDefault();
                  void run(renamePasskey(p.id, renameValue.trim()));
                }}
              >
                <Input
                  aria-label={t('nameLabel')}
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  maxLength={60}
                  required
                  autoFocus
                />
                <Button type="submit" disabled={busy || !renameValue.trim()}>
                  {t('save')}
                </Button>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('addedOn', { date: fmt(p.createdAt) })}
                    {' · '}
                    {p.lastUsedAt ? t('lastUsed', { date: fmt(p.lastUsedAt) }) : t('neverUsed')}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRenameId(p.id);
                      setRenameValue(p.name);
                      setRemoveId(null);
                    }}
                  >
                    {t('rename')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRemoveId(p.id);
                      setRenameId(null);
                    }}
                  >
                    {t('remove')}
                  </Button>
                </div>
              </div>
            )}
            {removeId === p.id && (
              <div className="rounded-xl border border-destructive/30 p-4">
                <p className="text-sm text-foreground">{t('removeConfirm')}</p>
                <div className="mt-3 flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setRemoveId(null)}
                  >
                    {tc('cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    className="flex-1"
                    disabled={busy}
                    onClick={() => void run(removePasskey(p.id))}
                  >
                    {t('removeConfirmCta')}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {supported && (
        <div className="flex flex-col gap-3 border-t border-border p-5 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="passkey-name" className="block text-sm font-medium text-foreground">
              {t('nameLabel')}
            </label>
            <Input
              id="passkey-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              maxLength={60}
              className="mt-1"
            />
          </div>
          <Button type="button" disabled={busy} onClick={() => void run(addPasskey)}>
            {t('add')}
          </Button>
        </div>
      )}
    </section>
  );
}
