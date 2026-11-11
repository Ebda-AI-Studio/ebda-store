// Local stand-in for the API's store resolver, for tests/load/store-resolve.js (Ruling RESOLVE-BULLETPROOF-1).
// It reproduces the 2026-11-10 incident conditions on purpose: ONE global 30/min bucket on /public/store/resolve
// (the storefront arriving as one client), plus CHAOS_PCT % random 503s on it. Five demo hosts resolve; every other
// host is a definitive 404. Every other API path answers an empty success so pages render.
// Usage: PORT=4100 CHAOS_PCT=10 node tests/load/resolve-mock-api.mjs
import http from 'node:http';

const PORT = Number(process.env.PORT || 4100);
const LIMIT = Number(process.env.RESOLVE_LIMIT_PER_MIN || 30);
const CHAOS = Number(process.env.CHAOS_PCT || 0);
const DEMO = [
  'storedemo',
  'storedemo-souq',
  'storedemo-jasmine',
  'storedemo-lamma',
  'storedemo-dahab',
];
const stats = { resolve: 0, ok: 0, notFound: 0, limited: 0, chaos: 0 };
let windowStart = Date.now();
let used = 0;

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__stats') return send(res, 200, stats);
    if (url.pathname.endsWith('/public/store/resolve')) {
      stats.resolve++;
      if (Date.now() - windowStart >= 60_000) ((windowStart = Date.now()), (used = 0));
      if (++used > LIMIT)
        return (
          stats.limited++,
          send(res, 429, { success: false, error: { code: 'RATE_LIMITED' } })
        );
      if (Math.random() * 100 < CHAOS) return (stats.chaos++, send(res, 503, { success: false }));
      const host = String(req.headers['x-store-domain'] || '').toLowerCase();
      const label = host.replace(/\.ebda\.app$/, '');
      if (!host.endsWith('.ebda.app') || !DEMO.includes(label))
        return (
          stats.notFound++,
          send(res, 404, { success: false, error: { code: 'STORE_NOT_FOUND' } })
        );
      stats.ok++;
      return send(res, 200, {
        success: true,
        data: {
          store: {
            id: `store-${label}`,
            name: label,
            slug: label,
            domain: null,
            status: 'active',
            template: 'qamar',
            theme: {},
            settings: {},
          },
          enabledFeatures: [],
          disabledCmsSlugs: [],
        },
      });
    }
    return send(res, 200, { success: true, data: [] });
  })
  .listen(PORT, () =>
    console.log(`resolve mock API on :${PORT} (limit ${LIMIT}/min, chaos ${CHAOS}%)`)
  );
