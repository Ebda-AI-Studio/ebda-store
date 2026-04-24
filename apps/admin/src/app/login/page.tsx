'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Button, Input } from '@force/ui';
import { useAuth } from '../../lib/auth';
import { useT } from '@/i18n/useT';

export default function LoginPage() {
  const t = useT('auth.login');
  const tb = useT('components.brand');
  const { login, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loginFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Left side - Login form */}
      <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm lg:w-96">
          <div className="text-center">
            <div className="flex justify-center">
              <Image src="/logo.svg" alt={tb('forceMediaAlt')} width={48} height={36} unoptimized />
            </div>
            <h2 className="mt-6 text-3xl font-bold text-foreground">{t('title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>

          <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
            {error && (
              <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground">
                {t('email')}
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="mt-1"
                placeholder={t('emailPlaceholder')}
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-foreground">
                {t('password')}
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="mt-1"
                placeholder={t('passwordPlaceholder')}
              />
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <svg className="me-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  {t('signingIn')}
                </>
              ) : (
                t('signIn')
              )}
            </Button>
          </form>

          <p className="mt-8 text-center text-xs text-muted-foreground">{t('footer')}</p>
        </div>
      </div>

      {/* Right side - Branding */}
      <div className="relative hidden w-0 flex-1 lg:block">
        <div className="absolute inset-0 bg-gradient-to-br from-primary to-primary/80">
          <div className="flex h-full flex-col items-center justify-center px-12 text-white">
            <h1 className="text-4xl font-bold">{t('brandTitle')}</h1>
            <p className="mt-4 text-lg text-white/80 text-center max-w-md">{t('brandSubtitle')}</p>
            <div className="mt-12 grid grid-cols-3 gap-8 text-center">
              <div>
                <p className="text-3xl font-bold">100+</p>
                <p className="text-sm text-white/70">{t('statActiveStores')}</p>
              </div>
              <div>
                <p className="text-3xl font-bold">10K+</p>
                <p className="text-sm text-white/70">{t('statProducts')}</p>
              </div>
              <div>
                <p className="text-3xl font-bold">50K+</p>
                <p className="text-sm text-white/70">{t('statOrders')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
