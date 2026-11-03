'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@ebda/ui';
import { useAuth, postLoginDestination, goAfterSignIn, type MfaChallenge } from '../../lib/auth';
import { isPasskeyCancel, passkeyAutofillSupported, passkeysSupported } from '../../lib/passkeys';
import { useT } from '@/i18n/useT';
import { NileNight } from './_components/NileNight';
import AdminLanguageSwitcher from '@/components/AdminLanguageSwitcher';
import { SignInBrand } from '@/components/SignInBrand';
import { signInProduct, type SignInProduct } from '../../lib/sign-in-return';
import { DocumentTitle } from '@/components/DocumentTitle';
import { consumeSessionEnded } from '../../lib/session-ended';

const REMEMBER_EMAIL_KEY = 'force-admin-remember-email';

export default function LoginPage() {
  const t = useT('auth.login');
  // Which product sent the person here (?product=chat from Ebda Chat); anything else is the Store (Ruling SIGNIN-RETURN-1).
  // `null` until the query is read: the first render is neutral, so a Chat visitor never sees the Store's name first.
  const [product, setProduct] = useState<SignInProduct | null>(null);
  useEffect(() => {
    setProduct(signInProduct(new URLSearchParams(window.location.search).get('product')));
  }, []);
  const tp = (key: 'title' | 'subtitle' | 'footer' | 'brandTitle' | 'brandSubtitle') => {
    if (product === null) return key === 'title' ? t('title') : '';
    return t(product === 'chat' ? (`${key}Chat` as const) : key);
  };
  const tSignup = useT('onboarding.signup');
  const router = useRouter();
  const {
    login,
    completeMfaLogin,
    loginWithPasskey,
    isLoading: authLoading,
    isAuthenticated,
  } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // A revoked session sends people here with ?ended=1 (and the flag): say why, calmly, once.
  const [sessionEnded, setSessionEnded] = useState(false);
  useEffect(() => {
    const flagged = consumeSessionEnded();
    const queried =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('ended') === '1';
    if (flagged || queried) setSessionEnded(true);
  }, []);

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
      goAfterSignIn(router, postLoginDestination(), 'replace');
    }
  }, [authLoading, isAuthenticated, router]);

  // Passkeys (Ruling PASSKEY-4: a passkey satisfies MFA, so there is no code step after it).
  // Capability check only on load; the ceremony - and its /begin request - starts ON DEMAND (review M3),
  // so a page load costs the passkey limiter nothing.
  const [canUsePasskey, setCanUsePasskey] = useState(false);
  const conditionalStarted = useRef(false);
  useEffect(() => {
    setCanUsePasskey(passkeysSupported());
  }, []);

  // Conditional UI: on the first focus of the email field the browser offers the saved passkey in its
  // autofill list; the promise settles only if the person picks one. The button below replaces it.
  function startConditionalPasskey() {
    if (conditionalStarted.current || !canUsePasskey) return;
    conditionalStarted.current = true;
    void passkeyAutofillSupported().then(ok => {
      if (!ok) return;
      loginWithPasskey('conditional').catch(() => {
        /* cancelled, replaced, or not chosen: the password form is still right there */
      });
    });
  }

  async function handlePasskey() {
    setError('');
    setIsLoading(true);
    try {
      await loginWithPasskey('modal');
    } catch (err) {
      if (!isPasskeyCancel(err)) {
        setError(
          err instanceof Error && err.message === t('accessDenied')
            ? err.message
            : t('passkeyFailed')
        );
      }
    } finally {
      setIsLoading(false);
    }
  }

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
      <main
        id="admin-main-content"
        tabIndex={-1}
        className="flex min-h-screen flex-col outline-none lg:flex-row"
      >
        {/* Mobile: short Nile band above the form (decorative) */}
        <div className="relative h-24 shrink-0 overflow-hidden bg-[#0A0B0C] lg:hidden">
          <NileNight />
        </div>
        <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
          <div className="mx-auto w-full max-w-sm lg:w-96">
            <div className="mb-6 flex justify-end">
              <AdminLanguageSwitcher />
            </div>
            <DocumentTitle title={tp('title')} />
            <div className="text-center">
              <SignInBrand product={product} />
              <h1 className="mt-6 text-3xl font-bold text-foreground">{t('mfaRequired')}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {useBackupCode ? t('mfaBackupSubtitle') : t('mfaSubtitle')}
              </p>
            </div>

            <form className="mt-8 space-y-6" onSubmit={handleMfaSubmit}>
              {error && (
                <div
                  role="alert"
                  className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive-ink"
                >
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

            <p className="mt-8 text-center text-xs text-muted-foreground">{tp('footer')}</p>
          </div>
        </div>

        {/* Right side - Branding */}
        <div className="relative hidden w-0 flex-1 lg:block">
          <div className="absolute inset-0 bg-[#0A0B0C]">
            <NileNight />
            <div className="absolute inset-0 bg-[#0A0B0C]/55" aria-hidden="true" />
            <div className="relative flex h-full flex-col items-center justify-center px-12 text-white">
              <p className="text-4xl font-bold">{tp('brandTitle')}</p>
              <p className="mt-4 text-lg text-white/85 text-center max-w-md">
                {tp('brandSubtitle')}
              </p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ── Normal login step ──────────────────────────────────────────────────────
  return (
    <main
      id="admin-main-content"
      tabIndex={-1}
      className="flex min-h-screen flex-col outline-none lg:flex-row"
    >
      {/* Mobile band, then login form */}
      {/* Mobile: short Nile band above the form (decorative) */}
      <div className="relative h-24 shrink-0 overflow-hidden bg-[#0A0B0C] lg:hidden">
        <NileNight />
      </div>
      <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm lg:w-96">
          <div className="mb-6 flex justify-end">
            <AdminLanguageSwitcher />
          </div>
          <DocumentTitle title={tp('title')} />
          <div className="text-center">
            <SignInBrand product={product} />
            <h1 className="mt-6 text-3xl font-bold text-foreground">{tp('title')}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{tp('subtitle')}</p>
          </div>

          <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
            {sessionEnded && !error && (
              <div
                role="status"
                className="rounded-lg border border-border bg-muted p-4 text-sm text-foreground"
              >
                {t('sessionEnded')}
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive-ink"
              >
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
                autoComplete="username webauthn"
                onFocus={startConditionalPasskey}
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
              <div className="mt-2 text-end">
                <Link href="/forgot-password" className="text-sm text-primary-ink hover:underline">
                  {t('forgotPassword')}
                </Link>
              </div>
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

          {canUsePasskey && (
            <div className="mt-6">
              <div className="relative">
                <div className="absolute inset-0 flex items-center" aria-hidden="true">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-background px-3 text-muted-foreground">{t('passkeyOr')}</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="mt-6 min-h-11 w-full"
                onClick={handlePasskey}
                disabled={isLoading}
              >
                {t('passkeySignIn')}
              </Button>
            </div>
          )}

          {/* Store sign-up copy names the Store: shown only once the product is known to be the Store. */}
          {product === 'store' && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              {tSignup('noAccount')}{' '}
              <Link href="/signup" className="text-primary-ink underline underline-offset-4">
                {tSignup('createStore')}
              </Link>
            </p>
          )}

          <p className="mt-8 text-center text-xs text-muted-foreground">{tp('footer')}</p>
        </div>
      </div>

      {/* Right side - Branding */}
      <div className="relative hidden w-0 flex-1 lg:block">
        <div className="absolute inset-0 bg-[#0A0B0C]">
          <NileNight />
          <div className="absolute inset-0 bg-[#0A0B0C]/55" aria-hidden="true" />
          <div className="relative flex h-full flex-col items-center justify-center px-12 text-white">
            <p className="text-4xl font-bold">{tp('brandTitle')}</p>
            <p className="mt-4 text-lg text-white/85 text-center max-w-md">{tp('brandSubtitle')}</p>
          </div>
        </div>
      </div>
    </main>
  );
}
