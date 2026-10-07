const path = require('path');
// `@sentry/nextjs/config`: the root-entry export is deprecated (removed in v11).
const { withSentryConfig } = require('@sentry/nextjs/config');

// Cloudflare/OpenNext build target detection. Set OPEN_NEXT_CLOUDFLARE=1 in the
// Cloudflare build; CF_PAGES is auto-set by Cloudflare Pages. Default (Vercel/
// local) is false, so the Vercel deploy is unaffected by the dual-target tweaks
// below.
const IS_CLOUDFLARE = !!process.env.OPEN_NEXT_CLOUDFLARE || !!process.env.CF_PAGES;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ZAP 10037: don't advertise the framework (x-powered-by: Next.js).
  poweredByHeader: false,

  // `sharp` is a native module. On Vercel/Node we mark it external so Next keeps
  // it as a runtime require from node_modules (unchanged behavior). On the
  // Cloudflare build we must NOT list it: `serverExternalPackages` makes
  // Turbopack emit an `[externals]_sharp` stub chunk (`require("sharp-<hash>")`)
  // that OpenNext's esbuild then can't resolve → build failure. The OG route's
  // sharp import is non-literal + runtime-gated off Workers (see
  // opengraph-image.tsx), so on Cloudflare sharp is never bundled or called.
  serverExternalPackages: IS_CLOUDFLARE ? [] : ['sharp'],

  // Next 16 + Turbopack default: monorepo-root file-tracing so the bundler
  // walks up to root node_modules for workspace-hoisted deps. Sister to
  // the same setting in apps/admin/next.config.js.
  outputFileTracingRoot: path.join(__dirname, '../..'),

  transpilePackages: ['@force/ui', '@force/shared'],

  images: {
    // Cloudflare build only: disable Next's sharp-based image optimizer (native,
    // Workers-incompatible). Storefront images come from R2 already backend-
    // resized, so there's no quality loss. On Vercel this stays false → Vercel's
    // image optimization is unchanged (zero regression).
    unoptimized: IS_CLOUDFLARE,
    remotePatterns: [
      // Only allow localhost image sources in non-production environments
      ...(process.env.NODE_ENV !== 'production'
        ? [
            {
              protocol: 'http',
              hostname: 'localhost',
              port: '',
              pathname: '/**',
            },
            {
              protocol: 'http',
              hostname: 'localhost',
              port: '9000',
              pathname: '/**',
            },
          ]
        : []),
      {
        protocol: 'https',
        hostname: 'cdn.ebda.app',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        port: '',
        pathname: '/storage/**',
      },
      {
        protocol: 'https',
        hostname: '*.r2.cloudflarestorage.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.r2.dev',
        port: '',
        pathname: '/**',
      },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  experimental: {
    optimizePackageImports: ['@force/shared', '@force/ui'],
  },

  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // X-Frame-Options REMOVED 2026-05-20 — Ahmad's live preview was
          // still showing "This content is blocked" because some browsers
          // (notably Safari and older Chrome variants) honor X-Frame-Options
          // OVER CSP frame-ancestors when both are present. SAMEORIGIN
          // blocked admin.ebda.app → demo-shop.example framing even
          // though CSP frame-ancestors allowed it. CSP frame-ancestors below
          // is the canonical gate. Modern browsers ignore the absence of
          // X-Frame-Options; legacy browsers (IE) just allow framing.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // ZAP 10055 (directives with no default-src fallback): base-uri,
              // form-action and object-src must be explicit. Checkout reaches
              // payment gateways via window.location redirects (never form
              // POSTs), so form-action 'self' is safe.
              "base-uri 'self'",
              "object-src 'none'",
              "form-action 'self'",
              // OneSignal v16 SDK loads from cdn.onesignal.com and at runtime
              // pulls additional scripts (jsonp sync) from api.onesignal.com.
              // 'unsafe-eval' is required by the v16 page SDK's runtime
              // (documented at https://documentation.onesignal.com/docs/web-push-csp).
              // Google Ads (#1201): gtag.js with an AW- config loads its
              // conversion runtime from www.googleadservices.com and
              // googleads.g.doubleclick.net; without them the Ads tag loads
              // and every conversion is silently CSP-blocked.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://connect.facebook.net https://analytics.tiktok.com https://sc-static.net https://static.ads-twitter.com https://s.pinimg.com https://cdn.onesignal.com https://*.onesignal.com https://us-assets.i.posthog.com https://us.i.posthog.com https://eu-assets.i.posthog.com https://eu.i.posthog.com https://static.cloudflareinsights.com",
              // OneSignal v16 page SDK pulls a stylesheet from
              // https://onesignal.com/sdks/... at runtime — that's the
              // bare apex, not cdn., so include it explicitly.
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com https://onesignal.com https://*.onesignal.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: https: blob:",
              // OneSignal subscriptions + websocket telemetry: *.onesignal.com.
              // ebda.app is the marketing-site origin: storefront's
              // maintenance page + bare-root redirect can trigger a browser
              // preconnect to it. googleadservices / googleads.g.doubleclick /
              // www.google.com: Google Ads conversion beacons (fetch/sendBeacon
              // transport), see script-src above.
              "connect-src 'self' https://api.ebda.app https://*.r2.dev https://*.google-analytics.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://www.google.com https://*.facebook.com https://*.tiktok.com wss://api.ebda.app wss://api-production-c058.up.railway.app https://fonts.googleapis.com https://fonts.gstatic.com https://*.onesignal.com wss://*.onesignal.com https://ebda.app https://us.i.posthog.com https://us-assets.i.posthog.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com",
              // Required so /OneSignalSDKWorker.js can register as a service
              // worker — Push API mandates same-origin worker scripts.
              "worker-src 'self' blob:",
              // Meta Pixel renders an invisible iframe to www.facebook.com
              // for cross-domain attribution — without this directive Chrome
              // blocks it and the pixel still fires the event API but loses
              // the cookie-bridge piece.
              // google.com + maps.google.com: the store Locations page embeds a
              // key-free Google Maps preview per branch via an <iframe> (see
              // mapsEmbedSrc()). Without these hosts Chrome blocks the frame
              // with "This content is blocked. Contact the site owner to fix
              // the issue." and the map renders as an empty/broken box.
              'frame-src https://www.facebook.com https://td.doubleclick.net https://www.google.com https://maps.google.com https://google.com',
              // Allow framing from admin origins for the page-builder live
              // preview. Reads `STOREFRONT_FRAME_ANCESTORS` env var as a
              // space-separated allowlist; falls back to: platform admin
              // production domain + localhost dev. Storefront is otherwise
              // non-frameable so clickjacking via other origins stays blocked.
              `frame-ancestors 'self' ${
                process.env.STOREFRONT_FRAME_ANCESTORS ??
                // admin.ebda.app is the Cloudflare admin host — without it
                // the page-builder live-preview iframe is CSP-blocked on CF
                // (the storefront refuses to be framed). Kept alongside the
                // (no legacy admin host in Ebda).
                //
                // S1-1 (2026-09-22 security audit): localhost:3000/3001 is
                // dev-server scope and does not belong in a PRODUCTION
                // header — STOREFRONT_FRAME_ANCESTORS is unset in every prod
                // config (verified: no wrangler.toml/.env.production.example
                // entry), so this fallback IS the live prod value. Only
                // include the dev origins when NOT building for production;
                // the prod value is unchanged otherwise (still 'self'
                // https://admin.ebda.app).
                (process.env.NODE_ENV === 'production'
                  ? 'https://admin.ebda.app'
                  : 'https://admin.ebda.app http://localhost:3001 http://localhost:3000')
              }`,
            ].join('; '),
          },
        ],
      },
    ];
  },
};

