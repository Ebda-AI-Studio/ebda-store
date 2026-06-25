/**
 * Next.js instrumentation hook for the admin app's Sentry wiring.
 * Loads the runtime-appropriate config (server vs edge). Client
 * config is bundled separately via instrumentation-client.ts.
 *
 * NOTE (Cloudflare): scripts/cf-build.sh moves THIS file aside for the
 * OpenNext build, so SSR-side Sentry is inactive on the Cloudflare Workers
 * target (needs @sentry/cloudflare — follow-up). Vercel is unaffected.
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
