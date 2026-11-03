import { nonceScriptSrc } from '@ebda/shared';

/**
 * The admin's Content-Security-Policy (SEC-4 / M-067), built per request in middleware.ts.
 *
 * It lives here, not in next.config.js, because a nonce differs on every request and
 * `headers()` is evaluated once at build time. `script-src` is nonce + 'strict-dynamic': Next
 * stamps the nonce on its own scripts when the request carries it, and anything those scripts
 * load (PostHog; the OneSignal SDK only on the opt-in routes below) is trusted through them. No 'unsafe-inline' for scripts.
 *
 * The ad / pixel hosts (connect.facebook.net, www.facebook.com) are NOT here: the admin never
 * loads a marketing pixel (those run on storefronts).
 */

/** `/stores/:id/builder`: the visual builder frames the merchant's storefront, any custom domain. */
export const BUILDER_PREVIEW_PATH = /^\/stores\/[^/]+\/builder$/;
const PREVIEW_FRAME_SRC = 'https:';

/**
 * The only routes that may load the OneSignal SDK: the explicit "enable order alerts on this device" buttons
 * (Settings -> Notifications, My devices). The SDK is lazy-loaded by that click and nowhere else; every other
 * admin route keeps a CSP with no onesignal host (audit G-1, 2026-11-03).
 */
export const PUSH_OPT_IN_PATH = /^(\/account\/devices|\/stores\/[^/]+\/notifications)$/;
const PUSH_SCRIPT_HOSTS = [
  'https://cdn.onesignal.com',
  'https://*.onesignal.com',
  'https://onesignal.com',
] as const;
const PUSH_HTTP_HOSTS = 'https://onesignal.com https://*.onesignal.com';

const SCRIPT_HOSTS = [
  'https://us-assets.i.posthog.com',
  'https://us.i.posthog.com',
  'https://eu-assets.i.posthog.com',
  'https://eu.i.posthog.com',
  'https://static.cloudflareinsights.com',
] as const;

/** Not needed even by the opt-in push SDK on its two routes; see docs/architecture/admin-csp.md. */
export const ADMIN_NEEDS_UNSAFE_EVAL = false;

export interface AdminCspInput {
  nonce: string;
  pathname: string;
  /** Origin of the API, e.g. https://api.ebda.app (NEXT_PUBLIC_API_URL). */
  apiOrigin: string;
  /** Origin of the identity service (NEXT_PUBLIC_ACCOUNTS_URL); defaults to https://accounts.ebda.app. */
  accountsOrigin?: string;
  /** frame-src for every route except the builder preview. */
  defaultFrameSrc?: string;
}

export function buildAdminCsp({
  nonce,
  pathname,
  apiOrigin,
  accountsOrigin: accounts = 'https://accounts.ebda.app',
  defaultFrameSrc = 'https://ebda.app https://*.ebda.app',
}: AdminCspInput): string {
  const api = `${apiOrigin} ${apiOrigin.replace(/^http/, 'ws')}`;
  const framesForRoute = BUILDER_PREVIEW_PATH.test(pathname) ? PREVIEW_FRAME_SRC : defaultFrameSrc;
  const push = PUSH_OPT_IN_PATH.test(pathname);
  const scriptHosts = push ? [...SCRIPT_HOSTS, ...PUSH_SCRIPT_HOSTS] : SCRIPT_HOSTS;
  const pushStyle = push
    ? ' https://cdn.onesignal.com https://onesignal.com https://*.onesignal.com'
    : '';
  const pushConnect = push ? ` ${PUSH_HTTP_HOSTS} wss://*.onesignal.com` : '';
  const pushFrame = push ? `${PUSH_HTTP_HOSTS} ` : '';
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    nonceScriptSrc(nonce, { hosts: scriptHosts, unsafeEval: ADMIN_NEEDS_UNSAFE_EVAL }),
    // Inline event-handler attributes never run (React binds handlers in JS).
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${pushStyle}`,
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "media-src 'self' https://*.r2.dev https://media.ebda.app blob:",
    `connect-src 'self' ${api} ${accounts} https://media.ebda.app${pushConnect} https://us.i.posthog.com https://us-assets.i.posthog.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com`,
    `frame-src ${pushFrame}${framesForRoute}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The API origin the admin talks to, validated the way next.config.js always did. */
export function adminApiOrigin(raw: string | undefined): string {
  const u = new URL(raw || 'https://api.ebda.app');
  const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback) {
    throw new Error('NEXT_PUBLIC_API_URL must use HTTPS or a loopback development origin');
  }
  return u.origin;
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
