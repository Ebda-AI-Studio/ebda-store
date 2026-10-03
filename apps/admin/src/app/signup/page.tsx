'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@force/ui';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { validateSignup, type SignupFields } from '../../lib/onboarding-validation';
import { useT } from '@/i18n/useT';

export default function SignupPage() {
  const t = useT('onboarding.signup');
  const tSent = useT('onboarding.signup.sent');
  const tErr = useT('onboarding.signup.errors');
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [fields, setFields] = useState<SignupFields>({
    name: '',
    email: '',
    phone: '',
    password: '',
  });
  const [errors, setErrors] = useState<ReturnType<typeof validateSignup>>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  // Someone already signed in has no use for this page.
  useEffect(() => {
    if (!authLoading && isAuthenticated) router.replace('/onboarding');
  }, [authLoading, isAuthenticated, router]);

  function set<K extends keyof SignupFields>(key: K, value: string) {
    setFields(prev => ({ ...prev, [key]: value }));
    setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    const found = validateSignup(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const email = fields.email.trim();
    const { error } = await apiPost('/api/v1/auth/merchant/signup', {
      email,
      password: fields.password,
      name: fields.name.trim(),
      ...(fields.phone.trim() ? { phone: fields.phone.trim() } : {}),
      language: document.documentElement.dir === 'rtl' ? 'ar' : 'en',
    });
    setSubmitting(false);
    if (error) {
      if (error.code === 'VALIDATION_ERROR' && error.details) {
        setFormError(tErr('generic'));
      } else {
        setFormError(error.status === 429 ? tErr('rateLimited') : tErr('generic'));
      }
      return;
    }
    setSentTo(email);
  }

  async function handleResend() {
    if (!sentTo) return;
    setResending(true);
    setResent(false);
    await apiPost('/api/v1/auth/merchant/resend-verification', { email: sentTo });
    setResending(false);
    setResent(true);
  }

  if (sentTo) {
    return (
      <PublicShell title={tSent('title')}>
        <p className="text-center text-sm text-muted-foreground">
          {tSent('body', { email: sentTo })}
        </p>
        <div className="mt-6 space-y-3">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={resending}
            onClick={handleResend}
          >
            {resending ? tSent('resending') : tSent('resend')}
          </Button>
          {resent && (
            <p role="status" className="text-center text-sm text-muted-foreground">
              {tSent('resent')}
            </p>
          )}
          <p className="text-center text-sm">
            <Link href="/login" className="text-primary-ink hover:underline">
              {tSent('backToLogin')}
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
          id="signup-name"
          name="name"
          label={t('name')}
          autoComplete="name"
          value={fields.name}
          onChange={e => set('name', e.target.value)}
          placeholder={t('namePlaceholder')}
          error={errors.name ? tErr(errors.name) : undefined}
        />
        <Input
          id="signup-email"
          name="email"
          type="email"
          dir="ltr"
          label={t('email')}
          autoComplete="email"
          value={fields.email}
          onChange={e => set('email', e.target.value)}
          placeholder={t('emailPlaceholder')}
          error={errors.email ? tErr(errors.email) : undefined}
        />
        <div>
          <Input
            id="signup-phone"
            name="phone"
            type="tel"
            dir="ltr"
            inputMode="tel"
            label={t('phone')}
            autoComplete="tel-national"
            value={fields.phone}
            onChange={e => set('phone', e.target.value)}
            placeholder={t('phonePlaceholder')}
            error={errors.phone ? tErr(errors.phone) : undefined}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('phoneHelp')}</p>
        </div>
        <div>
          <Input
            id="signup-password"
            name="password"
            type="password"
            dir="ltr"
            label={t('password')}
            autoComplete="new-password"
            value={fields.password}
            onChange={e => set('password', e.target.value)}
            placeholder={t('passwordPlaceholder')}
            error={errors.password ? tErr(errors.password) : undefined}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('passwordHelp')}</p>
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t('submitting') : t('submit')}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          {t('haveAccount')}{' '}
          <Link href="/login" className="text-primary-ink hover:underline">
            {t('signIn')}
          </Link>
        </p>
      </form>
    </PublicShell>
  );
}
