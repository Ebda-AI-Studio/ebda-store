'use client';

import { useState } from 'react';
import { Button } from '@force/ui';
import { ShopChrome } from '../../components';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { API_URL } from '../../lib/api';

export interface SmsUnsubscribeInfo {
  /** Masked (`****5678`) — enough to recognise, not to reuse. */
  phone: string | null;
  storeName: string | null;
  storeNameAr: string | null;
  alreadyUnsubscribed: boolean;
}

interface Props {
  token: string;
  info: SmsUnsubscribeInfo | null;
  error: 'INVALID_TOKEN' | 'NETWORK' | null;
}

type Phase = 'confirm' | 'working' | 'done' | 'failed';

export default function SmsUnsubscribeClient({ token, info, error }: Props) {
  const { t, isRtl } = useLanguage();
  const [phase, setPhase] = useState<Phase>(info?.alreadyUnsubscribed ? 'done' : 'confirm');

  const tr = (key: keyof typeof translations) => t(key, translations[key]);
  const storeName = info ? (isRtl && info.storeNameAr ? info.storeNameAr : info.storeName) : null;

  const confirm = async () => {
    setPhase('working');
    try {
      const res = await fetch(
        `${API_URL}/public/sms-consent/unsubscribe?t=${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      );
      setPhase(res.ok ? 'done' : 'failed');
    } catch {
      setPhase('failed');
    }
  };

  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-md flex-1 px-4 py-12 text-center">
        <h1 className="text-xl font-semibold text-foreground">{tr('SMS preferences')}</h1>

        {error || !info ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {error === 'NETWORK'
              ? tr('Something went wrong. Please try again later.')
              : tr('This link is invalid.')}
          </p>
        ) : phase === 'done' ? (
          <p className="mt-4 text-sm text-muted-foreground" role="status">
            {tr('You will not receive SMS offers from us.')}
          </p>
        ) : (
          <>
            <p className="mt-4 text-sm text-muted-foreground">
              {tr('Stop receiving SMS offers at')}{' '}
              <span className="font-medium text-foreground" dir="ltr">
                {info.phone}
              </span>
              {storeName ? ` — ${storeName}` : ''}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {tr('Order and delivery messages are not affected.')}
            </p>
            {phase === 'failed' && (
              <p className="mt-4 text-sm text-destructive-ink" role="alert">
                {tr('Something went wrong. Please try again later.')}
              </p>
            )}
            <Button type="button" className="mt-6" onClick={confirm} disabled={phase === 'working'}>
              {phase === 'working' ? tr('Unsubscribing…') : tr('Stop SMS offers')}
            </Button>
          </>
        )}
      </div>
    </ShopChrome>
  );
}
