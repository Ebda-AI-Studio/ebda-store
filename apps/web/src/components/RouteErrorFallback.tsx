'use client';

import { startTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLanguage } from '../contexts/LanguageContext';
import { useIsPlatform, useStoreUrl } from '../contexts/StoreContext';
import { isStoreTemporarilyUnavailable } from '../lib/store-unavailable';

interface RouteErrorFallbackProps {
  /**
   * The error the boundary caught. REQUIRED on purpose.
   *
   * The store-unavailable branch below is selected from `error.digest`, so a
   * boundary that drops the error silently downgrades a "we're busy, try
   * again" page into "something went wrong" — with no type error, no lint
   * error, and every resolver test still green. That is exactly how the retry
   * copy went missing on the PLP and PDP in the first draft of this fix.
   *
   * Making it required means `tsc` is the gate: a future boundary that fails
   * to forward the error cannot compile. All six storefront boundaries already
   * satisfy it, so this costs nothing at the call sites. (It was briefly
   * optional, justified by a caller that does not exist — grep returns only
   * the six boundaries and the barrel export.)
   * `tests/unit/web-error-boundaries-forward-error.test.ts` is defence in depth.
   */
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Shared body for storefront segment-level `error.tsx` boundaries (Lens M
 * graceful degradation). Mirrors the root `app/error.tsx` fallback, but is
 * meant to be rendered INSIDE a page's normal chrome (ShopChrome /
 * MinimalChrome) rather than replacing it — so a render error in one route
 * segment (PDP, PLP, cart, checkout) doesn't blank the header/nav/footer
 * for the rest of the storefront the way the single root error.tsx did.
 *
 * It owns BOTH error presentations so they cannot drift apart:
 *
 *  - the generic "something went wrong" body, and
 *  - the "we're a little busy" retry body, shown when the store itself could
 *    not be resolved for a TRANSIENT reason (a 429 from `storeResolveLimiter`,
 *    a 5xx, a dropped connection). That case used to render as a branded 404
 *    telling the shopper the shop does not exist — see
 *    `docs/plans/2026-09-16-store-resolve-transient-not-404.md`.
 *
 * Keeping the branch here rather than in each boundary is the platform-level
 * rule: the PLP, PDP and bundle PDP each have their own `error.tsx` and catch
 * BEFORE the root one, so a copy that lives only in `app/error.tsx` never
 * reaches the three routes a shopper is most likely to land on.
 */
export function RouteErrorFallback({ error, reset }: RouteErrorFallbackProps) {
  const { t } = useLanguage();
  const storeUrl = useStoreUrl();
  const isPlatform = useIsPlatform();
  const router = useRouter();

  /**
   * "Try Again" must actually retry.
   *
   * The `reset` Next hands this component is the BARE one. From Next's own
   * `client/components/error-boundary.js`, the boundary defines two:
   *
   *   this.reset = () => { this.setState({ error: null }); }
   *   this.retry = () => startTransition(() => { this.context?.refresh(); this.reset(); })
   *
   * ...and passes `reset: this.reset`. `reset` alone only clears client error
   * state, so the SAME failed server payload re-renders and the shopper sits on
   * the same page. That matters more here than anywhere else: on the transient
   * branch this button is the ONLY control (the "Go Home" link is suppressed
   * below), so without the refresh the retry page is a dead end during exactly
   * the outage it exists to survive. Mirrors Next's own `retry`.
   */
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  // `digest` is the only channel that survives to the client: Next replaces a
  // server error's MESSAGE with a generic string in production but forwards a
  // digest the thrower set itself.
  const isTemporarilyUnavailable = isStoreTemporarilyUnavailable(error);

  return (
    <div className="mx-auto flex min-h-[50vh] w-full max-w-2xl flex-col items-center justify-center px-4 py-16 text-center">
      {/* NO in-body `<meta name="robots">` here. An earlier draft rendered one
          and described it as the indexing guard; it was inert. Automatic
          hoisting of `<meta>` into `<head>` is a React 19 feature and this repo
          hard-pins react/react-dom to 18.3.1 in the root `overrides`, so the
          tag stayed in `<body>`, where Google ignores robots directives. The
          REAL guard is the HTTP status: a server-component throw makes Next
          return 500, which crawlers already treat as "try again later" and
          which — unlike the 404 this whole fix removes — does not deindex the
          store. Ruling SR-4. */}
      <div
        className={`mb-6 flex h-16 w-16 items-center justify-center rounded-full ${
          isTemporarilyUnavailable ? 'bg-muted' : 'bg-destructive/10'
        }`}
      >
        <svg
          className={`h-8 w-8 ${
            isTemporarilyUnavailable ? 'text-muted-foreground' : 'text-destructive'
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          // Decorative: the heading below carries the same busy-vs-broken
          // meaning in text, so the icon must not be announced separately.
          aria-hidden="true"
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

      {/* Plain wrapper. A `role="status"` lived here and claimed the swap was
          announced after a client-side navigation — unverified and probably
          false: a live region inserted TOGETHER with its content is generally
          not announced, and wrapping the <h2> in one can make the heading read
          as flat live-region text. The pattern that actually works is moving
          focus to the container, which needs a real screen-reader check this
          session could not run, so the claim is withdrawn rather than
          restated. Ruling SR-6. */}
      <div>
        <h2 className="mb-2 text-xl font-semibold text-foreground">
          {isTemporarilyUnavailable
            ? t('We’re a little busy right now', 'الموقع مزدحم قليلاً الآن')
            : t('Something went wrong', 'حدث خطأ ما')}
        </h2>
        <p className="mb-6 max-w-md text-sm text-muted-foreground">
          {isTemporarilyUnavailable
            ? t(
                'This store is getting more requests than usual, so it could not load. Please try again in a moment.',
                'يتلقى المتجر عددًا من الطلبات أكثر من المعتاد، لذلك تعذّر تحميله. يرجى المحاولة مرة أخرى بعد قليل.'
              )
            : t(
                'We hit a snag loading this page. Please try again or head back home.',
                'واجهنا مشكلة في تحميل هذه الصفحة. يرجى المحاولة مرة أخرى أو العودة للرئيسية.'
              )}
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={retry}
          className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('Try Again', 'حاول مرة أخرى')}
        </button>
        {/* "Go Home" is suppressed during a transient ONLY on a platform host.
            We do not know which store this is there — `getStore()` fell back
            to the demo sentinel — so `useStoreUrl` drops the `/<slug>` prefix
            and the link would resolve to bare `/`, which on the platform host
            is NOT the merchant's storefront: measured 2026-09-16,
            `https://store.force-ai.co/` answers `307 → https://force-ai.co`.
            That would walk a merchant's shopper off their store and onto the
            Force platform pitch — the HARD multi-tenant rule in
            `app/not-found.tsx`. Ruling SR-7.

            On a CUSTOM domain, bare `/` IS the merchant's own storefront home
            regardless of whether this particular request could resolve the
            store — there is no platform pitch to redirect to. Suppressing the
            link there too (the original SR-7 fix did, unconditionally) took
            away a working escape route from custom-domain merchants, who are
            the majority production configuration. Issue #1841 / CORRECTION to
            SR-7 in docs/RULINGS.md. */}
        {(!isTemporarilyUnavailable || !isPlatform) && (
          <Link
            href={storeUrl('/')}
            className="rounded-lg border border-border px-5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t('Go Home', 'العودة للرئيسية')}
          </Link>
        )}
      </div>
    </div>
  );
}
