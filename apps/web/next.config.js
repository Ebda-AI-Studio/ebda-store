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

  transpilePackages: ['@ebda/ui', '@ebda/shared'],

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
    optimizePackageImports: ['@ebda/shared', '@ebda/ui'],
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
          // blocked store.ebda.app → demo-shop.example framing even
          // though CSP frame-ancestors allowed it. CSP frame-ancestors below
          // is the canonical gate. Modern browsers ignore the absence of
          // X-Frame-Options; legacy browsers (IE) just allow framing.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value:
              'geolocation=(), microphone=(), camera=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          // Content-Security-Policy is NOT here: it carries a per-request nonce, so apps/web/middleware.ts
          // builds it per request from src/lib/csp.ts (Ruling CSP-WEB-1). `headers()` is evaluated once at build time.
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
