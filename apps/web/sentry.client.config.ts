/**
 * Sentry — client-side (browser) initialization.
 *
 * Captures: hydration errors, client-side route errors, uncaught
 * promise rejections, addEventListener errors. Does NOT capture
 * SSR errors (that's sentry.server.config.ts).
 *
 * No-op when NEXT_PUBLIC_SENTRY_DSN_WEB is missing so local dev +
 * preview deploys without the env var still build and run cleanly.
 *
 * GDPR / Kuwait Law 13/2023: Sentry runs as "legitimate interest"
 * for bug fixing. Default config sends NO PII (no IP, no body, no
 * cookies). This is distinct from PostHog which IS marketing
 * analytics and needs explicit consent.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN_WEB;

if (dsn) {
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
    // Filter out browser noise that doesn't actionable for us.
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
    ],
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'development',
  });
}
