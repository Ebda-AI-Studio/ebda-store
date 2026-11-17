'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from './StoreLink';
import { useRouter } from 'next/navigation';
import { useLanguage, translations } from '../contexts/LanguageContext';
import { useStore, useIsPlatform, useStoreUrl } from '../contexts/StoreContext';
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
 *    `docs/plans/done/2026-09-16-store-resolve-transient-not-404.md`.
 *
 * Keeping the branch here rather than in each boundary is the platform-level
 * rule: the PLP, PDP and bundle PDP each have their own `error.tsx` and catch
 * BEFORE the root one, so a copy that lives only in `app/error.tsx` never
 * reaches the three routes a shopper is most likely to land on.
 */
/**
 * Should a segment boundary render the fallback WITHOUT its ShopChrome /
 * MinimalChrome? (#1843)
 *
 * Yes exactly when the store could not be resolved for a transient reason AND
 * the client is holding the unresolved sentinel (`id: 'demo'`). That sentinel
 * makes `useStoreUrl` drop the `/<slug>` prefix, so the chrome's logo and nav
 * would point at `/`, `/products`, ... on the platform host — and
 * `ebda.app/` 307s to the Ebda company site. Ruling SR-7
 * suppressed the fallback's own "Go Home" link for this reason; the chrome
 * around it emitted the same links. Without chrome the page matches the root
 * `app/error.tsx` boundary: the retry copy and "Try Again", nothing that can
 * walk the shopper off their store. When the store DID resolve (the layout
 * got it, the page's own fetch failed) the chrome's links are correct and it
 * stays.
 *
 * PLATFORM HOST ONLY (#2223). The sentinel's prefix-less links are wrong only
 * where bare `/` is not the merchant's store. On a CUSTOM domain `useStoreUrl`
 * never adds a prefix (`isPlatform && …` in StoreContext), so the chrome's
 * `/products`, logo and nav links there were always the merchant's own — the
 * same distinction the "Go Home" gate below draws (#1841 CORRECTION). Dropping
 * the chrome on a custom domain removed every working escape route from the
 * majority production configuration.
 */
export function useBareErrorFallback(error: Error & { digest?: string }): boolean {
  const { store } = useStore();
  const isPlatform = useIsPlatform();
  return isStoreTemporarilyUnavailable(error) && store.id === 'demo' && isPlatform;
}

/** Ignore Try Again clicks this soon after the previous one (#1842). */
const RETRY_COOLDOWN_MS = 2000;

/**
 * Longest the button stays disabled waiting for a refresh (#2130). The pending
 * flag of `useTransition` only clears when `router.refresh()` settles, and the
 * dependency that refresh waits on is by definition the API that just failed —
 * a hung refresh would latch the page's ONLY control (the bare platform-host
 * transient page has no chrome and no Go Home) in "Retrying…" forever. After
 * this long the button re-enables, and a click then does a full reload of the
 * CURRENT url, which stays on the merchant's host (SR-7 is not at risk) and
 * cannot be stuck behind the pending transition.
 */
export const RETRY_MAX_BUSY_MS = 8000;

export function RouteErrorFallback({ error, reset }: RouteErrorFallbackProps) {
  const { t } = useLanguage();
  const storeUrl = useStoreUrl();
  const isPlatform = useIsPlatform();
  const router = useRouter();
  const [isRetrying, startTransition] = useTransition();
  const lastRetryAt = useRef(0);
  // True from a click until RETRY_MAX_BUSY_MS later; the button is disabled
  // only while BOTH this and the transition are busy (#2130).
  const [retryBusy, setRetryBusy] = useState(false);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (busyTimer.current) clearTimeout(busyTimer.current);
    },
    []
  );
  const buttonBusy = isRetrying && retryBusy;

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
  //
  // Each click is a fresh server render that re-resolves the store against an
  // API which, on the transient branch, is by definition already busy (#1842).
  // So the button is disabled while the refresh is in flight (useTransition's
  // pending flag — the bare `startTransition` import had none, so a click gave
  // no feedback and invited repeats) and clicks within RETRY_COOLDOWN_MS of the
  // last are ignored.
  const retry = () => {
    const now = Date.now();
    if (buttonBusy || now - lastRetryAt.current < RETRY_COOLDOWN_MS) return;
    lastRetryAt.current = now;
    if (isRetrying) {
      // The previous soft refresh never settled (#2130) — a hard reload of the
      // current url is the one retry a hung transition cannot block.
      window.location.reload();
      return;
    }
    setRetryBusy(true);
    if (busyTimer.current) clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setRetryBusy(false), RETRY_MAX_BUSY_MS);
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

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
            isTemporarilyUnavailable ? 'text-muted-foreground' : 'text-destructive-ink'
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
            ? t('We’re a little busy right now', 'الموقع زحمة شوية دلوقتي')
            : t('Something went wrong', 'حدث خطأ ما')}
        </h2>
        <p className="mb-6 max-w-md text-sm text-muted-foreground">
          {isTemporarilyUnavailable
            ? t(
                'This store is getting more requests than usual, so it could not load. Please try again in a moment.',
                'المتجر جاله طلبات أكتر من العادي، فمعرفناش نحمّله. جرّب تاني بعد شوية.'
              )
            : t(
                'We hit a snag loading this page. Please try again or head back home.',
                'حصلت مشكلة واحنا بنحمّل الصفحة دي. جرّب تاني أو ارجع للرئيسية.'
              )}
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={retry}
          disabled={buttonBusy}
          aria-busy={buttonBusy}
          className="inline-flex min-h-11 items-center rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-70"
        >
          {buttonBusy ? t('Retrying…', translations['Retrying…']) : t('Try Again', 'جرّب تاني')}
        </button>
        {/* "Go Home" is suppressed during a transient ONLY on a platform host.
            We do not know which store this is there — `getStore()` fell back
            to the demo sentinel — so `useStoreUrl` drops the `/<slug>` prefix
            and the link would resolve to bare `/`, which on the platform host
            is NOT the merchant's storefront: measured 2026-09-16,
            `https://ebda.app/` answers `307 → https://ebda.app`.
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
            className="inline-flex min-h-11 items-center rounded-lg border border-input px-5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t('Go Home', 'العودة للرئيسية')}
          </Link>
        )}
      </div>
    </div>
  );
}
