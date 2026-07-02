const path = require('path');
const { withSentryConfig } = require('@sentry/nextjs');

// Cloudflare/OpenNext build target detection. Set OPEN_NEXT_CLOUDFLARE=1 in the
// Cloudflare build; CF_PAGES is auto-set by Cloudflare Pages. Default (Vercel/
// local) is false, so the Vercel deploy is unaffected by the dual-target tweaks
// below.
const IS_CLOUDFLARE = !!process.env.OPEN_NEXT_CLOUDFLARE || !!process.env.CF_PAGES;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
        hostname: 'cdn.forcemediakw.com',
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
          // blocked admin.forcemediakw.com → wadyaljuz.com framing even
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
              // OneSignal v16 SDK loads from cdn.onesignal.com and at runtime
              // pulls additional scripts (jsonp sync) from api.onesignal.com.
              // 'unsafe-eval' is required by the v16 page SDK's runtime
              // (documented at https://documentation.onesignal.com/docs/web-push-csp).
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://connect.facebook.net https://analytics.tiktok.com https://sc-static.net https://static.ads-twitter.com https://s.pinimg.com https://vercel.live https://cdn.onesignal.com https://*.onesignal.com https://us-assets.i.posthog.com https://us.i.posthog.com https://static.cloudflareinsights.com",
              // OneSignal v16 page SDK pulls a stylesheet from
              // https://onesignal.com/sdks/... at runtime — that's the
              // bare apex, not cdn., so include it explicitly.
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com https://onesignal.com https://*.onesignal.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: https: blob:",
              // OneSignal subscriptions + websocket telemetry: *.onesignal.com.
              // forcemediakw.com is the marketing-site origin: storefront's
              // maintenance page + bare-root redirect can trigger a browser
              // preconnect to it.
              "connect-src 'self' https://store-api.forcemediakw.com https://api.force-ai.co https://api-production-c058.up.railway.app https://*.r2.dev https://*.google-analytics.com https://*.facebook.com https://*.tiktok.com wss://store-api.forcemediakw.com wss://api.force-ai.co wss://api-production-c058.up.railway.app https://fonts.googleapis.com https://fonts.gstatic.com https://vercel.live wss://vercel.live https://*.onesignal.com wss://*.onesignal.com https://forcemediakw.com https://us.i.posthog.com https://us-assets.i.posthog.com https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com",
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
              'frame-src https://vercel.live https://www.facebook.com https://td.doubleclick.net https://www.google.com https://maps.google.com https://google.com',
              // Allow framing from admin origins for the page-builder live
              // preview. Reads `STOREFRONT_FRAME_ANCESTORS` env var as a
              // space-separated allowlist; falls back to: platform admin
              // production domain + Vercel preview wildcards (force-admin
              // deploys + sharaf's-projects scope) + localhost dev. The
              // Vercel wildcards cover preview URLs which change per deploy
              // but are auth-gated by Vercel so framing them is safe.
              // Storefront is otherwise non-frameable so clickjacking via
              // other origins stays blocked.
              `frame-ancestors 'self' ${
                process.env.STOREFRONT_FRAME_ANCESTORS ??
                // admin.force-ai.co is the Cloudflare admin host — without it
                // the page-builder live-preview iframe is CSP-blocked on CF
                // (the storefront refuses to be framed). Kept alongside the
                // legacy app.forcemediakw.com (Vercel admin) during cutover.
                'https://admin.force-ai.co https://app.forcemediakw.com https://*.vercel.app http://localhost:3001 http://localhost:3000'
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
// @sentry/bundler-plugin-core's `!options.authToken` guard. That means local
// dev, CI (`ci.yml`'s `npm run build` step has no SENTRY_AUTH_TOKEN), and the
// Cloudflare Workers build (`cf-deploy.yml` doesn't set it either) all build
// exactly as before: no source maps uploaded, no release created, zero risk of
// a new build failure. Set SENTRY_AUTH_TOKEN (+ optionally SENTRY_ORG /
// SENTRY_PROJECT) wherever you want uploads to actually happen (e.g. Vercel
// prod env) to get the benefit.
module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  telemetry: false,
});
