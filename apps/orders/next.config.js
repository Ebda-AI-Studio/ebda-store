const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
    remotePatterns: [
      ...(process.env.NODE_ENV !== 'production'
        ? [
            { protocol: 'http', hostname: 'localhost', port: '', pathname: '/**' },
            { protocol: 'http', hostname: 'localhost', port: '9000', pathname: '/**' },
          ]
        : []),
      { protocol: 'https', hostname: 'cdn.forcemediakw.com', port: '', pathname: '/**' },
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
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline'; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src 'self' data: https://fonts.gstatic.com; " +
              "img-src 'self' data: https: blob:; " +
              "connect-src 'self' https://store-api.forcemediakw.com wss://store-api.forcemediakw.com https://*.up.railway.app wss://*.up.railway.app; " +
              "worker-src 'self' blob:; " +
              "manifest-src 'self'; " +
              "frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
