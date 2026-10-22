'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { Button, Input, useToast } from '@ebda/ui';
import { withNumerals } from '@ebda/shared';
import { apiDelete, apiGet, apiPatch, apiPost, type ApiError } from '../../lib/api';
import { isPasskeyCancel, passkeyRegistration, passkeysSupported } from '../../lib/passkeys';
import { useT } from '../../i18n/useT';

/**
 * Security settings: the signed-in merchant's passkeys (list with created / last used so an unknown one
 * stands out, add, rename, remove). Adding, renaming and removing need a recent step-up (password, plus a
 * TOTP code when TOTP is on): the API answers 403 STEP_UP_REQUIRED and this panel asks, then retries
 * (Ruling PASSKEY-7). Removing a passkey signs the account out everywhere (PASSKEY-9).
 */
interface PasskeyItem {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  needsReenrol: boolean;
}

type Action = () => Promise<void>;

export function PasskeysPanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const t = useT('account.security.passkeys');
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
  const [askStepUp, setAskStepUp] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stepUpError, setStepUpError] = useState('');

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(
      locale,
      withNumerals({ year: 'numeric', month: 'short', day: 'numeric' })
    );

  const load = useCallback(async () => {
    const { data, error } = await apiGet<{ passkeys: PasskeyItem[] }>('/api/v1/auth/passkeys');
    if (error || !data) {
      toastError(t('errorLoad'), undefined);
      setItems([]);
      return;
    }
    setItems(data.passkeys);
  }, [t, toastError]);

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
      if (err.code === 'STEP_UP_REQUIRED') {
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

  const fail = (error: ApiError): never => {
    throw error;
  };

  const addPasskey: Action = async () => {
    const begin = await apiPost<never>('/api/v1/auth/passkeys/register/begin', {});
    if (begin.error || !begin.data) return fail(begin.error as ApiError);
    const response = await passkeyRegistration(begin.data);
    const fin = await apiPost('/api/v1/auth/passkeys/register/finish', {
      response,
      name: name.trim() || undefined,
    });
    if (fin.error) return fail(fin.error);
    setName('');
    toastSuccess(t('added'), undefined);
    await load();
  };

  const renamePasskey =
    (id: string, value: string): Action =>
    async () => {
      const r = await apiPatch(`/api/v1/auth/passkeys/${id}`, { name: value });
      if (r.error) return fail(r.error);
      setRenameId(null);
      toastSuccess(t('renamed'), undefined);
      await load();
    };

  const removePasskey =
    (id: string): Action =>
    async () => {
      const r = await apiDelete(`/api/v1/auth/passkeys/${id}`);
      if (r.error) return fail(r.error);
      setRemoveId(null);
      toastSuccess(t('removed'), undefined);
      await load();
    };

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setStepUpError('');
    setBusy(true);
    try {
      const { error } = await apiPost('/api/v1/auth/passkeys/step-up', {
        password,
        ...(mfaEnabled ? { code: code.trim() } : {}),
      });
      if (error) {
        setStepUpError(t('stepUpFailed'));
        return;
      }
      setPassword('');
      setCode('');
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
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1"
              onClick={() => {
                pending.current = null;
                setAskStepUp(false);
                setPassword('');
                setCode('');
              }}
            >
              {tc('cancel')}
            </Button>
            <Button type="submit" className="min-h-11 flex-1" disabled={busy || !password}>
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
                <Button type="submit" className="min-h-11" disabled={busy || !renameValue.trim()}>
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
                    className="min-h-11"
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
                    className="min-h-11"
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
                    className="min-h-11 flex-1"
                    onClick={() => setRemoveId(null)}
                  >
                    {tc('cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-11 flex-1"
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
          <Button
            type="button"
            className="min-h-11"
            disabled={busy}
            onClick={() => void run(addPasskey)}
          >
            {t('add')}
          </Button>
        </div>
      )}
    </section>
  );
}
