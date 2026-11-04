'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod/v3';
import { useAuth } from '@/lib/auth';
import { useLanguage } from '@/contexts/LanguageContext';
import { LangToggle } from '@/components/LangToggle';
import { BRAND } from '@ebda/shared';
import { signInErrorText } from '@/lib/sign-in-error';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const REMEMBER_EMAIL_KEY = 'force-orders-remember-email';

export default function LoginPage() {
  const router = useRouter();
  const { login, completeMfaLogin, isAuthenticated, isLoading } = useAuth();
  const { t, locale } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // When the account has 2FA, login() returns a challenge token and we switch
  // to a code-entry step instead of failing.
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  function persistRememberedEmail(value: string) {
    if (typeof window === 'undefined') return;
    if (rememberMe) localStorage.setItem(REMEMBER_EMAIL_KEY, value);
    else localStorage.removeItem(REMEMBER_EMAIL_KEY);
  }

  // Already signed in → go straight to orders.
  useEffect(() => {
    if (!isLoading && isAuthenticated) router.replace('/orders');
  }, [isLoading, isAuthenticated, router]);

  // On mount: prefill email + check box if a remembered email exists.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = localStorage.getItem(REMEMBER_EMAIL_KEY);
    if (saved) {
      setEmail(saved);
      setRememberMe(true);
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = loginSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue?.path[0] === 'email' ? t.login.invalidEmail : t.login.passwordRequired);
      return;
    }

    setSubmitting(true);
    try {
      const result = await login(parsed.data.email, parsed.data.password);
      // 2FA-enabled account → switch to the code-entry step (no error).
      if (result && result.mfaRequired) {
        persistRememberedEmail(parsed.data.email);
        setMfaChallengeToken(result.challengeToken);
        return;
      }
      // Login succeeded — persist or clear the remembered email.
      persistRememberedEmail(parsed.data.email);
    } catch (err) {
      setError(signInErrorText(err instanceof Error ? err.message : '', t.login));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const code = mfaCode.trim();
    if (!code) {
      setError(t.login.mfaCodeRequired);
      return;
    }
    if (!mfaChallengeToken) return;
    setSubmitting(true);
    try {
      await completeMfaLogin(mfaChallengeToken, code);
    } catch (err) {
      setError(signInErrorText(err instanceof Error ? err.message : '', t.login));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <LangToggle />
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            {/* Studio first, then the product (the h1 below names the product). Night + Ebda gold, no orange. */}
            <div className="mx-auto mb-4 flex items-center justify-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo-on-light.svg"
                alt=""
                className="h-10 w-auto dark:hidden"
                width={21}
                height={40}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.svg"
                alt=""
                className="hidden h-10 w-auto dark:block"
                width={21}
                height={40}
              />
              <span className="text-sm font-medium text-primary-ink">
                {locale === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn}
              </span>
            </div>
            <h1 className="text-xl font-bold text-foreground">
              {mfaChallengeToken ? t.login.mfaTitle : t.login.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {mfaChallengeToken ? t.login.mfaSubtitle : t.login.subtitle}
            </p>
          </div>

          {mfaChallengeToken ? (
            <form onSubmit={handleMfaSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="mfa-code"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  {t.login.mfaCodeLabel}
                </label>
                <input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={mfaCode}
                  onChange={e => setMfaCode(e.target.value)}
                  className="h-12 w-full rounded-xl border border-input bg-card px-4 text-center text-lg tracking-[0.4em] text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                  required
                />
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-ink"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:opacity-90 disabled:opacity-60"
              >
                {submitting ? t.login.submitting : t.login.mfaVerify}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMfaChallengeToken(null);
                  setMfaCode('');
                  setError(null);
                }}
                className="h-10 w-full rounded-xl text-sm font-medium text-muted-foreground active:opacity-90"
              >
                {t.login.back}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-foreground">
                  {t.login.email}
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="h-12 w-full rounded-xl border border-input bg-card px-4 text-base text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor="password"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  {t.login.password}
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="h-12 w-full rounded-xl border border-input bg-card px-4 text-base text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                  required
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
                  {t.login.rememberMe}
                </label>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-ink"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:opacity-90 disabled:opacity-60"
              >
                {submitting ? t.login.submitting : t.login.submit}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
