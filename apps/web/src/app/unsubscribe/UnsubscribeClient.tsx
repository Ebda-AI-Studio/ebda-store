'use client';

import { useState } from 'react';
import { Button } from '@force/ui';
import { ShopChrome } from '../../components';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { API_URL } from '../../lib/api';

export interface UnsubscribeInfo {
  email: string;
  storeName: string | null;
  storeNameAr: string | null;
  alreadyUnsubscribed: boolean;
}

interface Props {
  token: string;
  info: UnsubscribeInfo | null;
  error: 'INVALID_TOKEN' | 'NETWORK' | null;
}

type Phase = 'confirm' | 'working' | 'done' | 'failed';

export default function UnsubscribeClient({ token, info, error }: Props) {
  const { t, isRtl } = useLanguage();
  const [phase, setPhase] = useState<Phase>(info?.alreadyUnsubscribed ? 'done' : 'confirm');

  const tr = (key: keyof typeof translations) => t(key, translations[key]);
  const storeName = info ? (isRtl && info.storeNameAr ? info.storeNameAr : info.storeName) : null;

  const confirm = async () => {
    setPhase('working');
    try {
      const res = await fetch(
        `${API_URL}/public/campaigns/unsubscribe?token=${encodeURIComponent(token)}`,
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
        <h1 className="text-xl font-semibold text-foreground">{tr('Email preferences')}</h1>

        {error || !info ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {error === 'NETWORK'
              ? tr('Something went wrong. Please try again later.')
              : tr('This unsubscribe link is invalid.')}
          </p>
        ) : phase === 'done' ? (
          <p className="mt-4 text-sm text-muted-foreground" role="status">
            {tr('You have been unsubscribed. You will not receive marketing emails from us.')}
          </p>
        ) : (
          <>
            <p className="mt-4 text-sm text-muted-foreground">
              {tr('Stop receiving marketing emails at')}{' '}
              <span className="font-medium text-foreground" dir="ltr">
                {info.email}
              </span>
              {storeName ? ` — ${storeName}` : ''}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {tr('Order and account emails are not affected.')}
            </p>
            {phase === 'failed' && (
              <p className="mt-4 text-sm text-destructive" role="alert">
                {tr('Something went wrong. Please try again later.')}
              </p>
            )}
            <Button type="button" className="mt-6" onClick={confirm} disabled={phase === 'working'}>
              {phase === 'working' ? tr('Unsubscribing…') : tr('Unsubscribe')}
            </Button>
          </>
        )}
      </div>
    </ShopChrome>
  );
}
