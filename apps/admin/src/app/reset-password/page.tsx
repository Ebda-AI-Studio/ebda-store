'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@ebda/ui';
import { PASSWORD_RESET_TTL_MINUTES } from '@ebda/shared';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { apiPost } from '../../lib/api';
import { isStrongPassword } from '../../lib/onboarding-validation';
import { useT } from '@/i18n/useT';

type Phase = 'loading' | 'form' | 'invalid' | 'success';

/** 32 random bytes as hex: anything else cannot be a reset token. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Ebda Store "choose a new password", opened from the reset email
 * (`/reset-password?token=…`).
 *
 * The token is a bearer credential for the account, so it is read once and
 * removed from the address bar before anything else can see it: analytics
 * pageviews, error reports, the browser history and a Referer would all
 * otherwise carry the full URL. React runs this page's effect before the
 * providers' effects, so the URL is clean before PostHog is even imported.
 */
export default function ResetPasswordPage() {
  const t = useT('auth.reset');
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Strict mode runs effects twice in dev; the second run would read the
  // already-cleaned URL and wrongly report the link as invalid.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const raw = new URLSearchParams(window.location.search).get('token') ?? '';
    window.history.replaceState(null, '', window.location.pathname);
    if (TOKEN_SHAPE.test(raw)) {
      setToken(raw);
      setPhase('form');
    } else {
      setPhase('invalid');
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    const found: typeof errors = {};
    if (!isStrongPassword(password)) found.password = t('passwordWeak');
    if (confirm !== password) found.confirm = t('mismatch');
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const { error } = await apiPost('/api/v1/auth/reset-password', { token, password });
    setSubmitting(false);
    if (!error) {
      setToken('');
      setPhase('success');
      return;
    }
    if (error.code === 'TOKEN_INVALID') setPhase('invalid');
    else if (error.code === 'VALIDATION_ERROR') setErrors({ password: t('passwordWeak') });
    else setFormError(error.status === 429 ? t('rateLimited') : t('generic'));
  }

  if (phase === 'loading') {
    return <PublicShell title={t('title')}>{null}</PublicShell>;
  }

  if (phase === 'invalid') {
    return (
      <PublicShell title={t('invalidTitle')}>
        <p role="alert" className="text-sm leading-relaxed text-muted-foreground">
          {t('invalidBody', { minutes: PASSWORD_RESET_TTL_MINUTES })}
        </p>
        <div className="mt-6 space-y-3">
          <Button type="button" className="w-full" onClick={() => router.push('/forgot-password')}>
            {t('requestNew')}
          </Button>
          <p className="text-center text-sm">
            <Link href="/login" className="text-primary-ink hover:underline">
              {t('backToLogin')}
            </Link>
          </p>
        </div>
      </PublicShell>
    );
  }

  if (phase === 'success') {
    return (
      <PublicShell title={t('successTitle')}>
        <p role="status" className="text-sm leading-relaxed text-muted-foreground">
          {t('successBody')}
        </p>
        <Button type="button" className="mt-6 w-full" onClick={() => router.replace('/login')}>
          {t('signIn')}
        </Button>
      </PublicShell>
    );
  }

  return (
    <PublicShell title={t('title')} subtitle={t('subtitle')}>
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {formError && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
          >
            {formError}
          </div>
        )}
        <div>
          <Input
            id="reset-password"
            name="password"
            type="password"
            dir="ltr"
            label={t('password')}
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={e => {
              setPassword(e.target.value);
              setErrors(prev => ({ ...prev, password: undefined }));
            }}
            placeholder={t('passwordPlaceholder')}
            error={errors.password}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('passwordHelp')}</p>
        </div>
        <Input
          id="reset-password-confirm"
          name="confirmPassword"
          type="password"
          dir="ltr"
          label={t('confirm')}
          autoComplete="new-password"
          value={confirm}
          onChange={e => {
            setConfirm(e.target.value);
            setErrors(prev => ({ ...prev, confirm: undefined }));
          }}
          placeholder={t('confirmPlaceholder')}
          error={errors.confirm}
        />
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t('submitting') : t('submit')}
        </Button>
        <p className="text-center text-sm">
          <Link href="/login" className="text-primary-ink hover:underline">
            {t('backToLogin')}
          </Link>
        </p>
      </form>
    </PublicShell>
  );
}
