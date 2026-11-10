/**
 * Publishing a page document must purge EVERY cache layer the storefront
 * reads it through, after the commit; saving a draft must purge NOTHING
 * public (drafts are never served).
 *
 * The purge is `bustStoreCaches(storeId, slug, domain)` (Redis
 * `public:store:*` id/slug/host/domain keys + generation bump, categories,
 * products prefix, CORS cache, and the storefront Next data cache through the
 * `layout:<storeId>` tag — that half is pinned by
 * layout-save-purges-storefront-cache.test.ts), queued with
 * `deferAfterTenantCommit` so a reader cannot re-cache the pre-commit value.
 *
 * Mutation-proof: delete the `purgePublishedCaches` call in
 * `applyPublishedLayout`, or the `bustStoreCaches` call inside it, or the
 * deferral -> a test below reddens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

const DOC = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));

const m = vi.hoisted(() => ({
  bustStoreCaches: vi.fn(),
  defer: vi.fn(),
  store: { findUnique: vi.fn(), update: vi.fn() },
  rev: {
    findFirst: vi.fn(),
    aggregate: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock('@api/services/store.service', () => ({ bustStoreCaches: m.bustStoreCaches }));
vi.mock('@api/services/r2-cleanup.service', () => ({
  cleanupRemovedJsonUrls: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (name: string, run: () => Promise<unknown>) => {
    m.defer(name);
    return run();
  },
}));
vi.mock('@api/lib/savepoint', () => ({ withSavepoint: (fn: () => Promise<unknown>) => fn() }));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => Promise<unknown>) => fn(),
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
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const prisma = {
    store: m.store,
    storePageRevision: m.rev,
    category: { findMany: vi.fn().mockResolvedValue([]) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    ...actual,
    prisma,
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma),
  };
});

import routes from '@api/routes/page-builder.routes';
import { errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin/stores/:storeId/builder', routes);
  a.use(errorHandler);
  return a;
}

const STORE = { layoutSettings: {}, template: 'qamar', slug: 'acme', domain: 'acme.example.com' };
const draftRow = { id: 'd1', rev: 3, status: 'draft', document: DOC };

describe('publish purges every cache layer, after the commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue(STORE);
    m.store.update.mockResolvedValue({});
    m.bustStoreCaches.mockResolvedValue(undefined);
    m.rev.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status === 'draft' ? draftRow : null)
    );
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 3 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
  });

  it('POST publish -> bustStoreCaches(id, slug, domain) once, through deferAfterTenantCommit', async () => {
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
    expect(m.bustStoreCaches).toHaveBeenCalledTimes(1);
    expect(m.bustStoreCaches).toHaveBeenCalledWith('store-1', 'acme', 'acme.example.com');
    expect(m.defer).toHaveBeenCalledWith('page-builder.publish.purge');
    // and layout_settings was back-written in the same request
    expect(m.store.update).toHaveBeenCalledTimes(1);
  });

  it('POST rollback purges the same way', async () => {
    m.rev.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.rev === 1 ? { document: DOC } : where.status === 'draft' ? null : null)
    );
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(res.status).toBe(200);
    expect(m.bustStoreCaches).toHaveBeenCalledWith('store-1', 'acme', 'acme.example.com');
  });

  it('a failed purge does not fail the publish (bounded staleness, logged at error level)', async () => {
    m.bustStoreCaches.mockRejectedValue(new Error('redis down'));
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
  });

  it('PUT draft purges NOTHING public', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: DOC });
    expect(res.status).toBe(200);
    expect(res.body.data.rev).toBe(4);
    expect(m.bustStoreCaches).not.toHaveBeenCalled();
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it('a conflict publishes nothing and purges nothing (409 carries the latest rev)', async () => {
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REV_CONFLICT');
    expect(res.body.error.details.latest.rev).toBe(3);
    expect(m.bustStoreCaches).not.toHaveBeenCalled();
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it('an invalid draft body is a 422 with JSON-pointer errors', async () => {
    const bad = { ...DOC, sections: [{ id: 'x', type: 'nope', settings: {} }] };
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: bad });
    expect(res.status).toBe(422);
    expect(res.body.error.details.errors[0]).toMatchObject({
      code: 'UNKNOWN_TYPE',
      path: '/sections/0/type',
    });
  });

  it('unknown page keys 404; malformed bodies 400', async () => {
    expect((await request(app()).get('/admin/stores/store-1/builder/pages/about')).status).toBe(
      404
    );
    expect(
      (
        await request(app())
          .post('/admin/stores/store-1/builder/pages/home/publish')
          .send({ baseRev: 'x' })
      ).status
    ).toBe(400);
  });
});

describe('source contract', () => {
  const svc = readFileSync(
    join(__dirname, '../../apps/api/src/services/page-builder.service.ts'),
    'utf8'
  );
  const routes = readFileSync(
    join(__dirname, '../../apps/api/src/routes/page-builder.routes.ts'),
    'utf8'
  );
  const index = readFileSync(join(__dirname, '../../apps/api/src/routes/index.ts'), 'utf8');

  it('every builder route is authenticate -> authorize -> requireStoreAccess, mounted under tenantContext', () => {
    const handlers = routes.match(/router\.(get|put|post|delete)\(/g) ?? [];
    expect(handlers.length).toBe(6); // + preview-token (Phase 2)
    expect((routes.match(/\.\.\.guard/g) ?? []).length).toBe(handlers.length);
    expect(routes).toMatch(
      /const guard = \[authenticate, authorize\('store_admin', 'super_admin'\), requireStoreAccess\]/
    );
    expect(index).toMatch(
      /router\.use\('\/admin\/stores\/:storeId\/builder', tenantContext, pageBuilderRoutes\)/
    );
  });

  it('the purge helper has call sites (an invalidate with zero callers is the same bug inverted)', () => {
    expect((svc.match(/purgePublishedCaches\(/g) ?? []).length).toBeGreaterThanOrEqual(2); // definition + call
    expect(svc).toMatch(/deferAfterTenantCommit\('page-builder\.publish\.purge'/);
  });

  it('the public read never selects a draft', async () => {
    // Behaviour: run the real reader against the fake revision table, which holds BOTH a draft
    // and a published row; only the published row may come back.
    const { getPublishedDefinition } = await import('@api/services/page-builder.service');
    const publishedRow = { rev: 2, document: DOC };
    m.rev.findFirst.mockReset();
    m.rev.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status === 'published' ? publishedRow : draftRow)
    );
    const layout = resolveLayoutSettings({}, 'qamar');
    const out = await getPublishedDefinition('store-1', layout, null);
    expect(out.rev).toBe(2);
    expect(m.rev.findFirst).toHaveBeenCalled();
    for (const [arg] of m.rev.findFirst.mock.calls) expect(arg.where.status).toBe('published');
  });
});
