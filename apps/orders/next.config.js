const path = require('path');
// `@sentry/nextjs/config`: the root-entry export is deprecated (removed in v11).
const { withSentryConfig } = require('@sentry/nextjs/config');

// Cloudflare/OpenNext build target detection (mirrors apps/web). Set
// OPEN_NEXT_CLOUDFLARE=1 in the Cloudflare build; CF_PAGES is auto-set by CF.
// Default (Vercel/local) is false, so the Vercel deploy is unaffected.
const IS_CLOUDFLARE = !!process.env.OPEN_NEXT_CLOUDFLARE || !!process.env.CF_PAGES;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ZAP 10037: don't advertise the framework (x-powered-by: Next.js).
  poweredByHeader: false,

  // Standalone output for containerized / Vercel deployment, matching apps/admin.
  output: 'standalone',

  // Next 16 + Turbopack: point the bundler at the monorepo root so it resolves
  // workspace-hoisted deps from the root node_modules.
  outputFileTracingRoot: path.join(__dirname, '../..'),

  transpilePackages: ['@force/shared'],

  // Product image thumbnails on the order detail page come from the same R2 /
  // CDN hosts the admin + storefront use. Mirror the admin's allowlist so
  // next/image can optimize them (CSP already permits https: img-src).
  images: {
    // Cloudflare build only: disable Next's sharp-based optimizer (native,
    // Workers-incompatible). On Vercel this stays false (zero regression).
    unoptimized: IS_CLOUDFLARE,
    remotePatterns: [
      ...(process.env.NODE_ENV !== 'production'
        ? [
            { protocol: 'http', hostname: 'localhost', port: '', pathname: '/**' },
            { protocol: 'http', hostname: 'localhost', port: '9000', pathname: '/**' },
          ]
        : []),
      { protocol: 'https', hostname: 'cdn.ebda.app', port: '', pathname: '/**' },
      { protocol: 'https', hostname: '*.supabase.co', port: '', pathname: '/storage/**' },
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: '*.r2.dev', port: '', pathname: '/**' },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  async headers() {
    return [
      {
        // Service worker must be served from the app origin with the right
        // scope. Keep it un-cached so SW updates roll out promptly.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          // Internal tool — never index.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
          {
            // OneSignal needs:
            //   script-src + 'unsafe-eval' → SDK runtime checks
            //   connect-src https://*.onesignal.com → REST + websocket
            //   worker-src 'self' blob: → /OneSignalSDKWorker.js importScripts the OneSignal CDN
            //   frame-src https://*.onesignal.com → SDK's permission-prompt iframe
            //   manifest-src 'self' → PWA install
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; " +
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.onesignal.com https://*.onesignal.com https://onesignal.com https://eu-assets.i.posthog.com https://eu.i.posthog.com https://static.cloudflareinsights.com; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com https://*.onesignal.com; " +
              "font-src 'self' data: https://fonts.gstatic.com; " +
              "img-src 'self' data: https: blob:; " +
              "connect-src 'self' https://api.ebda.app wss://api.ebda.app https://onesignal.com https://*.onesignal.com wss://*.onesignal.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com; " +
              'frame-src https://onesignal.com https://*.onesignal.com; ' +
              "worker-src 'self' blob:; " +
              "manifest-src 'self'; " +
              "frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

// Wraps the config with Sentry's build-time integration so source maps upload
// and a release is created, matching apps/web + apps/admin (audit 2026-07-02
// H1/H2). Same conservative behavior: the Sentry bundler plugin no-ops the
// upload (warns, doesn't fail the build) whenever SENTRY_AUTH_TOKEN is unset,
// and `errorHandler` turns a failed upload into a warning. cf-deploy.yml
// supplies the token when the repo secret exists. See apps/web/next.config.js
// for the full rationale.
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
