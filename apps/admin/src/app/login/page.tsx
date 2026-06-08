'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Button, Input } from '@force/ui';
import { useAuth, type MfaChallenge } from '../../lib/auth';
import { useT } from '@/i18n/useT';

export default function LoginPage() {
  const t = useT('auth.login');
  const tb = useT('components.brand');
  const { login, completeMfaLogin, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // MFA step state
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const result = await login(email, password);
      if (result && result.mfaRequired) {
        setMfaChallenge(result);
      }
      // If result is void the login succeeded and router.push('/') was called inside login()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loginFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaChallenge) return;
    setError('');
    setIsLoading(true);

    try {
      await completeMfaLogin(mfaChallenge.challengeToken, mfaCode.trim());
      // completeMfaLogin calls router.push('/') on success
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mfaInvalid'));
      setMfaCode('');
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

  // ── MFA step ───────────────────────────────────────────────────────────────
  if (mfaChallenge) {
    return (
      <div className="flex min-h-screen">
        <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
          <div className="mx-auto w-full max-w-sm lg:w-96">
            <div className="text-center">
              <div className="flex justify-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                    />
                  </svg>
                </div>
              </div>
              <h2 className="mt-6 text-3xl font-bold text-foreground">{t('mfaRequired')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {useBackupCode ? t('mfaBackupSubtitle') : t('mfaSubtitle')}
              </p>
            </div>

            <form className="mt-8 space-y-6" onSubmit={handleMfaSubmit}>
              {error && (
                <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="mfa-code" className="block text-sm font-medium text-foreground">
                  {t('mfaCode')}
                </label>
                <Input
                  id="mfa-code"
                  name="code"
                  type="text"
                  inputMode={useBackupCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={mfaCode}
                  onChange={e => setMfaCode(e.target.value)}
                  className="mt-1 text-center tracking-widest"
                  placeholder={useBackupCode ? '••••••••••' : t('mfaCodePlaceholder')}
                  maxLength={useBackupCode ? 10 : 6}
                />
              </div>

              <Button type="submit" className="w-full" disabled={isLoading || !mfaCode.trim()}>
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
                    {t('mfaVerifying')}
                  </>
                ) : (
                  t('mfaVerify')
                )}
              </Button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => {
                    setUseBackupCode(b => !b);
                    setMfaCode('');
                    setError('');
                  }}
                  className="text-sm text-primary hover:underline"
                >
                  {useBackupCode ? t('mfaTotpLink') : t('mfaBackupLink')}
                </button>
              </div>
            </form>

            <p className="mt-8 text-center text-xs text-muted-foreground">{t('footer')}</p>
          </div>
        </div>

        {/* Right side - Branding */}
        <div className="relative hidden w-0 flex-1 lg:block">
          <div className="absolute inset-0 bg-gradient-to-br from-primary to-primary/80">
            <div className="flex h-full flex-col items-center justify-center px-12 text-white">
              <h1 className="text-4xl font-bold">{t('brandTitle')}</h1>
              <p className="mt-4 text-lg text-white/80 text-center max-w-md">
                {t('brandSubtitle')}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Normal login step ──────────────────────────────────────────────────────
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
