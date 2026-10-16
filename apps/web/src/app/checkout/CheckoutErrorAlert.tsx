'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * The checkout failure banner, rendered by `CheckoutClient` on BOTH steps.
 *
 * ## Why it lives here and not in PaymentStep
 *
 * It used to be inline in `PaymentStep`, which `CheckoutClient` renders only
 * inside `{step === 2 && …}`. Several error cases call `setStep(1)` and then
 * `setCheckoutError(...)` — which unmounts the only thing that could show the
 * message. The customer was returned to the shipping form with NO explanation,
 * and clicking "Continue to Payment" reproduced it forever: a silent infinite
 * bounce.
 *
 * `VALIDATION_ERROR` has had that shape all along. The
 * `PRODUCT_NO_LONGER_AVAILABLE` case added alongside this component would have
 * had it too — and that one fires routinely now that checkout refuses
 * soft-deleted products, so it would have been the common path, not an edge.
 *
 * Hoisting it is the class fix: any case may now `setStep(1)` and still be
 * seen.
 *
 * ## Scrolling
 *
 * The click that triggers a checkout failure is at the BOTTOM of step 2, and
 * this banner renders at the top — on a phone it is off-screen. Mirrors what
 * the `VALIDATION_ERROR` branch already does for field errors.
 */
export function CheckoutErrorAlert({
  message,
  onClear,
  action,
}: {
  message: string | null;
  onClear: () => void;
  /** Optional way out of the error (e.g. back to the cart). */
  action?: { href: string; label: string };
}) {
  const { t } = useLanguage();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!message) return;
    // `block: 'center'` rather than 'start': the sticky header would otherwise
    // cover the banner it just scrolled to.
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [message]);

  if (!message) return null;

  return (
    <div
      ref={ref}
      role="alert"
      className="mb-6 rounded-[var(--radius)] border border-destructive/30 bg-destructive/10 p-4"
    >
      <div className="flex items-start gap-3">
        <svg
          className="h-5 w-5 text-destructive-ink flex-shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-destructive-ink">
            {t('Checkout error', 'خطأ في الدفع')}
          </h3>
          <p className="mt-1 text-sm text-destructive-ink" dir="auto">
            {message}
          </p>
          {action && (
            <Link
              href={action.href}
              className="mt-2 inline-block text-sm font-medium text-destructive-ink underline"
            >
              {action.label}
            </Link>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label={t('Dismiss', 'إغلاق')}
          className="text-destructive-ink hover:text-destructive-ink/80"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
