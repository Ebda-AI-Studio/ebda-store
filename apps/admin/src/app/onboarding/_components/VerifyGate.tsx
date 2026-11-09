'use client';

import { useState } from 'react';
import { Button } from '@ebda/ui';
import { apiPost } from '../../../lib/api';
import { useT } from '@/i18n/useT';

/** Shown instead of the stepper until the account's email is verified. */
export function VerifyGate({ email, onRefresh }: { email: string; onRefresh: () => void }) {
  const t = useT('onboarding.flow.verifyGate');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<'rateLimited' | 'sendFailed' | null>(null);

  async function handleResend() {
    setSending(true);
    setSent(false);
    setError(null);
    const { error: apiError } = await apiPost('/api/v1/auth/merchant/resend-verification', {
      email,
    });
    setSending(false);
    setError(apiError ? (apiError.status === 429 ? 'rateLimited' : 'sendFailed') : null);
    setSent(!apiError);
  }

  return (
    <div className="space-y-4 text-center">
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <p dir="auto" className="text-sm text-muted-foreground">
        {t('body', { email })}
      </p>
      <div className="grid gap-3">
        <Button type="button" onClick={onRefresh}>
          {t('refresh')}
        </Button>
        <Button type="button" variant="outline" disabled={sending} onClick={handleResend}>
          {t('resend')}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {t(error)}
          </p>
        )}
        {sent && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('resent')}
          </p>
        )}
      </div>
    </div>
  );
}
