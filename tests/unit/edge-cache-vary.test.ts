/**
 * setEdgeCache — Vary header correctness (audit-followup #1161, #1145, #1160).
 *
 * Two defects this locks down, both proven against the real express + cors
 * middleware stack (not a mock — the bug WAS in header-merge semantics):
 *
 * 1. CLOBBER: `res.setHeader('Vary', ...)` REPLACED the header, destroying
 *    the `Vary: Origin` the global `cors()` middleware appends whenever its
 *    `origin` option is a function (apps/api/src/index.ts:213). A caching
 *    edge would then store the first requester's
 *    `Access-Control-Allow-Origin` and replay it to browsers on every other
 *    merchant domain, breaking their storefront fetches until the entry
 *    expired. Fix: `res.vary()` (append/merge semantics).
 *
 * 2. MISSING DEFAULT TOKEN: tenancy on /public routes resolves via
 *    `getStoreIdFromRequest`, which falls back to `x-store-domain` when
 *    `x-store-id` is absent — and the storefront's feed proxy
 *    (apps/web/src/app/feeds/products.json/route.ts) sends ONLY
 *    `x-store-domain` for custom-domain merchants. A Vary of `x-store-id`
 *    alone keys those responses on an always-absent header: one merchant's
 *    payload would be served to every other custom-domain merchant for the
 *    whole s-maxage + SWR window. Fix: `x-store-domain` joins the default
 *    Vary set so every store-scoped response is keyed on both selectors.
 *
 * Relevant because api.ebda.app IS Cloudflare-proxied (verified live
 * 2026-09-02: `server: cloudflare`, `cf-ray` present; `cf-cache-status:
 * DYNAMIC` today, i.e. one cache-rule away from these headers being load-
 * bearing).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { setEdgeCache } from '../../apps/api/src/lib/edge-cache';

function parseVary(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

function buildApp(varyOn?: string[]) {
  const app = express();
  // Function-valued `origin` — mirrors apps/api/src/index.ts, and is what
  // makes the cors package append `Vary: Origin` to every response.
  app.use(cors({ origin: (_origin, callback) => callback(null, true) }));
  app.get('/cached', (_req, res) => {
    setEdgeCache(res, { sMaxAge: 60, staleWhileRevalidate: 300, varyOn });
    res.json({ ok: true });
  });
  return app;
}

describe('setEdgeCache Vary semantics', () => {
  it('preserves the Vary: Origin token appended by the cors middleware', async () => {
    const res = await request(buildApp())
      .get('/cached')
      .set('Origin', 'https://merchant-a.example');
    expect(res.status).toBe(200);
    const vary = parseVary(res.headers['vary']);
    expect(vary).toContain('origin');
    expect(vary).toContain('x-store-id');
  });

  it('varies on x-store-domain by default (domain-selected tenancy fallback)', async () => {
    const res = await request(buildApp()).get('/cached');
    const vary = parseVary(res.headers['vary']);
    expect(vary).toContain('x-store-domain');
    expect(vary).toContain('x-store-id');
  });

  it('appends caller-supplied varyOn tokens without dropping the defaults or duplicating', async () => {
    const res = await request(buildApp(['Accept-Language', 'x-store-domain']))
      .get('/cached')
      .set('Origin', 'https://merchant-a.example');
    const vary = parseVary(res.headers['vary']);
    expect(vary).toContain('accept-language');
    expect(vary).toContain('origin');
    expect(vary).toContain('x-store-id');
    // res.vary() dedupes case-insensitively — the explicit x-store-domain
    // passed here must not produce a second token.
    expect(vary.filter(t => t === 'x-store-domain')).toHaveLength(1);
    // Cache-Control contract unchanged by the Vary fix.
    expect(res.headers['cache-control']).toBe('public, s-maxage=60, stale-while-revalidate=300');
  });
});

/**
 * audit-followup #1269: the header comment used to claim "the moment a
 * cache rule is added, the Vary set below becomes load-bearing for tenant
 * isolation" — false for Cloudflare, which ignores Vary (other than
 * Accept-Encoding) outside its Enterprise-only Vary/image-caching features.
 * A future engineer adding a CF Cache Rule and trusting that claim would
 * ship a cross-tenant cache-key collision. Locked down as a source
 * assertion since the defect was in the doc comment itself, not runtime
 * behaviour.
 */
describe('edge-cache.ts doc comment does not overclaim Vary is load-bearing on Cloudflare', () => {
  const source = readFileSync(join(__dirname, '../../apps/api/src/lib/edge-cache.ts'), 'utf8');

  it('no longer claims a CF cache rule makes Vary load-bearing for tenant isolation', () => {
    expect(source).not.toMatch(/the Vary set below becomes load-bearing for tenant isolation/);
  });

  it('explains that Cloudflare ignores Vary outside its Enterprise-only feature', () => {
    expect(source).toMatch(/NOT load-bearing on Cloudflare/);
    expect(source).toMatch(/key the cache/);
    expect(source).toMatch(/store id/);
  });
});
