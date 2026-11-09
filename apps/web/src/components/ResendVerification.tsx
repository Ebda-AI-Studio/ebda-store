'use client';

import { useState } from 'react';
import { Button, Input } from '@ebda/ui';
import { api } from '../lib/api';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';

/** sessionStorage key register uses to hand the address to check-email. */
export const PENDING_VERIFICATION_EMAIL_KEY = 'ebda:pending-verification-email';

/**
 * QA P2-8 / D4: asks the API to send the verification link again (`POST /auth/resend-verification`).
 * The API always answers the same way for known and unknown addresses (enumeration defence), so the
 * confirmation copy never claims an account exists. When the page does not know the address
 * (check-email opened in a fresh tab) it asks for it instead of posting an empty body.
 */
export default function ResendVerification({ email: knownEmail }: { email: string }) {
  const { t } = useLanguage();
  const { store } = useStore();
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');
  const email = (knownEmail || typed).trim();

  const resend = async () => {
    if (!email) return;
    setState('busy');
    const res = await api.post('/auth/resend-verification', { email, storeId: store?.id });
    setState(res.success ? 'sent' : 'failed');
  };

  return (
    <div className="space-y-3">
      {!knownEmail && (
        <Input
          label={t('Email address', 'البريد الإلكتروني')}
          type="email"
          autoComplete="email"
          value={typed}
          onChange={e => setTyped(e.target.value)}
        />
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        isLoading={state === 'busy'}
        disabled={!email}
        onClick={resend}
      >
        {t('Resend the verification link', 'ابعتلي رابط التأكيد تاني')}
      </Button>
      {state === 'sent' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(
            'If this address needs verifying, a new link is on its way. Check your inbox and spam folder.',
            'لو البريد ده محتاج تأكيد، هيوصلك رابط جديد. بص في الوارد وفي الرسائل المزعجة.'
          )}
        </p>
      )}
      {state === 'failed' && (
        <p role="alert" className="text-sm text-destructive-ink">
          {t(
            'We could not send the link right now. Wait a minute and try again.',
            'مقدرناش نبعت الرابط دلوقتي. استنى دقيقة وجرّب تاني.'
          )}
        </p>
      )}
    </div>
  );
}
