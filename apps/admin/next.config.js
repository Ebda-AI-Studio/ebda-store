const path = require('path');
const createNextIntlPlugin = require('next-intl/plugin');
// `@sentry/nextjs/config`: the root-entry export is deprecated (removed in v11).
const { withSentryConfig } = require('@sentry/nextjs/config');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Cloudflare/OpenNext build target detection (mirrors apps/web). Set
// OPEN_NEXT_CLOUDFLARE=1 in the Cloudflare build; CF_PAGES is auto-set by CF.
// Default (Vercel/local) is false, so the Vercel deploy is unaffected.
const IS_CLOUDFLARE = !!process.env.OPEN_NEXT_CLOUDFLARE || !!process.env.CF_PAGES;

/** @type {import('next').NextConfig} */
/**
 * What the page-builder's live-preview iframe is allowed to embed.
 *
 * `frame-src` governs what the PARENT (admin) may embed; the storefront's own
 * `frame-ancestors` governs who may embed IT. Both must permit the embed, and
 * the storefront side already restricts framing to admin origins — that is
 * where the real protection lives.
 *
 * This used to be a hand-maintained list of merchant domains, which is why
 * `https://demo-shop.example` was sitting in it: one tenant was onboarded, someone
 * added their domain, and every merchant onboarded afterwards silently lost
 * their preview. Demo Store's page-builder showed Chrome's "This content is
 * blocked" for exactly that reason — `demo-store.example` was never added.
 *
 * `ADMIN_DEFAULT_FRAME_SRC` (env var; was `ADMIN_PREVIEW_FRAME_SRC` — renamed
 * 2026-09-25, #1675) was supposed to be the relief valve ("without a
 * deploy"), but it is read here, in next.config.js, which Next evaluates at
 * BUILD time — so it never could take effect without a rebuild, and it was
 * never set in any environment. The old name was also backwards: this value
 * feeds the CATCH-ALL rule below (every route EXCEPT the preview), not the
 * preview route itself — the preview route's frame-src is the hardcoded
 * `PREVIEW_PAGE_FRAME_SRC` a few lines down, unaffected by any env var.
 *
 * A merchant's custom domain is arbitrary and unknowable at build time, so the
 * allowlist cannot be enumerated. Rather than keep a list that is wrong the
 * moment the next merchant signs up, the preview route (and only that route)
 * permits any https origin; every other admin route keeps the strict list.
 */
const DEFAULT_FRAME_SRC =
  process.env.ADMIN_DEFAULT_FRAME_SRC ?? 'https://ebda.app https://*.ebda.app';

// Match the explicitly configured API, including isolated localhost previews.
const API_ORIGIN = new URL(process.env.NEXT_PUBLIC_API_URL || 'https://api.ebda.app');
if (
  API_ORIGIN.protocol !== 'https:' &&
  !(API_ORIGIN.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(API_ORIGIN.hostname))
) {
  throw new Error('NEXT_PUBLIC_API_URL must use HTTPS or a loopback development origin');
}
const API_CONNECT = `${API_ORIGIN.origin} ${API_ORIGIN.origin.replace(/^http/, 'ws')}`;

const CSP_PREFIX =
  "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.onesignal.com https://*.onesignal.com https://onesignal.com https://us-assets.i.posthog.com https://us.i.posthog.com https://eu-assets.i.posthog.com https://eu.i.posthog.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com https://onesignal.com https://*.onesignal.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' " +
  API_CONNECT +
  ' https://*.up.railway.app wss://*.up.railway.app https://onesignal.com https://*.onesignal.com wss://*.onesignal.com https://us.i.posthog.com https://us-assets.i.posthog.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://cloudflareinsights.com; frame-src https://onesignal.com https://*.onesignal.com ';
const CSP_SUFFIX = "; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'";

/**
 * The two `headers()` route patterns, named so
 * tests/unit/admin-page-builder-preview-csp.test.ts can compile these EXACT
 * strings with Next's own path-to-regexp and assert which real admin paths
 * each one matches — hand-relabelling the two rules 'page-builder'/'other'
 * in the test (the previous approach) never actually checks that this regex
 * routes the way the label assumes.
 */
const PAGE_BUILDER_PREVIEW_SOURCE = '/stores/:id/page-builder';
// Named capture group (`:path(...)`), not the unnamed `(...)` form this used
// to be. Verified at the level of what is SERVED (issues 2178/2189): the test
// compiles both sources with Next's own buildCustomRoute (the routes-manifest
// regex) and applies them the way OpenNext's router does on Workers — every
// admin path gets all seven security headers, values unaltered, and only the
// bare page-builder route gets the preview frame-src.
const ADMIN_CATCHALL_SOURCE = '/:path((?!stores/[^/]+/page-builder$).*)';

/**
 * The preview route accepts any https origin because a merchant's custom
 * domain cannot be enumerated at build time. This is not the control that
 * protects the storefront: the storefront's own `frame-ancestors` allows only
 * admin origins to frame it, and that check is unaffected by anything here.
 * `frame-ancestors 'none'` still stops the admin itself being framed.
 */
const PREVIEW_PAGE_FRAME_SRC = 'https:';

/**
 * The admin's security headers. `frameSrc` is the only thing that varies:
 * the page-builder preview must embed a merchant's own custom domain, which
 * is arbitrary and unknowable at build time (see DEFAULT_FRAME_SRC above).
 */
function securityHeaders(frameSrc) {
  return [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
    {
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains; preload',
    },
    {
      key: 'Content-Security-Policy',
      value: CSP_PREFIX + frameSrc + CSP_SUFFIX,
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
      // The live-preview route FIRST, and the catch-all below excludes it, so
      // exactly one CSP applies to any given path. Two matching rules with the
      // same header key would leave precedence to framework internals — the
      // kind of detail that silently changes on an upgrade.
      {
        source: PAGE_BUILDER_PREVIEW_SOURCE,
        headers: securityHeaders(PREVIEW_PAGE_FRAME_SRC),
      },
      {
        source: ADMIN_CATCHALL_SOURCE,
        headers: securityHeaders(DEFAULT_FRAME_SRC),
      },
    ];
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
