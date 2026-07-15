const path = require('path');
const createNextIntlPlugin = require('next-intl/plugin');
const { withSentryConfig } = require('@sentry/nextjs');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Cloudflare/OpenNext build target detection (mirrors apps/web). Set
// OPEN_NEXT_CLOUDFLARE=1 in the Cloudflare build; CF_PAGES is auto-set by CF.
// Default (Vercel/local) is false, so the Vercel deploy is unaffected.
const IS_CLOUDFLARE = !!process.env.OPEN_NEXT_CLOUDFLARE || !!process.env.CF_PAGES;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ZAP 10037: don't advertise the framework (x-powered-by: Next.js).
  poweredByHeader: false,

  // Enable standalone output for containerized deployment
  output: 'standalone',

  // Next 16 + Turbopack default: tell the bundler the monorepo root so it
  // walks up to root node_modules for workspace-hoisted deps. Without this,
  // `react-onesignal` (declared in apps/admin/package.json but hoisted to
  // root) fails to resolve on Vercel. Previous Webpack default tolerated
  // workspace-isolated resolution; Turbopack is stricter.
  outputFileTracingRoot: path.join(__dirname, '../..'),

  transpilePackages: ['@force/ui', '@force/shared'],

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

  // 301 permanent redirects from old admin URLs that were renamed.
  // These protect bookmarks and any hardcoded links that predated the
  // page-builder consolidation (2026-05-19).
  async redirects() {
    return [
      {
        source: '/stores/:id/layout',
        destination: '/stores/:id/page-builder',
        permanent: true,
      },
      {
        source: '/stores/:id/typography',
        destination: '/stores/:id/page-builder',
        permanent: true,
      },
      {
        source: '/stores/:id/dividers',
        destination: '/stores/:id/page-builder',
        permanent: true,
      },
    ];
  },

  // Security headers
  async headers() {
    return [
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
          // Hard block all search engines at the HTTP-header layer too.
          // Some crawlers honour the header even when robots.txt or the
          // <meta> tag is overlooked (e.g. when the page is reached via
          // a direct link from an indexed third-party site).
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
          {
            // OneSignal needs:
            //   script-src + 'unsafe-eval' → SDK runtime checks
            //   connect-src https://*.onesignal.com → REST + websocket
            //   worker-src 'self' blob: → /OneSignalSDKWorker.js can importScripts the OneSignal CDN
            //   manifest-src 'self' → PWA install
            //
            // frame-src 2026-05-20: page-builder embeds the storefront as a
            // live-preview iframe. Without storefront origins here, Chrome
            // blocks the iframe with "This content is blocked" — the parent's
            // CSP frame-src controls what URLs the PARENT can frame
            // (separate from the storefront's frame-ancestors, which controls
            // who can frame IT). Both must permit the embed for it to render.
            // ADMIN_PREVIEW_FRAME_SRC env var lets ops extend the allowlist
            // when new custom-domain tenants are onboarded without a deploy.
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.onesignal.com https://*.onesignal.com https://onesignal.com https://us-assets.i.posthog.com https://us.i.posthog.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com https://onesignal.com https://*.onesignal.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' https://store-api.forcemediakw.com https://api.force-ai.co wss://store-api.forcemediakw.com wss://api.force-ai.co https://*.up.railway.app wss://*.up.railway.app https://onesignal.com https://*.onesignal.com wss://*.onesignal.com https://us.i.posthog.com https://us-assets.i.posthog.com https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com; frame-src https://onesignal.com https://*.onesignal.com " +
              (process.env.ADMIN_PREVIEW_FRAME_SRC ??
                'https://store.force-ai.co https://*.force-ai.co https://store.forcemediakw.com https://*.forcemediakw.com https://wadyaljuz.com') +
              "; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

// Wraps the config with Sentry's build-time integration so source maps upload
// and a release is created (audit 2026-07-02 H2 — this was previously bare,
// so every Sentry issue arrived with minified/obfuscated stack traces). See
// apps/web/next.config.js for the full rationale (same pattern here) — the
// Sentry bundler plugin no-ops the upload (warns, doesn't fail the build)
// whenever SENTRY_AUTH_TOKEN is unset, so CI/local/Cloudflare builds are
// unaffected unless the token is explicitly configured.
module.exports = withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  telemetry: false,
});
