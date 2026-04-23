'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Input } from '@force/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

export default function RegisterClient() {
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // Validate passwords match
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      setIsLoading(false);
      return;
    }

    // Validate password strength
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters');
      setIsLoading(false);
      return;
    }

    try {
      const result = await api.register({
        email: formData.email,
        password: formData.password,
        firstName: formData.firstName,
        lastName: formData.lastName,
      });

      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to register');
      }

      // Access token is set as HTTP-only cookie by the API.
      // Only store refresh token in localStorage.
      if (result.data) {
        localStorage.setItem('refreshToken', result.data.refreshToken);
      }

      // Redirect to home
      router.push(storeUrl('/'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Header — logo lives in MinimalChrome; keep only the page heading. */}
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t(
                'Create your account',
                '\u0625\u0646\u0634\u0627\u0621 \u062d\u0633\u0627\u0628\u0643'
              )}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                'Already have an account?',
                '\u0644\u062f\u064a\u0643 \u062d\u0633\u0627\u0628 \u0628\u0627\u0644\u0641\u0639\u0644\u061f'
              )}{' '}
              <Link
                href={storeUrl('/auth/login')}
                className="font-medium text-primary hover:underline"
              >
                {t(
                  'Sign in',
                  '\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
                )}
              </Link>
            </p>
          </div>

          {/* Form */}
          <div className="rounded-xl border bg-card p-8 shadow-sm">
            {error && (
              <div
                role="alert"
                className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t(
                    'First name',
                    '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u0648\u0644'
                  )}
                  autoComplete="given-name"
                  value={formData.firstName}
                  onChange={e => setFormData({ ...formData, firstName: e.target.value })}
                  required
                />
                <Input
                  label={t(
                    'Last name',
                    '\u0627\u0633\u0645 \u0627\u0644\u0639\u0627\u0626\u0644\u0629'
                  )}
                  autoComplete="family-name"
                  value={formData.lastName}
                  onChange={e => setFormData({ ...formData, lastName: e.target.value })}
                  required
                />
              </div>

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

              <Input
                label={t(
                  'Password',
                  '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
                )}
                type="password"
                autoComplete="new-password"
                value={formData.password}
                onChange={e => setFormData({ ...formData, password: e.target.value })}
                required
              />

              <Input
                label={t(
                  'Confirm password',
                  '\u062a\u0623\u0643\u064a\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
                )}
                type="password"
                autoComplete="new-password"
                value={formData.confirmPassword}
                onChange={e => setFormData({ ...formData, confirmPassword: e.target.value })}
                required
              />

              <div className="flex items-start gap-2">
                <input
                  id="terms"
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  required
                />
                <label htmlFor="terms" className="text-sm text-muted-foreground">
                  {t('I agree to the', '\u0623\u0648\u0627\u0641\u0642 \u0639\u0644\u0649')}{' '}
                  <Link href={storeUrl('/terms')} className="text-primary hover:underline">
                    {t(
                      'Terms of Service',
                      '\u0627\u0644\u0634\u0631\u0648\u0637 \u0648\u0627\u0644\u0623\u062d\u0643\u0627\u0645'
                    )}
                  </Link>{' '}
                  {t('and', '\u0648')}{' '}
                  <Link href={storeUrl('/privacy')} className="text-primary hover:underline">
                    {t(
                      'Privacy Policy',
                      '\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u062e\u0635\u0648\u0635\u064a\u0629'
                    )}
                  </Link>
                </label>
              </div>

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                {t('Create account', '\u0625\u0646\u0634\u0627\u0621 \u062d\u0633\u0627\u0628')}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </MinimalChrome>
  );
}
