/**
 * Sentry — admin client-side init.
 *
 * Next.js loads `instrumentation-client.ts` automatically into the browser
 * bundle (Next 15.3+ / Sentry SDK v9+). This is the canonical client hook and
 * REPLACES the old `sentry.client.config.ts` convention, which only loaded when
 * `next.config.js` was wrapped in `withSentryConfig` — it was NOT here, so admin
 * client Sentry silently never loaded (on Vercel OR Cloudflare). Moving the init
 * here fixes that on every target, and — unlike `instrumentation.ts` (server) —
 * this file is NOT moved aside by `scripts/cf-build.sh`, so it works under
 * OpenNext on Cloudflare Workers too.
 *
 * Admin is an operator-only tool (no public visitors), so we run
 * tracesSampleRate at 100% in production — small audience, every trace is signal
 * not noise. Session replay similarly always-on for error sessions to make
 * merchant-side bug reports trivial to reproduce.
 *
 * No-op when NEXT_PUBLIC_SENTRY_DSN_ADMIN is missing.
 */
import * as Sentry from '@sentry/nextjs';
import { isHostInjectedScriptEvent } from '@ebda/shared';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN_ADMIN;

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
      return isHostInjectedScriptEvent(event, ua) ? null : event;
    },
  });
}

// Next.js App Router navigation instrumentation. Safe to export even when Sentry
// is not initialised (the SDK no-ops).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
