'use client';

import { useState, Suspense } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

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
          'رمز إعادة التعيين غير صالح أو مفقود. يرجى طلب رابط جديد لإعادة تعيين كلمة المرور.'
        )
      );
      return;
    }

    if (formData.newPassword !== formData.confirmPassword) {
      setError(t('Passwords do not match.', 'كلمتا المرور غير متطابقتين.'));
      return;
    }

    if (formData.newPassword.length < 8) {
      setError(
        t(
          'Password must be at least 8 characters.',
          'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.'
        )
      );
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
          if (result.error?.code === 'RATE_LIMITED') {
            throw new Error(
              t(
                'Too many attempts. Please wait a few minutes, then try again.',
                'محاولات كثيرة جدًا. يرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.'
              )
            );
          }
          throw new Error(
            result.error?.message || t('Failed to reset password', 'فشلت إعادة تعيين كلمة المرور')
          );
        }
      },
      t(
        'Failed to reset password. Please try again.',
        'فشلت إعادة تعيين كلمة المرور. يرجى المحاولة مرة أخرى.'
      )
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
              {t(
                'Reset your password',
                '\u0625\u0639\u0627\u062f\u0629 \u062a\u0639\u064a\u064a\u0646 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
              )}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                'Enter your new password below.',
                '\u0623\u062f\u062e\u0644 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629 \u0623\u062f\u0646\u0627\u0647.'
              )}
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
                  {t(
                    'Password reset successfully',
                    '\u062a\u0645 \u0625\u0639\u0627\u062f\u0629 \u062a\u0639\u064a\u064a\u0646 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0628\u0646\u062c\u0627\u062d'
                  )}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'Your password has been updated. You can now sign in with your new password.',
                    '\u062a\u0645 \u062a\u062d\u062f\u064a\u062b \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631. \u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u0622\u0646 \u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0628\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629.'
                  )}
                </p>
                <Link
                  href={storeUrl('/auth/login')}
                  className="mt-4 inline-block font-medium text-primary hover:underline"
                >
                  {t(
                    'Back to sign in',
                    '\u0627\u0644\u0639\u0648\u062f\u0629 \u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
                  )}
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
                      '\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0631\u0645\u0632 \u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u062a\u0639\u064a\u064a\u0646. \u064a\u0631\u062c\u0649 \u0627\u0633\u062a\u062e\u062f\u0627\u0645 \u0627\u0644\u0631\u0627\u0628\u0637 \u0645\u0646 \u0628\u0631\u064a\u062f \u0625\u0639\u0627\u062f\u0629 \u062a\u0639\u064a\u064a\u0646 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631.'
                    )}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                  <Input
                    label={t(
                      'New Password',
                      '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629'
                    )}
                    type="password"
                    autoComplete="new-password"
                    value={formData.newPassword}
                    onChange={e => setFormData({ ...formData, newPassword: e.target.value })}
                    required
                    disabled={!token}
                  />

                  <Input
                    label={t(
                      'Confirm New Password',
                      '\u062a\u0623\u0643\u064a\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629'
                    )}
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
                    disabled={!token}
                  >
                    {t(
                      'Reset Password',
                      '\u0625\u0639\u0627\u062f\u0629 \u062a\u0639\u064a\u064a\u0646 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
                    )}
                  </Button>
                </form>

                <div className="mt-4 text-center">
                  <Link
                    href={storeUrl('/auth/login')}
                    className="text-sm text-primary hover:underline"
                  >
                    {t(
                      'Back to sign in',
                      '\u0627\u0644\u0639\u0648\u062f\u0629 \u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
                    )}
                  </Link>
                </div>
              </>
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground">
            {t(
              'Need a new reset link?',
              '\u062a\u062d\u062a\u0627\u062c \u0631\u0627\u0628\u0637 \u0625\u0639\u0627\u062f\u0629 \u062a\u0639\u064a\u064a\u0646 \u062c\u062f\u064a\u062f\u061f'
            )}{' '}
            <Link
              href={storeUrl('/auth/forgot-password')}
              className="text-primary underline underline-offset-2"
            >
              {t(
                'Request password reset',
                '\u0637\u0644\u0628 \u0625\u0639\u0627\u062f\u0629 \u062a\u0639\u064a\u064a\u0646 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
              )}
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
