'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, useToast } from '@ebda/ui';
import { withNumerals } from '@ebda/shared';
import { api } from '@/lib/api';
import { isPasskeyCancel, passkeysSupported, runPasskeyRegistration } from '@/lib/passkeys';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Account page: the shopper's passkeys for THIS store (Face ID / Touch ID / Windows Hello). Optional.
 * A passkey belongs to the host it was made on; after the store moves to a custom domain it is listed as
 * "needs re-enrol" and can be added again here (Ruling PASSKEY-3). Add / rename / remove ask for the
 * password first (step-up, PASSKEY-7); removing signs the shopper out on all devices (PASSKEY-9).
 */
interface Item {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  needsReenrol: boolean;
}
type Action = () => Promise<void>;
interface ApiErr {
  code?: string;
  message?: string;
}

class ActionError extends Error {
  constructor(public code?: string) {
    super(code);
  }
}

export default function PasskeysCard() {
  const { t, language } = useLanguage();
  const { success, error: toastError } = useToast();
  const [supported, setSupported] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const pending = useRef<Action | null>(null);
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [stepUpError, setStepUpError] = useState('');

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(
      language === 'ar' ? 'ar-EG' : 'en-GB',
      withNumerals({ year: 'numeric', month: 'short', day: 'numeric' })
    );

  const load = useCallback(async () => {
    const r = await api.get<{ passkeys: Item[] }>('/auth/passkeys');
    setItems(r.success && r.data ? r.data.passkeys : []);
  }, []);

  useEffect(() => {
    setSupported(passkeysSupported());
    void load();
  }, [load]);

  async function run(action: Action) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      if ((e as ActionError).code === 'STEP_UP_REQUIRED') {
        pending.current = action;
        setStepUpError('');
        setAskPassword(true);
      } else if (!isPasskeyCancel(e)) {
        toastError(
          t(
            'Something went wrong. Nothing was changed.',
            '\u062d\u0635\u0644\u062a \u0645\u0634\u0643\u0644\u0629. \u0645\u0641\u064a\u0634 \u062d\u0627\u062c\u0629 \u0627\u062a\u063a\u064a\u0651\u0631\u062a.'
          ),
          undefined
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const check = (r: { success: boolean; error?: ApiErr }) => {
    if (!r.success) throw new ActionError(r.error?.code);
  };

  const add: Action = async () => {
    const begin = await api.post<unknown>('/auth/passkeys/register/begin', {});
    check(begin);
    const response = await runPasskeyRegistration(
      begin.data as Parameters<typeof runPasskeyRegistration>[0]
    );
    check(
      await api.post('/auth/passkeys/register/finish', {
        response,
        name: name.trim() || undefined,
      })
    );
    setName('');
    success(
      t(
        'Passkey added',
        '\u0627\u062a\u0636\u0627\u0641 \u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631'
      ),
      undefined
    );
    await load();
  };

  const rename =
    (id: string, value: string): Action =>
    async () => {
      check(await api.patch(`/auth/passkeys/${id}`, { name: value }));
      setRenameId(null);
      success(
        t('Name updated', '\u0627\u0644\u0627\u0633\u0645 \u0627\u062a\u0639\u062f\u0651\u0644'),
        undefined
      );
      await load();
    };

  const remove =
    (id: string): Action =>
    async () => {
      check(await api.delete(`/auth/passkeys/${id}`));
      setRemoveId(null);
      success(
        t(
          'Passkey removed',
          '\u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u062a\u0645\u0633\u062d'
        ),
        undefined
      );
      await load();
    };

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/auth/passkeys/step-up', { password });
      if (!r.success) {
        setStepUpError(
          t(
            'That password did not match. Try again.',
            '\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0645\u0634 \u0645\u0638\u0628\u0648\u0637\u0629. \u062c\u0631\u0651\u0628 \u062a\u0627\u0646\u064a.'
          )
        );
        return;
      }
      setPassword('');
      setAskPassword(false);
      const next = pending.current;
      pending.current = null;
      if (next) await run(next);
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;

  return (
    <div className="rounded-xl border bg-card shadow-sm" data-passkeys-card>
      <div className="border-b p-4">
        <h2 className="font-semibold text-foreground">
          {t(
            'Face ID and passkeys',
            '\u0628\u0635\u0645\u0629 \u0627\u0644\u0648\u062c\u0647 \u0648\u0645\u0641\u0627\u062a\u064a\u062d \u0627\u0644\u0645\u0631\u0648\u0631'
          )}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            'Sign in to this store with Face ID, your fingerprint or your phone lock instead of typing a password. It is optional.',
            '\u0627\u062f\u062e\u0644 \u0639\u0644\u0649 \u0627\u0644\u0645\u062a\u062c\u0631 \u062f\u0647 \u0628\u0628\u0635\u0645\u0629 \u0627\u0644\u0648\u062c\u0647 \u0623\u0648 \u0628\u0635\u0645\u0629 \u0627\u0644\u0625\u0635\u0628\u0639 \u0623\u0648 \u0642\u0641\u0644 \u0645\u0648\u0628\u0627\u064a\u0644\u0643 \u0628\u062f\u0644 \u0645\u0627 \u062a\u0643\u062a\u0628 \u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631. \u062f\u0647 \u0627\u062e\u062a\u064a\u0627\u0631\u064a.'
          )}
        </p>
      </div>

      {askPassword && (
        <form onSubmit={submitStepUp} className="space-y-3 border-b bg-muted/40 p-4">
          <p className="text-sm text-foreground">
            {t(
              'Type your password once to confirm it is you.',
              '\u0627\u0643\u062a\u0628 \u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0645\u0631\u0629 \u0648\u0627\u062d\u062f\u0629 \u0639\u0634\u0627\u0646 \u0646\u062a\u0623\u0643\u062f \u0625\u0646\u0647 \u0625\u0646\u062a.'
            )}
          </p>
          {stepUpError && (
            <div
              role="alert"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
            >
              {stepUpError}
            </div>
          )}
          <Input
            label={t('Password', '\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1"
              onClick={() => {
                pending.current = null;
                setAskPassword(false);
                setPassword('');
              }}
            >
              {t('Cancel', '\u0625\u0644\u063a\u0627\u0621')}
            </Button>
            <Button type="submit" className="min-h-11 flex-1" isLoading={busy} disabled={!password}>
              {t('Confirm', '\u062a\u0623\u0643\u064a\u062f')}
            </Button>
          </div>
        </form>
      )}

      <ul className="divide-y">
        {items?.length === 0 && (
          <li className="p-4 text-sm text-muted-foreground">
            {t(
              'No passkeys yet.',
              '\u0644\u0633\u0647 \u0645\u0641\u064a\u0634 \u0645\u0641\u0627\u062a\u064a\u062d \u0645\u0631\u0648\u0631.'
            )}
          </li>
        )}
        {items?.map(p => (
          <li key={p.id} className="space-y-3 p-4">
            {renameId === p.id ? (
              <form
                className="flex items-end gap-3"
                onSubmit={e => {
                  e.preventDefault();
                  void run(rename(p.id, renameValue.trim()));
                }}
              >
                <div className="flex-1">
                  <Input
                    label={t('Name', '\u0627\u0644\u0627\u0633\u0645')}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    maxLength={60}
                    required
                  />
                </div>
                <Button type="submit" className="min-h-11" disabled={busy || !renameValue.trim()}>
                  {t('Save', '\u062d\u0641\u0638')}
                </Button>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('Added', '\u0627\u062a\u0636\u0627\u0641 \u0641\u064a')} {fmt(p.createdAt)}
                    {' \u00b7 '}
                    {p.lastUsedAt
                      ? `${t('Last used', '\u0622\u062e\u0631 \u0627\u0633\u062a\u062e\u062f\u0627\u0645')} ${fmt(p.lastUsedAt)}`
                      : t(
                          'Never used',
                          '\u0644\u0633\u0647 \u0645\u0627 \u0627\u062a\u0633\u062a\u062e\u062f\u0645\u0634'
                        )}
                  </p>
                  {p.needsReenrol && (
                    <p className="mt-1 text-xs text-warning-ink">
                      {t(
                        "This passkey was made for another address of this store, so it won't work here. Add it again below.",
                        '\u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631 \u062f\u0647 \u0627\u062a\u0639\u0645\u0644 \u0644\u0639\u0646\u0648\u0627\u0646 \u062a\u0627\u0646\u064a \u0644\u0644\u0645\u062a\u062c\u0631\u060c \u0641\u0645\u0634 \u0647\u064a\u0634\u062a\u063a\u0644 \u0647\u0646\u0627. \u0636\u064a\u0641\u0647 \u0645\u0646 \u062c\u062f\u064a\u062f \u062a\u062d\u062a.'
                      )}
                    </p>
                  )}
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
                    {t('Rename', '\u062a\u0639\u062f\u064a\u0644')}
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
                    {t('Remove', '\u0645\u0633\u062d')}
                  </Button>
                </div>
              </div>
            )}
            {removeId === p.id && (
              <div className="rounded-xl border border-destructive/30 p-3">
                <p className="text-sm text-foreground">
                  {t(
                    'Remove this passkey? It stops working and you will be signed out on all your devices.',
                    '\u062a\u0645\u0633\u062d \u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631 \u062f\u0647\u061f \u0647\u064a\u0628\u0637\u0644 \u064a\u0634\u062a\u063a\u0644 \u0648\u0647\u062a\u062a\u0633\u062c\u0651\u0644 \u062e\u0631\u0648\u062c \u0645\u0646 \u0643\u0644 \u0623\u062c\u0647\u0632\u062a\u0643.'
                  )}
                </p>
                <div className="mt-3 flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 flex-1"
                    onClick={() => setRemoveId(null)}
                  >
                    {t('Cancel', '\u0625\u0644\u063a\u0627\u0621')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-11 flex-1"
                    disabled={busy}
                    onClick={() => void run(remove(p.id))}
                  >
                    {t('Yes, remove', '\u0623\u064a\u0648\u0647\u060c \u0627\u0645\u0633\u062d')}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="space-y-3 border-t p-4">
        <Input
          label={t(
            'Name (optional)',
            '\u0627\u0644\u0627\u0633\u0645 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
          )}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t(
            'e.g. My iPhone',
            '\u0645\u062b\u0644\u0627\u064b: \u0645\u0648\u0628\u0627\u064a\u0644\u064a'
          )}
          maxLength={60}
        />
        <Button type="button" className="min-h-11" isLoading={busy} onClick={() => void run(add)}>
          {t(
            'Add Face ID or a passkey',
            '\u0636\u064a\u0641 \u0628\u0635\u0645\u0629 \u0627\u0644\u0648\u062c\u0647 \u0623\u0648 \u0645\u0641\u062a\u0627\u062d \u0645\u0631\u0648\u0631'
          )}
        </Button>
      </div>
    </div>
  );
}
