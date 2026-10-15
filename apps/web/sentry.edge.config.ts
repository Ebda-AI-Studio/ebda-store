/**
 * Sentry — Next.js edge runtime.
 *
 * Captures errors in middleware.ts + any edge route handlers. We
 * don't have many edge surfaces today but this keeps coverage
 * complete for future additions.
 */
import * as Sentry from '@sentry/nextjs';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@ebda/shared';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN_WEB;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    // Free-text query values (?search=, ?q=, ?email=, ?phone=) never leave in an event,
    // a transaction or a breadcrumb (@ebda/shared sentry-url-scrub).
    beforeSend: event => scrubSentryEvent(event),
    beforeSendTransaction: event => scrubSentryEvent(event),
    beforeBreadcrumb: breadcrumb => scrubSentryBreadcrumb(breadcrumb),
  });
}
