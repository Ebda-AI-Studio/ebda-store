import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN_ADMIN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 1.0,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  });
}
