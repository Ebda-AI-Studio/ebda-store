/**
 * Next.js instrumentation hook. Runs once at server start, loads the
 * Sentry runtime-specific config so SSR / server component / route
 * handler errors get captured. The client config is bundled into the
 * browser build separately via sentry.client.config.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Forwards uncaught errors from React Server Components into Sentry's
// captureException — without this they'd log to stderr and disappear
// after Railway's 72h log retention.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
