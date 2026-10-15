'use client';

import { useState } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import Link from 'next/link';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStoreUrl, useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { demoRefusalText } from '../../../lib/demo-refusal';

export default function ForgotPasswordClient() {
  const { isLoading, error, submit } = useAuthFormSubmit();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { t } = useLanguage();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [email, setEmail] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await submit(async () => {
      const result = await api.forgotPassword(email, store?.id);
      if (!result.success) {
        throw new Error(
          demoRefusalText(result.error, t) || result.error?.message || 'Failed to send reset email'
        );
      }
    }, 'Failed to send reset email');
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
                {t(
                  'Check your email',
                  '\u062a\u062d\u0642\u0642 \u0645\u0646 \u0628\u0631\u064a\u062f\u0643 \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a'
                )}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(
                  "We've sent a password reset link to",
                  '\u0644\u0642\u062f \u0623\u0631\u0633\u0644\u0646\u0627 \u0631\u0627\u0628\u0637 \u0625\u0639\u0627\u062f\u0629 \u062a\u0639\u064a\u064a\u0646 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0625\u0644\u0649'
                )}{' '}
                <strong>{email}</strong>
              </p>
              <p className="mt-4 text-xs text-muted-foreground">
                {t(
                  "Didn't receive the email? Check your spam folder or",
                  '\u0644\u0645 \u062a\u0633\u062a\u0644\u0645 \u0627\u0644\u0628\u0631\u064a\u062f\u061f \u062a\u062d\u0642\u0642 \u0645\u0646 \u0645\u062c\u0644\u062f \u0627\u0644\u0631\u0633\u0627\u0626\u0644 \u063a\u064a\u0631 \u0627\u0644\u0645\u0631\u063a\u0648\u0628\u0629 \u0623\u0648'
                )}{' '}
                <button
                  type="button"
                  onClick={() => setIsSubmitted(false)}
                  className="text-primary hover:underline"
                >
                  {t(
                    'try again',
                    '\u062d\u0627\u0648\u0644 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649'
                  )}
                </button>
              </p>
            </div>

            <Link
              href={storeUrl('/auth/login')}
              className="inline-block text-sm text-primary hover:underline"
            >
              &larr;{' '}
              {t(
                'Back to sign in',
                '\u0627\u0644\u0639\u0648\u062f\u0629 \u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
              )}
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
              {t(
                'Forgot password?',
                '\u0646\u0633\u064a\u062a \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631\u061f'
              )}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                "No worries, we'll send you reset instructions.",
                '\u0644\u0627 \u062a\u0642\u0644\u0642\u060c \u0633\u0646\u0631\u0633\u0644 \u0644\u0643 \u062a\u0639\u0644\u064a\u0645\u0627\u062a \u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u062a\u0639\u064a\u064a\u0646.'
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

            <form onSubmit={handleSubmit} className="space-y-6">
              <Input
                label={t(
                  'Email address',
                  '\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a'
                )}
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                {t(
                  'Send reset link',
                  '\u0625\u0631\u0633\u0627\u0644 \u0631\u0627\u0628\u0637 \u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u062a\u0639\u064a\u064a\u0646'
                )}
              </Button>
            </form>
          </div>

          <p className="text-center text-sm">
            <Link href={storeUrl('/auth/login')} className="text-primary hover:underline">
              &larr;{' '}
              {t(
                'Back to sign in',
                '\u0627\u0644\u0639\u0648\u062f\u0629 \u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
              )}
            </Link>
          </p>
        </div>
      </div>
    </MinimalChrome>
  );
}
