'use client';

import { useLanguage } from '../contexts/LanguageContext';

interface SectionRetryNoticeProps {
  onRetry: () => void;
  /** Optional copy override — defaults to a generic "couldn't load" message. */
  message?: string;
  messageAr?: string;
  className?: string;
}

/**
 * Compact, non-intrusive "Couldn't load — Retry" affordance for storefront
 * sections that fetch their own data client-side (reviews, Frequently
 * Bought Together, You Might Also Like). Distinguishes a genuine fetch
 * failure from a legitimate empty state (Lens M graceful degradation) —
 * a 500 no longer silently renders identically to "nothing configured
 * yet". Styling mirrors the existing PLP error banner
 * (`apps/web/src/app/products/ProductsClient.tsx`).
 */
export function SectionRetryNotice({
  onRetry,
  message,
  messageAr,
  className = '',
}: SectionRetryNoticeProps) {
  const { t } = useLanguage();

  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm ${className}`}
    >
      <svg
        className="h-4 w-4 flex-shrink-0 text-destructive-ink"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <span className="flex-1 text-destructive-ink">
        {t(message ?? "Couldn't load this section.", messageAr ?? 'تعذّر تحميل هذا القسم.')}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded bg-destructive/20 px-3 py-1 text-xs font-medium text-destructive-ink hover:bg-destructive/30"
      >
        {t('Retry', 'إعادة المحاولة')}
      </button>
    </div>
  );
}