// Wraps the config with Sentry's build-time integration so source maps upload
// and a release is created (audit 2026-07-02 H2 — this was previously bare,
// so every Sentry issue arrived with minified/obfuscated stack traces).
//
// Conservative + reversible: the Sentry bundler plugin no-ops the upload (logs
// a warning, does NOT fail the build) whenever `authToken` is absent — see
// @sentry/bundler-plugin-core's `!options.authToken` guard — and `errorHandler`
// below downgrades a failed upload to a warning. Local dev and CI
// (`ci.yml`'s `npm run build` has no SENTRY_AUTH_TOKEN) build exactly as
// before. `cf-deploy.yml` passes SENTRY_AUTH_TOKEN (repo secret) +
// SENTRY_ORG / SENTRY_PROJECT (repo variables) into the OpenNext build, so
// production deploys upload the maps once the secret exists. The release name
// is the commit SHA (the plugin reads GITHUB_SHA in Actions), which is the
// same value it injects into the client bundle as the event `release`.
// Setup: docs/ENVIRONMENT.md "Sentry build-time config".
module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  telemetry: false,
  sourcemaps: {
    // Browser .map files are generated for the upload, then DELETED from
    // .next/static (and their sourceMappingURL comments stripped) before
    // OpenNext copies the assets, so they are never served publicly. This is
    // the SDK default for Turbopack builds; pinned here so a future SDK
    // default change cannot start publishing our source. Deletion runs with
    // or without an auth token.
    deleteSourcemapsAfterUpload: true,
  },
  // A failed release/upload (bad or expired token, Sentry outage) must never
  // fail a production deploy: warn and ship the build without symbolication.
  errorHandler: err => {
    console.warn('[sentry] source map upload failed, continuing the build:', err.message);
  },
});
