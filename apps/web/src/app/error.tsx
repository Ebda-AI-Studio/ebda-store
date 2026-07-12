'use client';

import Link from 'next/link';
import { useStoreUrl } from '../contexts/StoreContext';

export default function Error({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const lang =
    typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);
  const storeUrl = useStoreUrl();

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
        <svg
          className="h-10 w-10 text-destructive"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <h2 className="mb-2 text-2xl font-semibold text-foreground">
        {t('Something went wrong', 'حدث خطأ ما')}
      </h2>
      <p className="mb-8 max-w-md text-muted-foreground">
        {t(
          'We encountered an unexpected error. Please try again or return to the home page.',
          'واجهنا خطأ غير متوقع. يرجى المحاولة مرة أخرى أو العودة إلى الصفحة الرئيسية.'
        )}
      </p>
      <div className="flex gap-4">
        <button
          onClick={reset}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('Try Again', 'حاول مرة أخرى')}
        </button>
        <Link
          href={storeUrl('/')}
          className="rounded-lg border border-border px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t('Go Home', 'العودة للرئيسية')}
        </Link>
      </div>
    </div>
  );
}
