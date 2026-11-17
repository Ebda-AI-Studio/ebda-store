'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Input, PasswordRules } from '@ebda/ui';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { PASSWORD_RESET_TTL_MINUTES } from '@ebda/shared';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { AccountsError, accountsFetch } from '../../lib/accounts';
import { isStrongPassword } from '../../lib/onboarding-validation';
import { useT } from '@/i18n/useT';

type Phase = 'loading' | 'form' | 'invalid' | 'success';

/** The emailed link carries the address in the query and a 6 digit code in the fragment (`#code=`): never sent to any server. */
const CODE_SHAPE = /^\d{6}$/;

/**
 * Ebda Store "choose a new password", opened from the reset email
 * (`/reset-password?email=…#code=…`).
 *
 * The code is a bearer credential for the account, so it is read once and
 * removed from the address bar before anything else can see it: analytics
 * pageviews, error reports, the browser history and a Referer would all
 * otherwise carry the full URL. React runs this page's effect before the
 * providers' effects, so the URL is clean before PostHog is even imported.
 */
export default function ResetPasswordPage() {
  const t = useT('auth.reset');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
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
    const mail = new URLSearchParams(window.location.search).get('email') ?? '';
    const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code') ?? '';
    window.history.replaceState(null, '', window.location.pathname);
    if (CODE_SHAPE.test(raw) && mail) {
      setEmail(mail);
      setCode(raw);
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
    try {
      await accountsFetch('/password/reset', { json: { email, code, newPassword: password } });
      setSubmitting(false);
      setCode('');
      setPhase('success');
    } catch (e) {
      setSubmitting(false);
      if (e instanceof AccountsError && e.code === 'INVALID_CODE') setPhase('invalid');
      else if (e instanceof AccountsError && e.code === 'VALIDATION_ERROR')
        setErrors({ password: t('passwordWeak') });
      else
        setFormError(
          e instanceof AccountsError && e.status === 429 ? t('rateLimited') : t('generic')
        );
    }
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
          <PasswordRules
            value={password}
            locale={locale}
            title={t('passwordRulesTitle')}
            progressLabel={(met, total) => t('passwordRulesProgress', { met, total })}
            className="mt-1.5"
          />
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
