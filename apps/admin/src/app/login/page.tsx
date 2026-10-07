'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@force/ui';
import { useAuth, postLoginDestination, type MfaChallenge } from '../../lib/auth';
import { useT } from '@/i18n/useT';
import { NileNight } from './_components/NileNight';

const REMEMBER_EMAIL_KEY = 'force-admin-remember-email';

export default function LoginPage() {
  const t = useT('auth.login');
  const tb = useT('components.brand');
  const tSignup = useT('onboarding.signup');
  const router = useRouter();
  const { login, completeMfaLogin, isLoading: authLoading, isAuthenticated } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // On mount: prefill email + check box if a remembered email exists.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = localStorage.getItem(REMEMBER_EMAIL_KEY);
    if (saved) {
      setEmail(saved);
      setRememberMe(true);
    }
  }, []);

  // Already signed in → skip the form. This is also how a session that was
  // only *throttled* elsewhere recovers: AuthProvider's mount check now runs
  // on /login too (#1814), so a reload here can turn a surviving refresh
  // token back into `isAuthenticated` without a password, and this effect is
  // what actually carries the user onward instead of leaving them staring at
  // a login form they don't need.
  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      router.replace(postLoginDestination());
    }
  }, [authLoading, isAuthenticated, router]);

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
      } else {
        // Login succeeded — persist or clear the remembered email.
        if (typeof window !== 'undefined') {
          if (rememberMe) {
            localStorage.setItem(REMEMBER_EMAIL_KEY, email);
          } else {
            localStorage.removeItem(REMEMBER_EMAIL_KEY);
          }
        }
      }
      // If result is void the login succeeded and login() navigated to the
      // ?returnTo= destination (or '/') via postLoginDestination()
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
      // completeMfaLogin navigates to the ?returnTo= destination (or '/') on success
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mfaInvalid'));
      setMfaCode('');
    } finally {
      setIsLoading(false);
    }
  }

  // No full-screen spinner while the mount check runs (#2159): with a
  // throttled refresh bucket that check waits out MOUNT_RETRY_DELAYS_MS
  // (~21s), and the one page a locked-out admin needs was unreachable for all
  // of it. The form renders at once; the effect above still carries an
  // already-signed-in user onward when the check resolves, and a login that
  // lands first supersedes the check (#2161).
  // ── MFA step ───────────────────────────────────────────────────────────────
  if (mfaChallenge) {
    return (
      <div className="flex min-h-screen flex-col lg:flex-row">
        {/* Mobile: short Nile band above the form (decorative) */}
        <div className="relative h-24 shrink-0 overflow-hidden bg-[#0A0B0C] lg:hidden">
          <NileNight />
        </div>
        <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
          <div className="mx-auto w-full max-w-sm lg:w-96">
            <div className="text-center">
              <div className="flex justify-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
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
                <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive-ink">
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
          <div className="absolute inset-0 bg-[#0A0B0C]">
            <NileNight />
            <div className="absolute inset-0 bg-[#0A0B0C]/55" aria-hidden="true" />
            <div className="relative flex h-full flex-col items-center justify-center px-12 text-white">
              <h1 className="text-4xl font-bold">{t('brandTitle')}</h1>
              <p className="mt-4 text-lg text-white/85 text-center max-w-md">
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
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Mobile band, then login form */}
      {/* Mobile: short Nile band above the form (decorative) */}
      <div className="relative h-24 shrink-0 overflow-hidden bg-[#0A0B0C] lg:hidden">
        <NileNight />
      </div>
      <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm lg:w-96">
          <div className="text-center">
            <div className="flex justify-center">
              <Image
                src="/lockup-light.svg"
                alt={tb('forceMediaAlt')}
                width={180}
                height={60}
                className="dark:hidden"
                unoptimized
              />
              <Image
                src="/lockup-dark.svg"
                alt={tb('forceMediaAlt')}
                width={180}
                height={60}
                className="hidden dark:block"
                unoptimized
              />
            </div>
            <h2 className="mt-6 text-3xl font-bold text-foreground">{t('title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>

          <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
            {error && (
              <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive-ink">
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

            <div className="flex items-center gap-2">
              <input
                id="remember-me"
                name="rememberMe"
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
              />
              <label htmlFor="remember-me" className="text-sm text-muted-foreground">
                {t('rememberMe')}
              </label>
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

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {tSignup('noAccount')}{' '}
            <Link href="/signup" className="text-primary-ink hover:underline">
              {tSignup('createStore')}
            </Link>
          </p>

          <p className="mt-8 text-center text-xs text-muted-foreground">{t('footer')}</p>
        </div>
      </div>

      {/* Right side - Branding */}
      <div className="relative hidden w-0 flex-1 lg:block">
        <div className="absolute inset-0 bg-[#0A0B0C]">
          <NileNight />
          <div className="absolute inset-0 bg-[#0A0B0C]/55" aria-hidden="true" />
          <div className="relative flex h-full flex-col items-center justify-center px-12 text-white">
            <h1 className="text-4xl font-bold">{t('brandTitle')}</h1>
            <p className="mt-4 text-lg text-white/85 text-center max-w-md">{t('brandSubtitle')}</p>
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
