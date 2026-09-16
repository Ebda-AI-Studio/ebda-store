'use client';

import Link from 'next/link';
import { useStoreUrl } from '../contexts/StoreContext';
import { STORE_UNAVAILABLE_DIGEST } from '../lib/store-unavailable';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const lang =
    typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);
  const storeUrl = useStoreUrl();

  // The store itself could not be resolved for a TRANSIENT reason — the API
  // was rate limiting us (429), unhealthy, or unreachable. Before this, that
  // case rendered the branded 404 and told the shopper the shop does not
  // exist. `digest` is the only channel that survives to the client: Next
  // replaces a server error's MESSAGE with a generic string in production but
  // forwards a digest the thrower set itself.
  const isTemporarilyUnavailable = error.digest === STORE_UNAVAILABLE_DIGEST;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      {/* A busy storefront is not content — never let it be indexed in place
          of the real store. Mirrors StoreMaintenance's noindex. */}
      {isTemporarilyUnavailable && <meta name="robots" content="noindex,nofollow" />}

      <div
        className={`mb-6 flex h-20 w-20 items-center justify-center rounded-full ${
          isTemporarilyUnavailable ? 'bg-muted' : 'bg-destructive/10'
        }`}
      >
        <svg
          className={`h-10 w-10 ${
            isTemporarilyUnavailable ? 'text-muted-foreground' : 'text-destructive'
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d={
              isTemporarilyUnavailable
                ? // Clock — "come back in a moment", not "something is broken".
                  'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z'
                : 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
            }
          />
        </svg>
      </div>
      <h2 className="mb-2 text-2xl font-semibold text-foreground">
        {isTemporarilyUnavailable
          ? t('We’re a little busy right now', 'الموقع مزدحم قليلاً الآن')
          : t('Something went wrong', 'حدث خطأ ما')}
      </h2>
      <p className="mb-8 max-w-md text-muted-foreground">
        {isTemporarilyUnavailable
          ? t(
              'This store is getting more requests than usual, so it could not load. Please try again in a moment.',
              'يتلقى المتجر عددًا من الطلبات أكثر من المعتاد، لذلك تعذّر تحميله. يرجى المحاولة مرة أخرى بعد قليل.'
            )
          : t(
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
