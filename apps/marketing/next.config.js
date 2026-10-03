const path = require('path');

// Monorepo root. MARKETING_ROOT overrides it only for sandboxes whose node_modules is a
// symlink to another checkout (Turbopack refuses symlinks leaving its root).
const ROOT = process.env.MARKETING_ROOT || path.join(__dirname, '../..');

/**
 * Ebda marketing site (ebda.app) — fully static export. No server runtime, so
 * there is nothing for OpenNext to wrap: Cloudflare serves `out/` straight from
 * Workers Static Assets (see wrangler.jsonc). `trailingSlash` keeps every route
 * an `index.html` so `/en`, `/legal` etc. resolve without a worker.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  outputFileTracingRoot: ROOT,
  turbopack: { root: ROOT },
};

module.exports = nextConfig;
