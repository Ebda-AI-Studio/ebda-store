'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { MinimalChrome } from '../../../components';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { API_URL } from '../../../lib/api';

/**
 * `retry` is a TRANSIENT failure — the verification endpoint throttled us
 * (#1863: a shared Kuwait carrier/office IP) or the network dropped. The
 * link itself may be perfectly valid, so this state must never read
 * "Invalid Link" and must offer a way to try the SAME token again (#2162):
 * Login is a dead end for an address that is still unverified.
 */
type VerifyState = 'loading' | 'success' | 'error' | 'retry';
type RetryReason = 'throttled' | 'network';

export default function VerifyEmailClient() {
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [state, setState] = useState<VerifyState>('loading');
  const [retryReason, setRetryReason] = useState<RetryReason>('throttled');
  const [errorMessage, setErrorMessage] = useState('');
  // Guard against StrictMode double-invoke in development
  const called = useRef(false);

  const invalidLinkCopy = t(
    'The verification link is invalid or has expired.',
    'رابط التحقق غير صالح أو منتهي الصلاحية.'
  );

  async function verify() {
    setState('loading');
    // Read the token from the URL search params
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
      setErrorMessage(
        t(
          'No verification token was provided. Please check the link in your email.',
          'لم يتم تقديم رمز التحقق. يرجى التحقق من الرابط في بريدك الإلكتروني.'
        )
      );
      setState('error');
      return;
    }

    try {
      const res = await fetch(`${API_URL}/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const json = await res.json().catch(() => null);

      if (res.ok && json?.success) {
        setState('success');
      } else if (res.status === 429 || json?.error?.code === 'RATE_LIMITED') {
        setRetryReason('throttled');
        setState('retry');
      } else if (res.status >= 500 || !json) {
        // The server could not answer (5xx, or a non-JSON edge error page):
        // nothing is known about the link, so it is not called invalid.
        setRetryReason('network');
        setState('retry');
      } else {
        // The server's message is English-only; the shopper sees localized
        // copy keyed on the error code instead.
        setErrorMessage(
          json.error?.code === 'TOKEN_EXPIRED'
            ? t(
                'This verification link has expired. Please request a new one.',
                'انتهت صلاحية رابط التحقق هذا. يرجى طلب رابط جديد.'
              )
            : invalidLinkCopy
        );
        setState('error');
      }
    } catch {
      setRetryReason('network');
      setState('retry');
    }
  }

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md text-center">
          <div className="rounded-xl border bg-card p-8 shadow-sm">
            {state === 'loading' && (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-info/10">
                  <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                </div>
                <h1 className="mt-6 text-2xl font-bold text-foreground">
                  {t(
                    'Verifying your email',
                    '\u062c\u0627\u0631\u064d \u062a\u0623\u0643\u064a\u062f \u0628\u0631\u064a\u062f\u0643 \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a'
                  )}
                </h1>
                <p className="mt-2 text-muted-foreground">
                  {t(
                    'Please wait while we verify your email address...',
                    '\u064a\u0631\u062c\u0649 \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631 \u0628\u064a\u0646\u0645\u0627 \u0646\u062a\u062d\u0642\u0642 \u0645\u0646 \u0628\u0631\u064a\u062f\u0643 \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a...'
                  )}
                </p>
              </>
            )}

            {state === 'success' && (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/20">
                  <svg
                    className="h-8 w-8 text-success-ink"
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
                  {t(
                    'Email Verified!',
                    '\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a!'
                  )}
                </h1>
                <p className="mt-2 text-muted-foreground">
                  {t(
                    'Your email address has been verified successfully. You can now sign in to your account.',
                    '\u062a\u0645 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0628\u0631\u064a\u062f\u0643 \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a \u0628\u0646\u062c\u0627\u062d. \u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u0622\u0646 \u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0625\u0644\u0649 \u062d\u0633\u0627\u0628\u0643.'
                  )}
                </p>
                <div className="mt-8">
                  <Link
                    href={storeUrl('/auth/login')}
                    className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-6 py-3 font-medium text-white hover:bg-primary/90 transition"
                  >
                    {t(
                      'Go to Login',
                      '\u0627\u0644\u0630\u0647\u0627\u0628 \u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
                    )}
                  </Link>
                </div>
              </>
            )}

            {state === 'retry' && (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-info/10">
                  <svg
                    className="h-8 w-8 text-info-ink"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <h1 className="mt-6 text-2xl font-bold text-foreground">
                  {retryReason === 'throttled'
                    ? t('Too many attempts', 'محاولات كثيرة جدًا')
                    : t("We couldn't verify right now", 'تعذّر التحقق الآن')}
                </h1>
                <p className="mt-2 text-muted-foreground" role="status">
                  {retryReason === 'throttled'
                    ? t(
                        'Your link is still valid. Please wait a few minutes, then try again.',
                        'رابطك لا يزال صالحًا. يرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.'
                      )
                    : t(
                        'Please check your connection and try again. Your link is still valid.',
                        'يرجى التحقق من اتصالك والمحاولة مرة أخرى. رابطك لا يزال صالحًا.'
                      )}
                </p>
                <div className="mt-8 flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => verify()}
                    className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-6 py-3 font-medium text-white hover:bg-primary/90 transition"
                  >
                    {t('Try again', 'حاول مرة أخرى')}
                  </button>
                  <Link
                    href={storeUrl('/')}
                    className="inline-flex w-full items-center justify-center rounded-lg border border-border px-6 py-3 font-medium text-foreground hover:bg-muted transition"
                  >
                    {t(
                      'Back to Home',
                      '\u0627\u0644\u0639\u0648\u062f\u0629 \u0644\u0644\u0631\u0626\u064a\u0633\u064a\u0629'
                    )}
                  </Link>
                </div>
              </>
            )}

            {state === 'error' && (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/20">
                  <svg
                    className="h-8 w-8 text-destructive-ink"
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
                  {t(
                    'Invalid Link',
                    '\u0631\u0627\u0628\u0637 \u063a\u064a\u0631 \u0635\u0627\u0644\u062d'
                  )}
                </h1>
                <p className="mt-2 text-muted-foreground">{errorMessage}</p>
                <div className="mt-8 flex flex-col gap-3">
                  <Link
                    href={storeUrl('/auth/login')}
                    className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-6 py-3 font-medium text-white hover:bg-primary/90 transition"
                  >
                    {t(
                      'Go to Login',
                      '\u0627\u0644\u0630\u0647\u0627\u0628 \u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
                    )}
                  </Link>
                  <Link
                    href={storeUrl('/')}
                    className="inline-flex w-full items-center justify-center rounded-lg border border-border px-6 py-3 font-medium text-foreground hover:bg-muted transition"
                  >
                    {t(
                      'Back to Home',
                      '\u0627\u0644\u0639\u0648\u062f\u0629 \u0644\u0644\u0631\u0626\u064a\u0633\u064a\u0629'
                    )}
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </MinimalChrome>
  );
}
