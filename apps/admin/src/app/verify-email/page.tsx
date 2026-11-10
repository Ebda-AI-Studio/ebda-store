'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Input } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { apiPost } from '../../lib/api';
import { AccountsError, accountsFetch } from '../../lib/accounts';
import { useAuth } from '../../lib/auth';
import { useT } from '@/i18n/useT';

type Phase =
  | { kind: 'form' }
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'error'; reason: 'invalid' | 'expired' | 'missing' | 'generic' | 'rateLimited' };

export default function VerifyEmailPage() {
  const t = useT('onboarding.verify');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'verifying' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [wrongPassword, setWrongPassword] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<'rateLimited' | 'generic' | null>(null);
  // The token is single-use: React strict mode runs effects twice in dev, and
  // the second POST would answer "already used" over the first one's success.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The emailed link is `/verify-email?email=…#code=…`: the code lives in the fragment, which no server, Referer header or
    // analytics pageview ever sees. Take both out of the address bar before anything records the URL.
    const mail = new URLSearchParams(window.location.search).get('email') ?? '';
    const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code') ?? '';
    window.history.replaceState(null, '', window.location.pathname);
    if (!/^\d{6}$/.test(raw) || !mail) {
      setPhase({ kind: 'error', reason: 'missing' });
      return;
    }
    setEmail(mail);
    setCode(raw);
    // Verifying also needs the password chosen at signup (a code mailed because someone else typed this address cannot
    // activate their password on the owner's behalf), so the visitor types it now.
    setPhase({ kind: 'form' });
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setWrongPassword(false);
    setPhase({ kind: 'verifying' });
    try {
      await accountsFetch('/otp/verify', { json: { email, code, password } });
      setPhase({ kind: 'success' });
    } catch (err) {
      if (err instanceof AccountsError && err.code === 'INVALID_CODE') {
        setWrongPassword(true);
        setPhase({ kind: 'form' });
      } else
        setPhase({
          kind: 'error',
          reason: err instanceof AccountsError && err.status === 429 ? 'rateLimited' : 'invalid',
        });
    }
  }

  function goOn() {
    router.push(isAuthenticated ? '/onboarding' : '/login?returnTo=%2Fonboarding');
  }

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setResending(true);
    setResent(false);
    setResendError(null);
    const { error } = await apiPost('/api/v1/auth/merchant/resend-verification', {
      email: email.trim(),
    });
    setResending(false);
    setResendError(error ? (error.status === 429 ? 'rateLimited' : 'generic') : null);
    setResent(!error);
  }

  if (phase.kind === 'form') {
    return (
      <PublicShell title={t('passwordTitle')} subtitle={t('passwordBody')}>
        <form className="space-y-4" onSubmit={handleVerify}>
          <Input
            id="verify-password"
            type="password"
            label={t('password')}
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            error={wrongPassword ? t('wrongPassword') : undefined}
          />
          <Button type="submit" className="w-full" disabled={!password}>
            {t('verifyButton')}
          </Button>
          <p className="text-center text-sm">
            <Link href="/forgot-password" className="text-primary-ink hover:underline">
              {t('forgotPassword')}
            </Link>
          </p>
          {/* PRE-8: the link is often opened on another device or by someone who did not sign up; a reset also confirms the
              email (accounts /password/reset sets email_verified), so say so instead of leaving them stuck at the password. */}
          <p
            className="text-center text-sm text-muted-foreground"
            data-testid="verify-password-hint"
          >
            {t('passwordHint')}
          </p>
        </form>
      </PublicShell>
    );
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
        {resendError && (
          <p role="alert" className="text-center text-sm text-destructive-ink">
            {t(resendError)}
          </p>
        )}
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
