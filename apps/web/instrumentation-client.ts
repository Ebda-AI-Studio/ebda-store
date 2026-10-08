/**
 * Sentry — client-side (browser) initialization.
 *
 * Next.js loads `instrumentation-client.ts` automatically into the browser
 * bundle before the app's own code runs (Next 15.3+ / Sentry SDK v9+). This is
 * the canonical client hook and REPLACES the old `sentry.client.config.ts`
 * convention, which only worked when `next.config.js` was wrapped in
 * `withSentryConfig` — it was NOT here, so client Sentry silently never loaded
 * (on Vercel OR Cloudflare). Moving the init into this file fixes that latent
 * gap on every deploy target, and — unlike `instrumentation.ts` (server) — this
 * file is NOT moved aside by `scripts/cf-build.sh`, so it works under OpenNext
 * on Cloudflare Workers too.
 *
 * Captures: hydration errors, client-side route errors, uncaught promise
 * rejections, addEventListener errors. Does NOT capture SSR errors (that's
 * sentry.server.config.ts, loaded via instrumentation.ts on server targets).
 *
 * No-op when NEXT_PUBLIC_SENTRY_DSN_WEB is missing so local dev + preview
 * deploys without the env var still build and run cleanly.
 *
 * GDPR / applicable GCC data-protection law (see
 * docs/legal/gcc-data-protection.md): Sentry runs as "legitimate interest" for bug
 * fixing. Default config sends NO PII (no IP, no body, no cookies). This is
 * distinct from PostHog which IS marketing analytics and needs explicit consent.
 *
 * PERFORMANCE (docs/RULINGS.md PERF-STORE-2): the SDK is ~55 KB gzip and sat in
 * every page's first-load JS, competing with the LCP image for bandwidth. It is
 * now `import()`ed once the page is idle, on the first interaction, or on the
 * first error, whichever comes first. Until it loads, a ~0.3 KB buffer listens
 * for `error` / `unhandledrejection` and replays them into Sentry once it is
 * ready, so an early error is delayed, not lost. What changes: the pageload
 * tracing span (sampled at 10%) now starts when the SDK does, and an early
 * error carries no breadcrumbs from before the load.
 */
import { isHostInjectedScriptEvent } from '@force/shared';

type SentryModule = typeof import('@sentry/nextjs');

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN_WEB;

let sentry: SentryModule | null = null;
const earlyErrors: unknown[] = [];

function initSentry(Sentry: SentryModule): void {
  Sentry.init({
    dsn,
    // Adjust sample rates per env so production doesn't blow the free-tier
    // event quota on noise.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Session replay on errors only — never full-session capture (would
    // record customer behaviour without consent). 0% normal, 100% on
    // error means we get a replay only when something actually broke.
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    // Filter out browser noise that isn't actionable for us.
    ignoreErrors: [
      // browser-extension-injected errors
      'top.GLOBALS',
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      // network blips that the user retries
      'NetworkError',
      'Failed to fetch',
      // user-cancelled fetch requests (route navigation aborts)
      'AbortError',
      'The server took too long to respond',
      // EXPECTED business rejections surfaced from the API — these are 4xx
      // outcomes the customer sees inline (out of stock, rate limit, stale
      // cart line), NOT bugs. Logging them as Sentry errors floods alert
      // triage with non-actionable noise and buries real regressions.
      'Not enough inventory',
      'INSUFFICIENT_INVENTORY',
      'Too many cart operations',
      'Cart item not found',
      // In-app browser (Instagram/Facebook/Android WebView) bridge noise —
      // injected by the host app, not our code (we have no window.webkit /
      // JS-bridge usage). Non-actionable.
      'window.webkit',
      'messageHandlers',
      'Java object is gone',
      'Error invoking postMessage',
      // Third-party marketing-pixel bootstrap snippets (fbq/tiktok/snap/etc.)
      // do `getElementsByTagName('script')[0].parentNode.insertBefore(...)`,
      // which throws in host environments with no/parentless script tags.
      // Vendor code we can't patch; not our bug.
      "reading 'parentNode'",
    ],
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'development',
    // Errors thrown INSIDE a script the host app injected (Chrome for iOS's
    // WKUserScripts — FORCE-WEB-K/M/Q/N/P), not by our bundle. Narrow by
    // design: see @force/shared sentry-host-injected-filter for the evidence.
    beforeSend(event) {
      const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
      return isHostInjectedScriptEvent(event, ua) ? null : event;
    },
  });
}

if (dsn && typeof window !== 'undefined') {
  const onEarlyError = (e: ErrorEvent) => earlyErrors.push(e.error ?? e.message);
  const onEarlyRejection = (e: PromiseRejectionEvent) => earlyErrors.push(e.reason);
  const interactionEvents = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    window.removeEventListener('error', onEarlyError);
    window.removeEventListener('unhandledrejection', onEarlyRejection);
    for (const ev of interactionEvents) window.removeEventListener(ev, start);
    void import('@sentry/nextjs')
      .then(Sentry => {
        initSentry(Sentry);
        sentry = Sentry;
        for (const err of earlyErrors.splice(0)) Sentry.captureException(err);
      })
      .catch(() => {
        // Offline / blocked chunk: error reporting is best-effort.
      });
  };

  // An error means "load it now"; the error itself is replayed afterwards.
  window.addEventListener('error', e => {
    onEarlyError(e);
    start();
  });
  window.addEventListener('unhandledrejection', e => {
    onEarlyRejection(e);
    start();
  });
  for (const ev of interactionEvents)
    window.addEventListener(ev, start, { once: true, passive: true });
  const idle = () => {
    const ric = (
      window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }
    ).requestIdleCallback;
    if (ric) ric(start, { timeout: 4000 });
    else window.setTimeout(start, 2500);
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}

// Next.js App Router navigation instrumentation — lets Sentry tie client-side
// route transitions to their spans/errors. A no-op until the SDK has loaded
// (the first navigation almost always happens after an interaction, which
// triggers the load).
export const onRouterTransitionStart = (
  ...args: Parameters<SentryModule['captureRouterTransitionStart']>
) => sentry?.captureRouterTransitionStart(...args);
