/**
 * Editor bug "theme save goes live without Publish, and the canvas goes
 * stale" (Ruling THEME-DRAFT-1). Theme edits are a patch in the page document:
 *   - saving a draft changes NOTHING live (no stores write, no cache purge);
 *   - publish merges the patch over stores.theme in the SAME stores update as
 *     the layout_settings back-write, records a snapshot, and purges caches;
 *   - rollback restores a revision's theme snapshot (none = theme untouched);
 *   - the editor canvas (preview) reads the DRAFT theme, never a published one;
 *   - every query stays scoped to the caller's store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

const BASE = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
const LIVE_THEME = { primaryColor: '1 1% 1%', fontFamily: 'serif', showBranchesInFooter: true };
const DRAFT_DOC = { ...BASE, theme: { primaryColor: '200 50% 40%' } };

const m = vi.hoisted(() => ({
  bustStoreCaches: vi.fn(),
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

describe('theme edits ride the draft, not the live store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue(STORE);
    m.store.update.mockResolvedValue({});
    m.bustStoreCaches.mockResolvedValue(undefined);
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 3 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: DRAFT_DOC } });
  });

  it('saving a draft WITH a theme patch writes no live column and purges nothing', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: DRAFT_DOC });
    expect(res.status).toBe(200);
    expect(m.store.update).not.toHaveBeenCalled();
    expect(m.bustStoreCaches).not.toHaveBeenCalled();
    const saved = m.rev.updateMany.mock.calls[0][0];
    expect(saved.data.document.theme).toEqual({ primaryColor: '200 50% 40%' });
    expect(saved.where).toMatchObject({ storeId: 'store-1', status: 'draft' });
  });

  it('a draft theme with a key the editor does not manage is a 422 and writes nothing', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: { ...BASE, theme: { showBranchesInFooter: false } } });
    expect(res.status).toBe(422);
    expect(m.rev.updateMany).not.toHaveBeenCalled();
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it('publish merges the patch over the CURRENT live theme in the same stores update, and purges', async () => {
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
    expect(m.store.update).toHaveBeenCalledTimes(1);
    const arg = m.store.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'store-1' });
    expect(arg.data.layoutSettings).toBeDefined();
    // patch wins; keys the editor did not touch (even non-editor ones) survive
    expect(arg.data.theme).toEqual({ ...LIVE_THEME, primaryColor: '200 50% 40%' });
    expect(m.bustStoreCaches).toHaveBeenCalledWith('store-1', 'acme', 'acme.example.com');
  });

  it('publish records a full snapshot of the editor-managed keys on the published revision', async () => {
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    const upd = publishedUpdate();
    expect(upd.where).toMatchObject({ id: 'd1', storeId: 'store-1', status: 'draft' });
    // fontFamily came from live; showBranchesInFooter is not editor-managed -> excluded
    expect(upd.data.document.theme).toEqual({ primaryColor: '200 50% 40%', fontFamily: 'serif' });
  });

  it('publishing a draft with NO theme patch leaves stores.theme out of the write', async () => {
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: BASE } });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('theme');
    expect(publishedUpdate().data).not.toHaveProperty('document');
  });

  it('rollback re-applies the target revision theme snapshot (and publishes it as a new revision)', async () => {
    const old = { ...BASE, theme: { primaryColor: '9 9% 9%', fontFamily: 'rounded' } };
    rows({ byRev: { 1: { document: old } } });
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(res.status).toBe(200);
    expect(m.store.update.mock.calls[0][0].data.theme).toEqual({
      ...LIVE_THEME,
      primaryColor: '9 9% 9%',
      fontFamily: 'rounded',
    });
    expect(m.rev.create.mock.calls[0][0].data.document.theme).toEqual(old.theme);
    expect(m.bustStoreCaches).toHaveBeenCalledTimes(1);
  });

  it('rollback to a revision that predates theme drafts leaves the live theme untouched', async () => {
    rows({ byRev: { 1: { document: BASE } } });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('theme');
  });

  it('the editor canvas reads the DRAFT theme', async () => {
    const r = await getPreviewDefinition('store-1', 'home');
    expect(r?.definition.theme).toEqual({ primaryColor: '200 50% 40%' });
  });

  it('with no draft, the canvas/editor never re-opens a published theme snapshot as a pending edit', async () => {
    rows({
      published: {
        id: 'p1',
        rev: 3,
        status: 'published',
        document: { ...BASE, theme: { primaryColor: 'stale' } },
      },
    });
    const r = await getPreviewDefinition('store-1', 'home');
    expect(r?.definition).not.toHaveProperty('theme');
    const state = await request(app()).get('/admin/stores/store-1/builder/pages/home');
    expect(state.body.data.definition).not.toHaveProperty('theme');
    expect(state.body.data.source).toBe('published');
  });

  it('every revision query is scoped to the caller store (tenant isolation unchanged)', async () => {
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    for (const [a] of m.rev.updateMany.mock.calls) expect(a.where.storeId).toBe('store-1');
    for (const [a] of m.rev.findFirst.mock.calls) expect(a.where.storeId).toBe('store-1');
  });
});
