/**
 * Sentry — Next.js edge runtime.
 *
 * Captures errors in middleware.ts + any edge route handlers. We
 * don't have many edge surfaces today but this keeps coverage
 * complete for future additions.
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
