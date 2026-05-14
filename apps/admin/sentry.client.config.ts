/**
 * Sentry — admin client-side init.
 *
 * Admin is an operator-only tool (no public visitors), so we run
 * tracesSampleRate at 100% in production — small audience, every
 * trace is signal not noise. Session replay similarly always-on
 * for error sessions to make merchant-side bug reports trivial
 * to reproduce.
 */
import * as Sentry from '@sentry/nextjs';

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
  });
}
