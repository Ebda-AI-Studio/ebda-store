'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useAuth } from '../../../../lib/auth';
import { apiGet, apiPost } from '../../../../lib/api';

/**
 * The Store half of Ruling CHAT-ENABLE-1: the owner connects Ebda Chat from Settings. It calls the
 * existing POST /stores/:id/whatsapp-link, which owns every refusal (role, two-step, plan); the role
 * check here only decides whether the card is shown. Connecting creates the Chat workspace only: no
 * charge, no plan change, no message.
 */
const CHAT_URL = 'https://wa.ebda.app';

interface LinkState {
  linked: boolean;
  entitled: boolean;
  active: boolean;
}

type RefusalKey = 'notIncluded' | 'errRole' | 'errMfa' | 'errSession' | 'errNetwork' | 'errGeneric';

/** One refusal key per failure; the server's own text is never shown. */
function refusalKey(error: { code?: string; status?: number }): RefusalKey {
  if (error.code === 'WHATSAPP_NOT_INCLUDED') return 'notIncluded';
  if (error.code === 'MFA_SETUP_REQUIRED') return 'errMfa';
  if (error.status === 401) return 'errSession';
  if (error.status === 403) return 'errRole';
  if (!error.status) return 'errNetwork';
  return 'errGeneric';
}

export function ConnectChatCard({ storeId }: { storeId: string }) {
  const t = useT('settings.chatConnect');
  const { user } = useAuth();
  const { success: toastSuccess } = useToast();
  const allowed = user?.role === 'store_admin' || user?.role === 'super_admin';
  const [state, setState] = useState<LinkState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalKey | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const { data, error } = await apiGet<LinkState>(`/api/v1/stores/${storeId}/whatsapp-link`);
    if (error || !data) {
      setLoadFailed(true);
      return;
    }
    setState(data);
  }, [storeId]);

  useEffect(() => {
    if (allowed && storeId) void load();
  }, [allowed, storeId, load]);

  const connect = useCallback(async () => {
    // A double click is one request: the ref flips synchronously, before React re-renders.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const { data, error } = await apiPost<{ linked: boolean }>(
        `/api/v1/stores/${storeId}/whatsapp-link`
      );
      if (error || !data) {
        setRefusal(refusalKey(error ?? {}));
        return;
      }
      setState(s => ({ linked: true, entitled: s?.entitled ?? true, active: true }));
      toastSuccess(t('toastTitle'), t('toastBody'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [storeId, t, toastSuccess]);

  if (!allowed) return null;

  return (
    <section
      data-testid="connect-chat-card"
      className="rounded-xl border bg-card p-5 shadow-sm"
      aria-labelledby="connect-chat-title"
    >
      <h2 id="connect-chat-title" className="font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>

      {loadFailed ? (
        <div className="mt-3" role="alert">
          <p className="text-sm text-danger">{t('errLoad')}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : !state ? (
        <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
          {t('loading')}
        </p>
      ) : state.linked ? (
        <div className="mt-3" data-testid="chat-connected">
          <p className="text-sm font-medium text-foreground">
            {t('connected')}: <span className="font-normal">{t('connectedBody')}</span>
          </p>
          <a
            href={CHAT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
          >
            {t('openChat')}
          </a>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-muted-foreground">{t('whatItDoes')}</p>
          {!state.entitled && (
            <p className="mt-2 text-sm text-foreground" data-testid="chat-not-included">
              {t('notIncluded')}{' '}
              <Link
                href={`/stores/${storeId}/billing`}
                className="font-medium text-primary underline"
              >
                {t('upgrade')}
              </Link>
            </p>
          )}
          <Button
            className="mt-3"
            onClick={() => void connect()}
            disabled={busy || !state.entitled}
            aria-busy={busy}
          >
            {busy ? t('connecting') : t('connect')}
          </Button>
          {refusal && (
            <p className="mt-2 text-sm text-danger" role="alert" data-testid="chat-refusal">
              {t(refusal)}{' '}
              {refusal === 'errMfa' && (
                <Link href="/account/security" className="font-medium underline">
                  {t('errMfaLink')}
                </Link>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
