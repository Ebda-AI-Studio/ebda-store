import { nonceScriptSrc } from '@ebda/shared';

/**
 * The admin's Content-Security-Policy (SEC-4 / M-067), built per request in middleware.ts.
 *
 * It lives here, not in next.config.js, because a nonce differs on every request and
 * `headers()` is evaluated once at build time. `script-src` is nonce + 'strict-dynamic': Next
 * stamps the nonce on its own scripts when the request carries it, and anything those scripts
 * load (PostHog; the OneSignal SDK after the opt-in click) is trusted through them. No 'unsafe-inline' for scripts.
 *
 * The ad / pixel hosts (connect.facebook.net, www.facebook.com) are NOT here: the admin never
 * loads a marketing pixel (those run on storefronts).
 */

/** `/stores/:id/builder`: the visual builder frames the merchant's storefront, any custom domain. */
export const BUILDER_PREVIEW_PATH = /^\/stores\/[^/]+\/builder$/;
const PREVIEW_FRAME_SRC = 'https:';

/**
 * The admin is an SPA: the CSP of the document the browser FIRST loaded governs every client-side navigation after it.
 * Arriving at the builder through a `<Link>` from any other admin page therefore keeps that page's narrow `frame-src`
 * (`*.ebda.app`), and Chrome blocks the preview iframe of a CUSTOM-DOMAIN store ("This content is blocked").
 * True when the document that loaded was not itself the builder route, so the builder must hard-reload once to get
 * the builder's CSP. After the reload the document IS the builder, so this cannot loop.
 */
export function builderNeedsDocumentReload(
  loadedDocumentUrl: string | undefined,
  base: string
): boolean {
  if (!loadedDocumentUrl) return false;
  try {
    return !BUILDER_PREVIEW_PATH.test(new URL(loadedDocumentUrl, base).pathname);
  } catch {
    return false;
  }
}

/**
 * OneSignal opt-in (audit G-1, 2026-11-03; widened after the pre-push review): the SDK is lazy-loaded ONLY by an explicit
 * "enable order alerts" click, but that click lives on the dashboard card, Settings -> Notifications and My devices, and the
 * admin is a single-page app: the CSP of the FIRST page loaded applies to every client-side navigation after it. A per-route
 * allowance therefore blocks the SDK for anyone who landed elsewhere. `script-src` uses 'strict-dynamic', which makes script
 * host lists moot, so only connect-src, frame-src and style-src gate the SDK and they carry the OneSignal hosts on every route.
 * The script nonce model is unchanged: the SDK is still never loaded without the click (tests/unit/admin-no-onesignal.test.ts).
 */
const PUSH_HTTP_HOSTS = 'https://onesignal.com https://*.onesignal.com';
const PUSH_STYLE_HOSTS = 'https://cdn.onesignal.com https://onesignal.com https://*.onesignal.com';
const PUSH_CONNECT_HOSTS = `${PUSH_HTTP_HOSTS} wss://*.onesignal.com`;

const SCRIPT_HOSTS = [
  'https://eu-assets.i.posthog.com',
  'https://eu.i.posthog.com',
  'https://static.cloudflareinsights.com',
] as const;

/** Not needed even by the opt-in push SDK; see docs/architecture/admin-csp.md. */
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
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    nonceScriptSrc(nonce, { hosts: SCRIPT_HOSTS, unsafeEval: ADMIN_NEEDS_UNSAFE_EVAL }),
    // Inline event-handler attributes never run (React binds handlers in JS).
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${PUSH_STYLE_HOSTS}`,
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "media-src 'self' https://*.r2.dev https://media.ebda.app blob:",
    `connect-src 'self' ${api} ${accounts} https://media.ebda.app ${PUSH_CONNECT_HOSTS} https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com`,
    `frame-src ${PUSH_HTTP_HOSTS} ${framesForRoute}`,
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
