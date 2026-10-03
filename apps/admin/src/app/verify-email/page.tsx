'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@force/ui';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useT } from '@/i18n/useT';

type Phase =
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'error'; reason: 'invalid' | 'expired' | 'missing' | 'generic' };

export default function VerifyEmailPage() {
  const t = useT('onboarding.verify');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'verifying' });
  const [email, setEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  // The token is single-use: React strict mode runs effects twice in dev, and
  // the second POST would answer "already used" over the first one's success.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setPhase({ kind: 'error', reason: 'missing' });
      return;
    }
    apiPost('/api/v1/auth/verify-email', { token }).then(({ error }) => {
      if (!error) setPhase({ kind: 'success' });
      else if (error.code === 'TOKEN_EXPIRED') setPhase({ kind: 'error', reason: 'expired' });
      else if (error.code === 'TOKEN_INVALID') setPhase({ kind: 'error', reason: 'invalid' });
      else setPhase({ kind: 'error', reason: 'generic' });
    });
  }, []);

  function goOn() {
    router.push(isAuthenticated ? '/onboarding' : '/login?returnTo=%2Fonboarding');
  }

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setResending(true);
    setResent(false);
    await apiPost('/api/v1/auth/merchant/resend-verification', { email: email.trim() });
    setResending(false);
    setResent(true);
  }

  if (phase.kind === 'verifying') {
    return (
      <PublicShell title={t('verifying')}>
        <div role="status" className="flex justify-center py-4">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </PublicShell>
    );
  }

  if (phase.kind === 'success') {
    return (
      <PublicShell title={t('successTitle')} subtitle={t('successBody')}>
        <Button type="button" className="w-full" onClick={goOn}>
          {t('continue')}
        </Button>
      </PublicShell>
    );
  }

  return (
    <PublicShell title={t('failedTitle')} subtitle={t(phase.reason)}>
      <form className="space-y-4" onSubmit={handleResend}>
        <h2 className="text-sm font-medium text-foreground">{t('resendTitle')}</h2>
        <Input
          id="verify-email-address"
          type="email"
          dir="ltr"
          label={t('email')}
          autoComplete="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <Button type="submit" className="w-full" disabled={resending || !email.trim()}>
          {resending ? t('resending') : t('resend')}
        </Button>
        {resent && (
          <p role="status" className="text-center text-sm text-muted-foreground">
            {t('resent')}
          </p>
        )}
        <p className="text-center text-sm">
          <Link href="/login" className="text-primary-ink hover:underline">
            {t('backToLogin')}
          </Link>
        </p>
      </form>
    </PublicShell>
  );
}
