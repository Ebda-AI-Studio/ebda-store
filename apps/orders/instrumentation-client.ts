/**
 * Sentry — Orders PWA client-side init.
 *
 * Next.js loads `instrumentation-client.ts` automatically into the browser
 * bundle (Next 15.3+ / Sentry SDK v9+). This is the canonical client hook —
 * mirrors `apps/web/instrumentation-client.ts` and `apps/admin/instrumentation-client.ts`.
 * Unlike `instrumentation.ts` (server), this file is NOT moved aside by
 * `scripts/cf-build.sh`, so it works under OpenNext on Cloudflare Workers too.
 *
 * Audit 2026-07-02 (H1): the Orders PWA — the surface store staff use to run
 * live fulfillment — previously shipped with ZERO Sentry coverage. A crash in
 * the fulfillment UI was invisible; it never reached the Sentry dashboard or
 * the Telegram bridge. This closes that gap for client-side errors.
 *
 * Orders is an operator-only tool (store staff, no public visitors), so we
 * run tracesSampleRate at 100% in production — small audience, every trace is
 * signal not noise. Session replay similarly always-on for error sessions.
 *
 * No-op when NEXT_PUBLIC_SENTRY_DSN_ORDERS is missing so local dev + preview
 * deploys without the env var still build and run cleanly.
 */
import * as Sentry from '@sentry/nextjs';
import { isHostInjectedScriptEvent, scrubSentryBreadcrumb, scrubSentryEvent } from '@ebda/shared';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN_ORDERS;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'NetworkError',
      'AbortError',
    ],
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'development',
    // Errors thrown inside a script the host app injected (Chrome for iOS),
    // not by our bundle — see @ebda/shared sentry-host-injected-filter.
    beforeSend(event) {
      const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
      return isHostInjectedScriptEvent(event, ua) ? null : scrubSentryEvent(event);
    },
    // Free-text query values (?search=, ?q=, ?email=, ?phone=) never leave in an event,
    // a transaction or a breadcrumb (@ebda/shared sentry-url-scrub).
    beforeSendTransaction: event => scrubSentryEvent(event),
    beforeBreadcrumb: breadcrumb => scrubSentryBreadcrumb(breadcrumb),
  });
}

// Next.js App Router navigation instrumentation. Safe to export even when
// Sentry is not initialised (the SDK no-ops).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
