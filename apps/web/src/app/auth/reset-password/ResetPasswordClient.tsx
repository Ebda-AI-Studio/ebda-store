'use client';

import { useState, Suspense } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import { useSearchParams } from 'next/navigation';
import Link from '../../../components/StoreLink';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { authRefusalText } from '../../../lib/auth-refusal';
import { PasswordChecklist } from '../../../components/PasswordChecklist';
import { isPasswordPolicyMet, passwordUnmetSentence } from '@ebda/shared';

function ResetPasswordForm() {
  const { isLoading, error, setError, submit } = useAuthFormSubmit();
  const searchParams = useSearchParams();
  const token = searchParams?.get('token') || '';
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();

  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState({
    newPassword: '',
    confirmPassword: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError(
        t(
          'Invalid or missing reset token. Please request a new password reset link.',
          'رمز تغيير كلمة المرور مش صالح أو مش موجود. اطلب رابط جديد.'
        )
      );
      return;
    }

    if (formData.newPassword !== formData.confirmPassword) {
      setError(t('Passwords do not match.', 'كلمة المرور وتأكيدها مش زي بعض.'));
      return;
    }

    const unmetEn = passwordUnmetSentence(formData.newPassword, 'en');
    const unmetAr = passwordUnmetSentence(formData.newPassword, 'ar');
    if (unmetEn && unmetAr) {
      setError(t(unmetEn, unmetAr));
      return;
    }

    const ok = await submit(
      async () => {
        // The API's reset-password endpoint accepts { token, password }
        const result = await api.resetPassword(token, formData.newPassword);

        if (!result.success) {
          // A throttle is "wait and try again", not a failure of the link —
          // and the server's rate-limit message is English-only (#2162's
          // sibling surface).
          const refusal = authRefusalText(result.error, t);
          if (refusal) throw new Error(refusal);
          throw new Error(
            result.error?.message || t('Failed to reset password', 'تغيير كلمة المرور منفعش')
          );
        }
      },
      t('Failed to reset password. Please try again.', 'تغيير كلمة المرور منفعش. جرّب تاني.')
    );
    if (ok) setSuccess(true);
  };

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Header — logo lives in MinimalChrome; keep only the page heading. */}
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t('Reset your password', 'إعادة تعيين كلمة المرور')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('Enter your new password below.', 'اكتب كلمة المرور الجديدة تحت.')}
            </p>
          </div>

          {/* Form */}
          <div className="rounded-xl border bg-card p-8 shadow-sm">
            {success ? (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/20">
                  <svg
                    className="h-8 w-8 text-success-ink"
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
                <h3 className="text-lg font-semibold text-foreground">
                  {t('Password reset successfully', 'كلمة المرور اتغيّرت')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'Your password has been updated. You can now sign in with your new password.',
                    'كلمة المرور اتحدّثت. تقدر تسجّل دخول دلوقتي بالكلمة الجديدة.'
                  )}
                </p>
                <Link
                  href={storeUrl('/auth/login')}
                  className="mt-4 inline-block font-medium text-primary hover:underline"
                >
                  {t('Back to sign in', 'العودة لتسجيل الدخول')}
                </Link>
              </div>
            ) : (
              <>
                {error && (
                  <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
                    {error}
                  </div>
                )}

                {!token && (
                  <div className="mb-4 rounded-lg bg-warning/10 p-3 text-sm text-warning-ink">
                    {t(
                      'No reset token found. Please use the link from your password reset email.',
                      'ملقيناش رمز تغيير كلمة المرور. استخدم الرابط اللي في بريد تغيير كلمة المرور.'
                    )}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                  <Input
                    label={t('New Password', 'كلمة المرور الجديدة')}
                    type="password"
                    autoComplete="new-password"
                    value={formData.newPassword}
                    onChange={e => setFormData({ ...formData, newPassword: e.target.value })}
                    required
                    disabled={!token}
                    aria-describedby="reset-password-rules"
                  />
                  <PasswordChecklist id="reset-password-rules" value={formData.newPassword} />

                  <Input
                    label={t('Confirm New Password', 'تأكيد كلمة المرور الجديدة')}
                    type="password"
                    autoComplete="new-password"
                    value={formData.confirmPassword}
                    onChange={e => setFormData({ ...formData, confirmPassword: e.target.value })}
                    required
                    disabled={!token}
                  />

                  <Button
                    type="submit"
                    className="w-full"
                    size="lg"
                    isLoading={isLoading}
                    disabled={!token || !isPasswordPolicyMet(formData.newPassword)}
                  >
                    {t('Reset Password', 'إعادة تعيين كلمة المرور')}
                  </Button>
                </form>

                <div className="mt-4 text-center">
                  <Link
                    href={storeUrl('/auth/login')}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('Back to sign in', 'العودة لتسجيل الدخول')}
                  </Link>
                </div>
              </>
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground">
            {t('Need a new reset link?', 'محتاج رابط جديد؟')}{' '}
            <Link
              href={storeUrl('/auth/forgot-password')}
              className="text-primary underline underline-offset-2"
            >
              {t('Request password reset', 'طلب إعادة تعيين كلمة المرور')}
            </Link>
          </p>
        </div>
      </div>
    </MinimalChrome>
  );
}

export default function ResetPasswordClient() {
  return (
    <Suspense
      fallback={
        <MinimalChrome>
          <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </MinimalChrome>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
