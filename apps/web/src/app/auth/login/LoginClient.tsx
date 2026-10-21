'use client';

import { useState } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { safeInternalPath } from '@ebda/shared';
import { useCart } from '../../../contexts/CartContext';
import { useStoreUrl, useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

export default function LoginClient() {
  const { isLoading, error, submit } = useAuthFormSubmit();
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { syncCartToBackend } = useCart();
  const { t } = useLanguage();
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submit(async () => {
      const result = await api.login(formData.email, formData.password, store?.id);

      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to login');
      }

      // Sync local cart to backend after login
      await syncCartToBackend();

      // Redirect to the original page or home. safeInternalPath rejects
      // offsite targets — absolute, protocol-relative (//host), AND backslash
      // tricks (/\host) that the old startsWith('//') check let through.
      const redirectTo = safeInternalPath(searchParams.get('redirect'), '/');
      router.push(storeUrl(redirectTo));
    }, 'Failed to login');
  };

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Header — logo lives in MinimalChrome; keep only the page heading. */}
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t(
                'Welcome back',
                '\u0645\u0631\u062d\u0628\u0627\u064b \u0628\u0639\u0648\u062f\u062a\u0643'
              )}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                "Don't have an account?",
                '\u0644\u064a\u0633 \u0644\u062f\u064a\u0643 \u062d\u0633\u0627\u0628\u061f'
              )}{' '}
              <Link
                href={storeUrl('/auth/register')}
                className="font-medium text-primary underline underline-offset-2"
              >
                {t('Sign up', '\u0625\u0646\u0634\u0627\u0621 \u062d\u0633\u0627\u0628')}
              </Link>
            </p>
          </div>

          {/* Form */}
          <div className="rounded-xl border bg-card p-8 shadow-sm">
            {error && (
              <div
                role="alert"
                className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
              >
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
                value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })}
                required
              />

              <div>
                <Input
                  label={t(
                    'Password',
                    '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
                  )}
                  type="password"
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={e => setFormData({ ...formData, password: e.target.value })}
                  required
                />
                <div className="mt-2 text-right">
                  <Link
                    href={storeUrl('/auth/forgot-password')}
                    className="text-sm text-primary hover:underline"
                  >
                    {t(
                      'Forgot password?',
                      '\u0646\u0633\u064a\u062a \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631\u061f'
                    )}
                  </Link>
                </div>
              </div>

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                {t(
                  'Sign in',
                  '\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
                )}
              </Button>
            </form>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            {t(
              'By signing in, you agree to our',
              '\u0628\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644\u060c \u0623\u0646\u062a \u062a\u0648\u0627\u0641\u0642 \u0639\u0644\u0649'
            )}{' '}
            <Link href={storeUrl('/terms')} className="text-primary underline underline-offset-2">
              {t(
                'Terms of Service',
                '\u0627\u0644\u0634\u0631\u0648\u0637 \u0648\u0627\u0644\u0623\u062d\u0643\u0627\u0645'
              )}
            </Link>{' '}
            {t('and', '\u0648')}{' '}
            <Link href={storeUrl('/privacy')} className="text-primary underline underline-offset-2">
              {t(
                'Privacy Policy',
                '\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u062e\u0635\u0648\u0635\u064a\u0629'
              )}
            </Link>
          </p>
        </div>
      </div>
    </MinimalChrome>
  );
}
