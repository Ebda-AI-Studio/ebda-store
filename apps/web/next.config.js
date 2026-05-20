const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Next 16 + Turbopack default: monorepo-root file-tracing so the bundler
  // walks up to root node_modules for workspace-hoisted deps. Sister to
  // the same setting in apps/admin/next.config.js.
  outputFileTracingRoot: path.join(__dirname, '../..'),

  transpilePackages: ['@force/ui', '@force/shared'],

  images: {
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
          // X-Frame-Options is the legacy header; modern browsers use CSP
          // frame-ancestors (below) which is stricter + per-source. Setting
          // to SAMEORIGIN so the admin page-builder live-preview iframe works
          // for own-origin admin domains. CSP `frame-ancestors` below is the
          // actual gate — DENY here would block CSP-allowed origins too.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
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
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://connect.facebook.net https://analytics.tiktok.com https://sc-static.net https://static.ads-twitter.com https://s.pinimg.com https://vercel.live https://cdn.onesignal.com https://*.onesignal.com https://us-assets.i.posthog.com https://us.i.posthog.com",
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
              "connect-src 'self' https://store-api.forcemediakw.com https://api-production-c058.up.railway.app https://*.r2.dev https://*.google-analytics.com https://*.facebook.com https://*.tiktok.com wss://store-api.forcemediakw.com wss://api-production-c058.up.railway.app https://fonts.googleapis.com https://fonts.gstatic.com https://vercel.live wss://vercel.live https://*.onesignal.com wss://*.onesignal.com https://forcemediakw.com https://us.i.posthog.com https://us-assets.i.posthog.com",
              // Required so /OneSignalSDKWorker.js can register as a service
              // worker — Push API mandates same-origin worker scripts.
              "worker-src 'self' blob:",
              // Meta Pixel renders an invisible iframe to www.facebook.com
              // for cross-domain attribution — without this directive Chrome
              // blocks it and the pixel still fires the event API but loses
              // the cookie-bridge piece.
              'frame-src https://vercel.live https://www.facebook.com https://td.doubleclick.net',
              // Allow framing from the admin domain (page-builder live preview)
              // + localhost for dev. Storefront is otherwise non-frameable so
              // clickjacking via other origins stays blocked.
              "frame-ancestors 'self' https://app.forcemediakw.com http://localhost:3001",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
