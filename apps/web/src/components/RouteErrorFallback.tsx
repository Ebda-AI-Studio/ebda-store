'use client';

import Link from 'next/link';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreUrl } from '../contexts/StoreContext';

interface RouteErrorFallbackProps {
  reset: () => void;
}

/**
 * Shared body for storefront segment-level `error.tsx` boundaries (Lens M
 * graceful degradation). Mirrors the root `app/error.tsx` fallback, but is
 * meant to be rendered INSIDE a page's normal chrome (ShopChrome /
 * MinimalChrome) rather than replacing it — so a render error in one route
 * segment (PDP, PLP, cart, checkout) doesn't blank the header/nav/footer
 * for the rest of the storefront the way the single root error.tsx did.
 */
export function RouteErrorFallback({ reset }: RouteErrorFallbackProps) {
  const { t } = useLanguage();
  const storeUrl = useStoreUrl();

  return (
    <div className="mx-auto flex min-h-[50vh] w-full max-w-2xl flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
        <svg
          className="h-8 w-8 text-destructive"
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
      <h2 className="mb-2 text-xl font-semibold text-foreground">
        {t('Something went wrong', 'حدث خطأ ما')}
      </h2>
      <p className="mb-6 max-w-md text-sm text-muted-foreground">
        {t(
          'We hit a snag loading this page. Please try again or head back home.',
          'واجهنا مشكلة في تحميل هذه الصفحة. يرجى المحاولة مرة أخرى أو العودة للرئيسية.'
        )}
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('Try Again', 'حاول مرة أخرى')}
        </button>
        <Link
          href={storeUrl('/')}
          className="rounded-lg border border-border px-5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t('Go Home', 'العودة للرئيسية')}
        </Link>
      </div>
    </div>
  );
}
