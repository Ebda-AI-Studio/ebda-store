'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Input } from '@force/ui';
import { PASSWORD_RESET_TTL_MINUTES, isValidEmail } from '@force/shared';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { apiPost } from '../../lib/api';
import { useT } from '@/i18n/useT';

/**
 * Ebda Store "forgot password": ask for the address, then ALWAYS show the same
 * "check your email" screen. The API answers identically whether or not an
 * account exists, and this page must not re-open that oracle by branching on
 * anything but a rate limit or a network failure.
 */
export default function ForgotPasswordPage() {
  const t = useT('auth.forgot');
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    const value = email.trim();
    if (!isValidEmail(value)) {
      setFieldError(t('emailInvalid'));
      return;
    }
    setSubmitting(true);
    // No storeId: the admin namespace, i.e. Ebda Store accounts.
    const { error } = await apiPost('/api/v1/auth/forgot-password', { email: value });
    setSubmitting(false);
    if (error) {
      setFormError(error.status === 429 ? t('rateLimited') : t('generic'));
      return;
    }
    setSentTo(value);
  }

  if (sentTo) {
    return (
      <PublicShell title={t('sentTitle')}>
        <p role="status" className="text-sm leading-relaxed text-muted-foreground">
          {t('sentBody', { email: sentTo, minutes: PASSWORD_RESET_TTL_MINUTES })}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">{t('sentHint')}</p>
        <div className="mt-6 space-y-3">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              setSentTo(null);
              setEmail('');
            }}
          >
            {t('tryAgain')}
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
        <Input
          id="forgot-email"
          name="email"
          type="email"
          dir="ltr"
          label={t('email')}
          autoComplete="email"
          autoFocus
          value={email}
          onChange={e => {
            setEmail(e.target.value);
            setFieldError('');
          }}
          placeholder={t('emailPlaceholder')}
          error={fieldError || undefined}
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
