/**
 * Layout save must purge EVERY layer the storefront reads the page-builder layout through.
 *
 * Before: `PUT /stores/:id/layout` cleared only Redis `public:store:<id>`, while the storefront's
 * Next data-cache fetch of `GET /public/stores/:id/layout` was UNTAGGED with `revalidate: 60` — so a
 * saved layout stayed stale on the live storefront for 60s+ and could not be purged by tag at all.
 *
 * Now: (1) the PUT calls `bustStoreCaches` (Redis keys + generation bump + storefront purge),
 * (2) `bustStoreCaches` purges the `layout:<storeId>` tag, (3) every storefront layout fetch carries it.
 *
 * Mutation-proof: drop the bustStoreCaches call in the route, the `layout:` tag in the service, or the
 * tag on any storefront fetch -> the matching test below reddens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const m = vi.hoisted(() => ({
  bustStoreCaches: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  revalidateStorefront: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/r2-cleanup.service', () => ({
  cleanupRemovedJsonUrls: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/services/redis.service', () => ({ redis: { set: vi.fn(), get: vi.fn() } }));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: m.bustStoreCaches }));
// The legacy PUT also records a published builder revision (visual builder
// Phase 1); that path has its own integration test (apps/api/workers-test/page-builder.test.ts).
vi.mock('@api/services/page-builder.service', () => ({
  publishLegacyLayout: vi.fn().mockResolvedValue('ok'),
}));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, prisma: { store: { findUnique: m.findUnique, update: m.update } } };
});

import layoutRoutes from '@api/routes/store-layout.routes';
import { errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/stores/:storeId/layout', layoutRoutes);
  a.use(errorHandler);
  return a;
}

describe('PUT /stores/:storeId/layout purges the storefront caches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findUnique.mockResolvedValue({
      layoutSettings: {},
      template: 'qamar',
      slug: 'acme',
      domain: 'acme.example.com',
    });
    m.update.mockResolvedValue({ id: 'store-1' });
    m.bustStoreCaches.mockResolvedValue(undefined);
  });

  it('calls bustStoreCaches with the store id, slug and custom domain', async () => {
    const res = await request(app()).put('/stores/store-1/layout').send({});
    expect(res.status).toBe(200);
    expect(m.bustStoreCaches).toHaveBeenCalledTimes(1);
    expect(m.bustStoreCaches).toHaveBeenCalledWith('store-1', 'acme', 'acme.example.com');
  });

  it('still answers 200 when the purge rejects (the save already committed)', async () => {
    m.bustStoreCaches.mockRejectedValue(new Error('redis down'));
    const res = await request(app()).put('/stores/store-1/layout').send({});
    expect(res.status).toBe(200);
  });
});

describe('PUT /stores/:storeId/layout refuses the settings the visual editor owns (Ruling VE-15)', () => {
  it.each([
    ['productsPage', { bgColor: '#101010' }],
    ['productDetailPage', { density: 'compact' }],
    ['cartPage', { textScale: 'lg' }],
    ['checkoutPage', { density: 'compact' }],
    ['categoriesPage', { bgColor: '#101010' }],
    ['filterSidebar', { enabled: false, defaultOpen: true }],
    ['reviewSection', { enabled: true }],
  ])('%s is a 400, never silently dropped, and nothing is written', async (key, value) => {
    vi.clearAllMocks();
    const res = await request(app())
      .put('/stores/store-1/layout')
      .send({ [key]: value });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAGE_SETTINGS_MOVED');
    expect(res.body.error.details.keys).toEqual([key]);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.bustStoreCaches).not.toHaveBeenCalled();
  });

  it('a key the classic form still owns saves as before', async () => {
    vi.clearAllMocks();
    m.findUnique.mockResolvedValue({
      layoutSettings: {},
      template: 'qamar',
      slug: 'a',
      domain: null,
    });
    m.update.mockResolvedValue({ id: 'store-1' });
    const res = await request(app())
      .put('/stores/store-1/layout')
      .send({ bottomBar: { bgColor: '#101010' } });
    expect(res.status).toBe(200);
  });
});

describe('bustStoreCaches purges the layout tag on the storefront', () => {
  it('passes layout:<storeId> to revalidateStorefront', async () => {
    vi.resetModules();
    vi.doUnmock('@api/services/store.service');
    vi.doMock('@api/lib/revalidate-storefront', () => ({
      revalidateStorefront: m.revalidateStorefront,
    }));
    vi.doMock('@api/lib/public-cache', () => ({
      invalidateCached: vi.fn().mockResolvedValue(undefined),
      invalidateCachedPrefix: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@api/lib/cors-cache', () => ({ bustCorsCache: vi.fn() }));
    const { bustStoreCaches } = await import('@api/services/store.service');
    await bustStoreCaches('store-9', 'acme', 'acme.example.com');
    expect(m.revalidateStorefront).toHaveBeenCalledTimes(1);
    const arg = m.revalidateStorefront.mock.calls[0][0];
    expect(arg.tags).toContain('layout:store-9');
    expect(arg.slug).toBe('acme');
  });
});

describe('every storefront fetch of the public layout carries the layout:<storeId> tag', () => {
  const WEB_SRC = join(__dirname, '../../apps/web/src');
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
    }
    return out;
  }
  // A server-side cached (revalidate) fetch of the layout endpoint: either through
  // publicLayoutUrl() or an inline `/layout` URL, paired with `next: { revalidate`.
  const files = walk(WEB_SRC).filter(f => {
    const s = readFileSync(f, 'utf8');
    return (
      /publicLayoutUrl\(API_URL|stores\/\$\{[A-Za-z.]+\}\/layout`/.test(s) &&
      /next:\s*\{\s*revalidate/.test(s)
    );
  });

  it('finds the storefront layout fetchers (guards against the scan going blind)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map(f => [f.slice(WEB_SRC.length)]))('%s', rel => {
    const s = readFileSync(join(WEB_SRC, rel as string), 'utf8');
    expect(s).toMatch(/revalidate:\s*60,\s*tags:\s*\[`layout:\$\{[A-Za-z.]+\}`\]/);
  });
});
