const path = require('path');
const createNextIntlPlugin = require('next-intl/plugin');
// `@sentry/nextjs/config`: the root-entry export is deprecated (removed in v11).
const { withSentryConfig } = require('@sentry/nextjs/config');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const { trustRedirects } = require('./trust-redirects');

// Cloudflare/OpenNext build target detection (mirrors apps/web). Set
// OPEN_NEXT_CLOUDFLARE=1 in the Cloudflare build; CF_PAGES is auto-set by CF.
// Default (Vercel/local) is false, so the Vercel deploy is unaffected.
const IS_CLOUDFLARE = !!process.env.OPEN_NEXT_CLOUDFLARE || !!process.env.CF_PAGES;

/** @type {import('next').NextConfig} */
/**
 * The admin's Content-Security-Policy is NOT set here any more (SEC-4 / M-067): it carries a
 * per-request nonce, so it is built in src/middleware.ts from src/lib/csp.ts (which also holds the
 * live-preview `frame-src` rule for /stores/:id/builder). `headers()` below is evaluated once at
 * build time and cannot mint a nonce. Everything else stays here.
 */
function securityHeaders() {
  return [
    { key: 'X-Frame-Options', value: 'DENY' },
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
    // The admin is an internal merchant dashboard, never to be indexed.
    // Belt-and-suspenders with public/robots.txt and layout.tsx's `robots`
    // metadata (see their comments) — those two assumed this header existed;
    // it never did, so a crawler that honours X-Robots-Tag over the other two
    // layers saw no signal at all.
    {
      key: 'X-Robots-Tag',
      value: 'noindex, nofollow, noarchive, nosnippet, noimageindex',
    },
  ];
}

const nextConfig = {
  reactStrictMode: true,
  // ZAP 10037: don't advertise the framework (x-powered-by: Next.js).
  poweredByHeader: false,

  // Enable standalone output for containerized deployment
  output: 'standalone',

  // Next 16 + Turbopack default: tell the bundler the monorepo root so it
  // walks up to root node_modules for workspace-hoisted deps. Without this,
  // hoisted workspace deps fail to resolve on Vercel. Previous Webpack default
  // tolerated workspace-isolated resolution; Turbopack is stricter.
  outputFileTracingRoot: path.join(__dirname, '../..'),

  transpilePackages: ['@ebda/ui', '@ebda/shared'],

  images: {
    // Cloudflare build only: disable Next's sharp-based optimizer (native,
    // Workers-incompatible). On Vercel this stays false (zero regression).
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

  // 301 permanent redirects from old admin URLs that were renamed.
  // These protect bookmarks and any hardcoded links that predated the
  // page-builder consolidation (2026-05-19); the visual editor owns them since Ruling VE-6.
  async redirects() {
    return [
      // QA-TRUST-1: /legal /privacy /terms and /llms.txt are real URLs (one 308 hop to ebda.app)
      ...trustRedirects(),
      // `/admin` is a guessed alias (the admin app IS the root, and has no locale path prefix):
      // send it, and its /ar and /en spellings, to the dashboard instead of a 404.
      { source: '/admin', destination: '/', permanent: false },
      { source: '/:locale(ar|en)/admin', destination: '/', permanent: false },
      {
        source: '/stores/:id/layout',
        destination: '/stores/:id/builder',
        permanent: true,
      },
      {
        source: '/stores/:id/typography',
        destination: '/stores/:id/builder',
        permanent: true,
      },
      {
        source: '/stores/:id/dividers',
        destination: '/stores/:id/builder',
        permanent: true,
      },
      // The legacy in-Store WhatsApp bridge pages were deleted (Ruling WA-LEGACY-1);
      // old bookmarks land on Settings. `/integrations/*` only ever held that bridge page.
      ...[
        '/stores/:id/whatsapp',
        '/stores/:id/wa-bot',
        '/stores/:id/wa-templates',
        '/stores/:id/wa-order-updates',
        '/stores/:id/payment-link',
        '/stores/:id/integrations/:path*',
      ].map(source => ({ source, destination: '/stores/:id/settings', permanent: true })),
    ];
  },

  // Security headers (the CSP is middleware's job, see above)
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
};

// Wraps the config with Sentry's build-time integration so source maps upload
// and a release is created (audit 2026-07-02 H2 — this was previously bare,
// so every Sentry issue arrived with minified/obfuscated stack traces). See
// apps/web/next.config.js for the full rationale (same pattern here) — the
// Sentry bundler plugin no-ops the upload (warns, doesn't fail the build)
// whenever SENTRY_AUTH_TOKEN is unset, and `errorHandler` turns a failed upload
// into a warning. cf-deploy.yml supplies the token when the repo secret exists.
module.exports = withSentryConfig(withNextIntl(nextConfig), {
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
