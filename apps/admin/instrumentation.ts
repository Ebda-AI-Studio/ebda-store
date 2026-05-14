/**
 * Next.js instrumentation hook for the admin app's Sentry wiring.
 * Loads the runtime-appropriate config (server vs edge). Client
 * config is bundled separately via sentry.client.config.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export { captureRequestError as onRequestError } from '@sentry/nextjs';
