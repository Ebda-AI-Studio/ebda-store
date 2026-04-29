const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Enable standalone output for containerized deployment
  output: 'standalone',

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
        hostname: 'cdn.forcemedia.com',
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
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          {
            // OneSignal needs:
            //   script-src + 'unsafe-eval' → SDK runtime checks
            //   connect-src https://*.onesignal.com → REST + websocket
            //   worker-src 'self' blob: → /OneSignalSDKWorker.js can importScripts the OneSignal CDN
            //   manifest-src 'self' → PWA install
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://vercel.live https://cdn.onesignal.com https://*.onesignal.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.onesignal.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' https://*.up.railway.app wss://*.up.railway.app https://*.supabase.co https://vercel.live wss://vercel.live https://onesignal.com https://*.onesignal.com wss://*.onesignal.com; frame-src https://vercel.live https://onesignal.com https://*.onesignal.com; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
