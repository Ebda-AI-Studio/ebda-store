import { nonceScriptSrc } from '@ebda/shared';

/**
 * The storefront's Content-Security-Policy, built per request in `middleware.ts` (Ruling CSP-WEB-1).
 *
 * It lives here, not in next.config.js, because a nonce differs on every request and `headers()` is
 * evaluated once at build time. `script-src` is `'self' 'nonce-<per request>' 'strict-dynamic'`: Next
 * stamps the nonce on its own bootstrap and flight-data scripts when the REQUEST carries the policy, the
 * root layout stamps the one inline script it owns, and anything those scripts load (merchant pixels,
 * OneSignal, PostHog) is trusted through `'strict-dynamic'`. The host list is only the fallback for a
 * browser without strict-dynamic. No `'unsafe-inline'` and no `'unsafe-eval'` for scripts.
 * Read docs/architecture/storefront-csp.md for the trade-off this accepted (HTML is no longer reusable).
 */

const SCRIPT_HOSTS = [
  'https://www.googletagmanager.com',
  // Google Ads (#1201): gtag.js with an AW- config loads its conversion runtime from these two.
  'https://www.googleadservices.com',
  'https://googleads.g.doubleclick.net',
  'https://connect.facebook.net',
  'https://analytics.tiktok.com',
  'https://sc-static.net',
  'https://static.ads-twitter.com',
  'https://s.pinimg.com',
  'https://cdn.onesignal.com',
  'https://*.onesignal.com',
  'https://us-assets.i.posthog.com',
  'https://us.i.posthog.com',
  'https://eu-assets.i.posthog.com',
  'https://eu.i.posthog.com',
  'https://static.cloudflareinsights.com',
] as const;

/** OneSignal's v16 page SDK needs eval per the vendor doc; it initialises without it (docs/architecture/admin-csp.md, SEC-4b). */
export const STOREFRONT_NEEDS_UNSAFE_EVAL = false;

/** The API origin the browser talks to, when it is not the production one already named in connect-src. */
function extraApiOrigins(): string {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_API_URL || 'https://api.ebda.app');
    if (u.origin === 'https://api.ebda.app') return '';
    return ` ${u.origin} ${u.origin.replace(/^http/, 'ws')}`;
  } catch {
    return '';
  }
}

/**
 * Who may frame the storefront (the visual builder's live preview). `STOREFRONT_FRAME_ANCESTORS` wins; the
 * production default carries no dev origin (S1-1, 2026-09-22 audit).
 */
function frameAncestors(): string {
  return (
    process.env.STOREFRONT_FRAME_ANCESTORS ??
    (process.env.NODE_ENV === 'production'
      ? 'https://store.ebda.app'
      : 'https://store.ebda.app http://localhost:3001 http://localhost:3000')
  );
}

export function buildStorefrontCsp(nonce: string): string {
  return [
    "default-src 'self'",
    // ZAP 10055 floor: base-uri, form-action and object-src have no default-src fallback. Checkout reaches
    // payment gateways via window.location redirects (never form POSTs), so form-action 'self' is safe.
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    nonceScriptSrc(nonce, { hosts: SCRIPT_HOSTS, unsafeEval: STOREFRONT_NEEDS_UNSAFE_EVAL }),
    // Inline event-handler attributes never run (React binds handlers in JS; no vendor snippet writes on* attributes).
    "script-src-attr 'none'",
    // OneSignal v16 page SDK pulls a stylesheet from the bare apex https://onesignal.com/sdks/.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com https://onesignal.com https://*.onesignal.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https: blob:",
    // Builder hero/section <video> files live in the R2 public bucket.
    "media-src 'self' https://*.r2.dev https://media.ebda.app blob:",
    // media.ebda.app: the PDP 3D viewer fetch()es the product's .glb from it. ebda.app: the maintenance page and
    // bare-root redirect can trigger a preconnect. The Google hosts are the Ads conversion beacons.
    "connect-src 'self' https://api.ebda.app https://*.r2.dev https://media.ebda.app https://*.google-analytics.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://www.google.com https://*.facebook.com https://*.tiktok.com wss://api.ebda.app https://fonts.googleapis.com https://fonts.gstatic.com https://*.onesignal.com wss://*.onesignal.com https://ebda.app https://us.i.posthog.com https://us-assets.i.posthog.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com" +
      extraApiOrigins(),
    // /OneSignalSDKWorker.js registers as a service worker: Push API mandates same-origin worker scripts.
    "worker-src 'self' blob:",
    // Meta Pixel's invisible iframe; the Locations page embeds a key-free Google Maps preview per branch.
    'frame-src https://www.facebook.com https://td.doubleclick.net https://www.google.com https://maps.google.com https://google.com',
    `frame-ancestors 'self' ${frameAncestors()}`,
  ].join('; ');
}
