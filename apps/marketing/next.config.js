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
  // Build-time copyright year (static export): identical in the server HTML and the hydrating client. See src/lib/copyright-year.ts.
  env: { NEXT_PUBLIC_COPYRIGHT_YEAR: String(new Date().getUTCFullYear()) },
  outputFileTracingRoot: ROOT,
  turbopack: { root: ROOT },
};

module.exports = nextConfig;
