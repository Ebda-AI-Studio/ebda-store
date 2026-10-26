/**
 * Versioned publish (builder Phase 3 gap): every publish and rollback records WHO and WHEN on the
 * revision it creates, history returns them, and a publish purges every storefront cache layer
 * (page content is NEVER-stale after publish: event invalidation, retried; the 60 s revalidate is only
 * the backstop).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

const BASE = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
const LIVE_THEME = { primaryColor: '1 1% 1%', fontFamily: 'serif', showBranchesInFooter: true };

const m = vi.hoisted(() => ({
  bustStoreCaches: vi.fn(),
  store: { findUnique: vi.fn(), update: vi.fn() },
  user: { findFirst: vi.fn() },
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
  deferAfterTenantCommit: (_name: string, run: () => Promise<unknown>) => run(),
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
    user: m.user,
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
import { getPreviewDefinition } from '@api/services/page-builder.service';
import { errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin/stores/:storeId/builder', routes);
  a.use(errorHandler);
  return a;
}

const STORE = {
  layoutSettings: {},
  template: 'modern',
  slug: 'acme',
  domain: 'acme.example.com',
  theme: LIVE_THEME,
};

/** Row lookups by status / rev; anything unset is "no such row". */
function rows(r: { draft?: unknown; published?: unknown; byRev?: Record<number, unknown> }) {
  m.rev.findFirst.mockImplementation(({ where }: any) => {
    if (where.rev !== undefined) return Promise.resolve(r.byRev?.[where.rev] ?? null);
    if (where.status === 'draft') return Promise.resolve(r.draft ?? null);
    if (where.status === 'published') return Promise.resolve(r.published ?? null);
    return Promise.resolve(null);
  });
}
const publishedUpdate = () =>
  m.rev.updateMany.mock.calls.map(c => c[0]).find((c: any) => c.data?.status === 'published');

describe('versioned publish records who and when', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue(STORE);
    m.store.update.mockResolvedValue({});
    m.bustStoreCaches.mockResolvedValue(undefined);
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 3 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
    m.user.findFirst.mockResolvedValue({ firstName: 'Mona', lastName: 'Adel' });
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: BASE } });
  });

  it('publish stamps publishedBy, publishedByName and publishedAt on the promoted row', async () => {
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
    const upd = m.rev.updateMany.mock.calls
      .map(c => c[0])
      .find((c: any) => c.data?.status === 'published');
    expect(upd.data.publishedBy).toBe('user-1');
    expect(upd.data.publishedByName).toBe('Mona Adel');
    expect(upd.data.publishedAt).toBeInstanceOf(Date);
  });

  it('rollback (one-click restore) stamps the restorer on the new published revision', async () => {
    rows({ byRev: { 1: { document: BASE } } });
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(res.status).toBe(200);
    const row = m.rev.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      publishedBy: 'user-1',
      publishedByName: 'Mona Adel',
      note: 'rollback to rev 1',
    });
  });

  it('a missing name never blocks a publish (name stays null, id is still recorded)', async () => {
    m.user.findFirst.mockResolvedValue(null);
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
    const upd = m.rev.updateMany.mock.calls
      .map(c => c[0])
      .find((c: any) => c.data?.status === 'published');
    expect(upd.data.publishedBy).toBe('user-1');
    expect(upd.data.publishedByName).toBeNull();
  });

  it('history returns who and when for each version', async () => {
    m.rev.findMany.mockResolvedValue([]);
    await request(app()).get('/admin/stores/store-1/builder/pages/home/revisions');
    const select = m.rev.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ publishedBy: true, publishedByName: true, publishedAt: true });
  });

  it('a failed purge is retried, so a transient cache error does not leave the page stale', async () => {
    m.bustStoreCaches.mockRejectedValueOnce(new Error('kv down')).mockResolvedValue(undefined);
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    await vi.waitFor(() => expect(m.bustStoreCaches).toHaveBeenCalledTimes(2));
  });
});
