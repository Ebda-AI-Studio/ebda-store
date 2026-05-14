/**
 * Sentry — Next.js server runtime (Node).
 *
 * Captures SSR errors, server component errors, generateMetadata
 * throws, route-handler errors. Distinct from the API service's
 * Sentry (apps/api) — this one is scoped to apps/web's Node side.
 * Frontend SSR throws were invisible before this was wired.
 *
 * Same no-op-when-DSN-missing behaviour as the client config.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN_WEB;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  });
}
