'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from '../../../components/StoreLink';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { safeInternalPath } from '@ebda/shared';
import { useCart } from '../../../contexts/CartContext';
import { useStoreUrl, useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useAuth } from '../../../contexts/AuthContext';
import ResendVerification from '../../../components/ResendVerification';
import {
  isPasskeyCancel,
  passkeyAutofillSupported,
  passkeysSupported,
} from '../../../lib/passkeys';

const PASSKEY_FAILED = (t: (en: string, ar: string) => string) =>
  t(
    'Passkey sign-in did not work. Try again, or use your email and password.',
    '\u0645\u0642\u062f\u0631\u0646\u0627\u0634 \u0646\u062f\u062e\u0644\u0643 \u0628\u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631. \u062c\u0631\u0651\u0628 \u062a\u0627\u0646\u064a \u0623\u0648 \u0627\u062f\u062e\u0644 \u0628\u0627\u0644\u0625\u064a\u0645\u064a\u0644 \u0648\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631.'
  );

export default function LoginClient() {
  const { isLoading, error, submit } = useAuthFormSubmit();
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { syncCartToBackend } = useCart();
  const { t } = useLanguage();
  const { loginWithPasskey } = useAuth();
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  // Passkeys (Face ID / Touch ID / Windows Hello). Optional: the password form stays the default.
  const [canUsePasskey, setCanUsePasskey] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState('');
  // QA P2-8: the API named the account as not yet verified; offer the link again instead of a raw message.
  const [unverified, setUnverified] = useState(false);

  const finishPasskeyLogin = async () => {
    await syncCartToBackend();
    router.push(storeUrl(safeInternalPath(searchParams.get('redirect'), '/')));
  };

  // Capability check only on load; the ceremony - and its /begin request - starts ON DEMAND (review M3),
  // so merely opening this page costs the passkey limiter nothing.
  useEffect(() => {
    setCanUsePasskey(passkeysSupported());
  }, []);

  // Conditional UI: on the first focus of the email field the saved passkey is offered in the browser's
  // autofill list; this settles only if the shopper picks it. The button below starts a normal prompt.
  const conditionalStarted = useRef(false);
  const startConditionalPasskey = () => {
    if (conditionalStarted.current || !canUsePasskey) return;
    conditionalStarted.current = true;
    void passkeyAutofillSupported().then(ok => {
      if (!ok) return;
      loginWithPasskey(true)
        .then(r => (r.success ? finishPasskeyLogin() : undefined))
        .catch(() => {
          /* cancelled or replaced: the password form is right there */
        });
    });
  };

  const handlePasskey = async () => {
    setPasskeyError('');
    setPasskeyBusy(true);
    try {
      const r = await loginWithPasskey(false);
      if (r.success) {
        await finishPasskeyLogin();
        return;
      }
      setPasskeyError(PASSKEY_FAILED(t));
    } catch (err) {
      if (!isPasskeyCancel(err)) setPasskeyError(PASSKEY_FAILED(t));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnverified(false);
    await submit(async () => {
      const result = await api.login(formData.email, formData.password, store?.id);

      if (!result.success) {
        if (result.error?.code === 'EMAIL_NOT_VERIFIED') {
          setUnverified(true);
          throw new Error(
            t(
              'Your email is not verified yet. Open the link we sent you, or ask for a new one below.',
              'بريدك لسه متأكدش. افتح الرابط اللي بعتناه ليك، أو اطلب رابط جديد من تحت.'
            )
          );
        }
        throw new Error(result.error?.message || 'Failed to login');
      }

      // Sync local cart to backend after login
      await syncCartToBackend();

      // Redirect to the original page or home. safeInternalPath rejects
      // offsite targets \u2014 absolute, protocol-relative (//host), AND backslash
      // tricks (/\host) that the old startsWith('//') check let through.
      const redirectTo = safeInternalPath(searchParams.get('redirect'), '/');
      router.push(storeUrl(redirectTo));
    }, 'Failed to login');
  };

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Header \u2014 logo lives in MinimalChrome; keep only the page heading. */}
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t('Welcome back', 'مرحباً بعودتك')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("Don't have an account?", 'معندكش حساب؟')}{' '}
              <Link
                href={storeUrl('/auth/register')}
                className="font-medium text-primary underline underline-offset-2"
              >
                {t('Sign up', 'إنشاء حساب')}
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

            {unverified && (
              <div className="mb-4">
                <ResendVerification email={formData.email} />
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              <Input
                label={t('Email address', 'البريد الإلكتروني')}
                type="email"
                autoComplete="username webauthn"
                onFocus={startConditionalPasskey}
                value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })}
                required
              />

              <div>
                <Input
                  label={t('Password', 'كلمة المرور')}
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
                    {t('Forgot password?', 'نسيت كلمة المرور؟')}
                  </Link>
                </div>
              </div>

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                {t('Sign in', 'تسجيل الدخول')}
              </Button>
            </form>

            {canUsePasskey && (
              <div className="mt-6 space-y-3">
                <div className="relative text-center text-xs text-muted-foreground">
                  <span className="relative bg-card px-3">{t('or', '\u0623\u0648')}</span>
                  <div className="absolute inset-x-0 top-1/2 -z-0 border-t" aria-hidden="true" />
                </div>
                {passkeyError && (
                  <div
                    role="alert"
                    className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
                  >
                    {passkeyError}
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="min-h-11 w-full"
                  onClick={handlePasskey}
                  isLoading={passkeyBusy}
                >
                  {t(
                    'Sign in with Face ID or a passkey',
                    '\u0627\u062f\u062e\u0644 \u0628\u0628\u0635\u0645\u0629 \u0627\u0644\u0648\u062c\u0647 \u0623\u0648 \u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631'
                  )}
                </Button>
              </div>
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground">
            {t('By signing in, you agree to our', 'لما تسجّل دخول، إنت موافق على')}{' '}
            <Link href={storeUrl('/terms')} className="text-primary underline underline-offset-2">
              {t('Terms of Service', 'الشروط والأحكام')}
            </Link>{' '}
            {t('and', 'و')}{' '}
            <Link href={storeUrl('/privacy')} className="text-primary underline underline-offset-2">
              {t('Privacy Policy', 'سياسة الخصوصية')}
            </Link>
          </p>
        </div>
      </div>
    </MinimalChrome>
  );
}
