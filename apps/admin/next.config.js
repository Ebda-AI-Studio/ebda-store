/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@force/ui', '@force/shared'],
  images: {
    domains: ['localhost', 'cdn.forcemedia.com'],
    formats: ['image/avif', 'image/webp'],
  },
  experimental: {
    optimizePackageImports: ['@force/ui'],
  },
};

module.exports = nextConfig;
