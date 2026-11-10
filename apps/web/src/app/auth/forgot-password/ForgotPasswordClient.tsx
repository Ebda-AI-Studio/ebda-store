'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import Link from '../../../components/StoreLink';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStoreUrl, useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { authRefusalText } from '../../../lib/auth-refusal';
import { readTypedBeforeHydration } from '../../../lib/adopt-typed-before-hydration';

export default function ForgotPasswordClient() {
  const { isLoading, error, submit } = useAuthFormSubmit();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { t } = useLanguage();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [email, setEmail] = useState('');
  // QA P2-1 class: an address typed before hydration lives only in the DOM; adopt it into state.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const typed = readTypedBeforeHydration(formRef.current, ['email'] as const);
    if (typed.email) setEmail(typed.email);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await submit(
      async () => {
        const result = await api.forgotPassword(email, store?.id);
        if (!result.success) {
          throw new Error(
            authRefusalText(result.error, t) ||
              result.error?.message ||
              t('Sending the reset link did not work.', 'إرسال الرابط منفعش.')
          );
        }
      },
      t('Sending the reset link did not work. Try again.', 'إرسال الرابط منفعش. جرّب تاني.')
    );
    if (ok) setIsSubmitted(true);
  };

  if (isSubmitted) {
    return (
      <MinimalChrome>
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
          <div className="w-full max-w-md space-y-8 text-center">
            <div className="rounded-xl border bg-card p-8 shadow-sm">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/20">
                <svg
                  className="h-6 w-6 text-success-ink"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h2 className="mt-4 text-xl font-semibold text-foreground">
                {t('Check your email', 'تحقق من بريدك الإلكتروني')}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("We've sent a password reset link to", 'بعتنا رابط تغيير كلمة المرور على')}{' '}
                <strong>{email}</strong>
              </p>
              <p className="mt-4 text-xs text-muted-foreground">
                {t(
                  "Didn't receive the email? Check your spam folder or",
                  'موصلكش البريد؟ بُص في مجلد الرسائل غير المرغوبة أو'
                )}{' '}
                <button
                  type="button"
                  onClick={() => setIsSubmitted(false)}
                  className="text-primary underline underline-offset-2"
                >
                  {t('try again', 'جرّب تاني')}
                </button>
              </p>
            </div>

            <Link
              href={storeUrl('/auth/login')}
              className="inline-block text-sm text-primary hover:underline"
            >
              &larr; {t('Back to sign in', 'العودة لتسجيل الدخول')}
            </Link>
          </div>
        </div>
      </MinimalChrome>
    );
  }

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Header */}
          <div className="text-center">
            <h2 className="mt-6 text-3xl font-bold tracking-tight text-foreground">
              {t('Forgot password?', 'نسيت كلمة المرور؟')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                "No worries, we'll send you reset instructions.",
                'متقلقش، هنبعتلك خطوات تغيير كلمة المرور.'
              )}
            </p>
          </div>

          {/* Form */}
          <div className="rounded-xl border bg-card p-8 shadow-sm">
            {error && (
              <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
                {error}
              </div>
            )}

            <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
              <Input
                label={t('Email address', 'البريد الإلكتروني')}
                type="email"
                autoComplete="email"
                name="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                {t('Send reset link', 'إرسال رابط إعادة التعيين')}
              </Button>
            </form>
          </div>

          <p className="text-center text-sm">
            <Link
              href={storeUrl('/auth/login')}
              className="text-primary underline underline-offset-2"
            >
              &larr; {t('Back to sign in', 'العودة لتسجيل الدخول')}
            </Link>
          </p>
        </div>
      </div>
    </MinimalChrome>
  );
}
