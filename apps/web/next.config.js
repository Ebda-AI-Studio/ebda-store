/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // OneSignal v16 SDK loads from cdn.onesignal.com and at runtime
              // pulls additional scripts (jsonp sync) from api.onesignal.com.
              // 'unsafe-eval' is required by the v16 page SDK's runtime
              // (documented at https://documentation.onesignal.com/docs/web-push-csp).
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://connect.facebook.net https://analytics.tiktok.com https://sc-static.net https://static.ads-twitter.com https://s.pinimg.com https://vercel.live https://cdn.onesignal.com https://*.onesignal.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: https: blob:",
              // OneSignal subscriptions + websocket telemetry: *.onesignal.com.
              "connect-src 'self' https://api-production-c058.up.railway.app https://*.r2.dev https://*.google-analytics.com https://*.facebook.com https://*.tiktok.com wss://api-production-c058.up.railway.app https://fonts.googleapis.com https://fonts.gstatic.com https://vercel.live wss://vercel.live https://*.onesignal.com wss://*.onesignal.com",
              // Required so /OneSignalSDKWorker.js can register as a service
              // worker — Push API mandates same-origin worker scripts.
              "worker-src 'self' blob:",
              'frame-src https://vercel.live',
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
