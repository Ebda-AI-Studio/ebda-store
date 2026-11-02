import { nonceScriptSrc } from '@ebda/shared';

/**
 * The Orders PWA's Content-Security-Policy (SEC-4 / M-067), built per request in
 * src/middleware.ts so `script-src` can carry a nonce (next.config.js `headers()` runs once at
 * build time). nonce + 'strict-dynamic', no 'unsafe-inline' for scripts. No ad / pixel hosts.
 */
const SCRIPT_HOSTS = [
  'https://cdn.onesignal.com',
  'https://*.onesignal.com',
  'https://onesignal.com',
  'https://eu-assets.i.posthog.com',
  'https://eu.i.posthog.com',
  'https://static.cloudflareinsights.com',
] as const;

/** OneSignal's v16 page SDK needs eval at runtime (vendor CSP doc); see docs/architecture/admin-csp.md. */
export const ORDERS_NEEDS_UNSAFE_EVAL = false;

export function buildOrdersCsp(
  nonce: string,
  accounts: string = 'https://accounts.ebda.app'
): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    nonceScriptSrc(nonce, { hosts: SCRIPT_HOSTS, unsafeEval: ORDERS_NEEDS_UNSAFE_EVAL }),
    // S10: inline event-handler attributes never run (React binds handlers in JS).
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com https://*.onesignal.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    `connect-src 'self' https://api.ebda.app wss://api.ebda.app ${accounts} https://onesignal.com https://*.onesignal.com wss://*.onesignal.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com`,
    'frame-src https://onesignal.com https://*.onesignal.com',
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The identity service (accounts.ebda.app, Rulings ID-1/ID-2) the browser signs in against: `src/lib/accounts.ts`
 * fetches it with credentials, so connect-src MUST name its origin (Ruling CSP-ACCOUNTS-1; without it sign-in fails
 * with "Failed to fetch"). Exactly one origin, from the same env var the client reads; https or loopback only.
 */
export function accountsOrigin(raw: string | undefined): string {
  const u = new URL(raw || 'https://accounts.ebda.app');
  const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback) {
    throw new Error('NEXT_PUBLIC_ACCOUNTS_URL must use HTTPS or a loopback development origin');
  }
  return u.origin;
}
