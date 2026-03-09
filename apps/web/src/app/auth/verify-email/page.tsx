'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

type VerifyState = 'loading' | 'success' | 'error';

export default function VerifyEmailPage() {
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [state, setState] = useState<VerifyState>('loading');
  const [errorMessage, setErrorMessage] = useState(
    'The verification link is invalid or has expired.'
  );
  // Guard against StrictMode double-invoke in development
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    async function verify() {
      // Read the token from the URL search params
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');

      if (!token) {
        setErrorMessage('No verification token was provided. Please check the link in your email.');
        setState('error');
        return;
      }

      try {
        const res = await fetch(`${API_URL}/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const json = await res.json();

        if (res.ok && json.success) {
          setState('success');
        } else {
          setErrorMessage(
            json.error?.message || 'The verification link is invalid or has expired.'
          );
          setState('error');
        }
      } catch {
        setErrorMessage('Unable to verify your email. Please check your connection and try again.');
        setState('error');
      }
    }

    verify();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md text-center">
        {/* Logo */}
        <Link href={storeUrl('/')} className="inline-flex items-center gap-2 mb-8">
          <Image src="/logo.svg" alt="Force Media" width={48} height={36} />
          <span className="text-2xl font-bold">
            <span className="text-primary">Force</span>
            <span className="text-foreground"> Store</span>
          </span>
        </Link>

        <div className="rounded-xl border bg-white p-8 shadow-sm">
          {state === 'loading' && (
            <>
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-50">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              </div>
              <h1 className="mt-6 text-2xl font-bold text-foreground">
                {t('Verifying your email', 'جارٍ تأكيد بريدك الإلكتروني')}
              </h1>
              <p className="mt-2 text-muted-foreground">
                {t(
                  'Please wait while we verify your email address...',
                  'يرجى الانتظار بينما نتحقق من بريدك الإلكتروني...'
                )}
              </p>
            </>
          )}

          {state === 'success' && (
            <>
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                <svg
                  className="h-8 w-8 text-green-600"
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
              <h1 className="mt-6 text-2xl font-bold text-foreground">
                {t('Email Verified!', 'تم تأكيد البريد الإلكتروني!')}
              </h1>
              <p className="mt-2 text-muted-foreground">
                {t(
                  'Your email address has been verified successfully. You can now sign in to your account.',
                  'تم التحقق من بريدك الإلكتروني بنجاح. يمكنك الآن تسجيل الدخول إلى حسابك.'
                )}
              </p>
              <div className="mt-8">
                <Link
                  href={storeUrl('/auth/login')}
                  className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-6 py-3 font-medium text-white hover:bg-primary/90 transition"
                >
                  {t('Go to Login', 'الذهاب لتسجيل الدخول')}
                </Link>
              </div>
            </>
          )}

          {state === 'error' && (
            <>
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
                <svg
                  className="h-8 w-8 text-red-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </div>
              <h1 className="mt-6 text-2xl font-bold text-foreground">
                {t('Invalid Link', 'رابط غير صالح')}
              </h1>
              <p className="mt-2 text-muted-foreground">{errorMessage}</p>
              <div className="mt-8 flex flex-col gap-3">
                <Link
                  href={storeUrl('/auth/login')}
                  className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-6 py-3 font-medium text-white hover:bg-primary/90 transition"
                >
                  {t('Go to Login', 'الذهاب لتسجيل الدخول')}
                </Link>
                <Link
                  href={storeUrl('/')}
                  className="inline-flex w-full items-center justify-center rounded-lg border border-border px-6 py-3 font-medium text-foreground hover:bg-muted transition"
                >
                  {t('Back to Home', 'العودة للرئيسية')}
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
