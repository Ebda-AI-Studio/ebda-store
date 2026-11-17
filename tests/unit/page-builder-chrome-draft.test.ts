import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { layoutToDefinition, resolveLayoutSettings, type PageDefinition } from '@ebda/shared';

const BASE = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const LIVE_SETTINGS = {
  contact: { phone: '010' },
  navMenu: [{ label: 'Old', href: '/old' }],
  footerLinks: {
    shop: [{ name: 'Old shop', href: '/old', enabled: true }],
    support: [{ name: 'Old help', href: '/help', enabled: true }],
    bottomBar: { enabled: true },
    newsletterEnabled: true,
  },
};
const CHROME = {
  navMenu: [{ label: 'Shop', labelAr: 'تسوق', href: '/products' }],
  footerLinks: { shop: [{ name: 'New shop', nameAr: 'جديد', href: '/new', enabled: true }] },
};
const DRAFT_DOC = { ...BASE, chrome: CHROME };

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
  template: 'qamar',
  slug: 'acme',
  domain: 'acme.example.com',
  theme: { primaryColor: '1 1% 1%' },
  settings: LIVE_SETTINGS,
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

describe('header/footer edits ride the draft, not the live store (E3)', () => {
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

  it('saving a draft WITH a chrome patch writes no live column and purges nothing', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: DRAFT_DOC });
    expect(res.status).toBe(200);
    expect(m.store.update).not.toHaveBeenCalled();
    expect(m.bustStoreCaches).not.toHaveBeenCalled();
    expect(m.rev.updateMany.mock.calls[0][0].data.document.chrome).toEqual(CHROME);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:x',
    'java\tscript:alert(1)',
  ])('a menu link %j is rejected with a 422 and nothing is written', async href => {
    const bad = { ...BASE, chrome: { navMenu: [{ label: 'x', href }] } };
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: bad });
    expect(res.status).toBe(422);
    expect(m.rev.updateMany).not.toHaveBeenCalled();
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it('an unsafe footer link and utility-bar link are rejected too', async () => {
    for (const chrome of [
      { footerLinks: { company: [{ name: 'x', href: 'javascript:1' }] } },
      { utilityBar: { links: [{ label: 'x', href: 'data:text/html,1' }] } },
    ]) {
      const res = await request(app())
        .put('/admin/stores/store-1/builder/pages/home/draft')
        .send({ baseRev: 3, definition: { ...BASE, chrome } });
      expect(res.status).toBe(422);
    }
    expect(m.rev.updateMany).not.toHaveBeenCalled();
  });

  it('unknown chrome keys (anything but navMenu/footerLinks/utilityBar) are rejected', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: { ...BASE, chrome: { settings: { evil: 1 } } } });
    expect(res.status).toBe(422);
  });

  it('publish merges the patch over the CURRENT live settings in the same stores update, and purges', async () => {
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
    expect(m.store.update).toHaveBeenCalledTimes(1);
    const arg = m.store.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'store-1' });
    expect(arg.data.layoutSettings).toBeDefined();
    const s = arg.data.settings;
    expect(s.navMenu).toEqual([{ label: 'Shop', labelAr: 'تسوق', href: '/products' }]);
    expect(s.footerLinks.shop).toEqual([
      { name: 'New shop', nameAr: 'جديد', href: '/new', enabled: true },
    ]);
    // untouched: other settings keys, the other footer columns, legacy footer keys
    expect(s.contact).toEqual({ phone: '010' });
    expect(s.footerLinks.support).toEqual(LIVE_SETTINGS.footerLinks.support);
    expect(s.footerLinks.bottomBar).toEqual({ enabled: true });
    expect(s.footerLinks.newsletterEnabled).toBe(true);
    expect(m.bustStoreCaches).toHaveBeenCalledWith('store-1', 'acme', 'acme.example.com');
  });

  it('publish drops blank (half-typed) rows exactly like the classic save', async () => {
    rows({
      draft: {
        id: 'd1',
        rev: 3,
        status: 'draft',
        document: {
          ...BASE,
          chrome: {
            navMenu: [
              { label: 'Keep', href: '/keep' },
              { label: '', href: '/' },
              { label: 'No link', href: '' },
            ],
          },
        },
      },
    });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(m.store.update.mock.calls[0][0].data.settings.navMenu).toEqual([
      { label: 'Keep', href: '/keep' },
    ]);
  });

  it('publishing a draft with NO chrome patch leaves stores.settings out of the write', async () => {
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: BASE } });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('settings');
  });

  it('rollback re-applies the target revision chrome patch; a revision without one leaves settings alone', async () => {
    rows({ byRev: { 1: { document: DRAFT_DOC }, 2: { document: BASE } } });
    const a = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(a.status).toBe(200);
    expect(m.store.update.mock.calls[0][0].data.settings.navMenu).toEqual(CHROME.navMenu);
    m.store.update.mockClear();
    const b = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 2 });
    expect(b.status).toBe(200);
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('settings');
  });

  it('the editor canvas reads the DRAFT chrome patch', async () => {
    const r = await getPreviewDefinition('store-1', 'home');
    expect(r?.definition.chrome).toEqual(CHROME);
  });

  it('with no draft, the editor never re-opens a published chrome patch as a pending edit', async () => {
    rows({
      published: { id: 'p1', rev: 3, status: 'published', document: DRAFT_DOC },
    });
    const state = await request(app()).get('/admin/stores/store-1/builder/pages/home');
    expect(state.body.data.definition).not.toHaveProperty('chrome');
    expect(state.body.data.source).toBe('published');
  });

  it('every revision query stays scoped to the caller store', async () => {
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    for (const [a] of m.rev.updateMany.mock.calls) expect(a.where.storeId).toBe('store-1');
    for (const [a] of m.rev.findFirst.mock.calls) expect(a.where.storeId).toBe('store-1');
  });
});

describe('the header logo rides the same publish update (logo draft)', () => {
  const LOGO = 'https://media.ebda.app/stores/store-1/builder/logo.png';
  const LOGO_AR = 'https://media.ebda.app/stores/store-1/builder/logo-ar.png';
  const LOGO_DOC = { ...BASE, chrome: { logo: LOGO, logoAr: LOGO_AR } };

  beforeEach(() => {
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue({
      ...STORE,
      logo: 'https://media.ebda.app/old.png',
      logoAr: null,
    });
    m.store.update.mockResolvedValue({});
    m.bustStoreCaches.mockResolvedValue(undefined);
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 3 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: LOGO_DOC } });
  });

  it('saving a draft with a logo writes no live column and purges nothing', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: LOGO_DOC });
    expect(res.status).toBe(200);
    expect(m.store.update).not.toHaveBeenCalled();
    expect(m.bustStoreCaches).not.toHaveBeenCalled();
    expect(m.rev.updateMany.mock.calls[0][0].data.document.chrome).toEqual(LOGO_DOC.chrome);
  });

  it.each(['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'mailto:a@b.co'])(
    'a logo %j is rejected with a 422',
    async logo => {
      const res = await request(app())
        .put('/admin/stores/store-1/builder/pages/home/draft')
        .send({ baseRev: 3, definition: { ...BASE, chrome: { logo } } });
      expect(res.status).toBe(422);
      expect(m.rev.updateMany).not.toHaveBeenCalled();
    }
  );

  it('a logo outside our media origin is rejected unless it is already the live logo', async () => {
    const ext = 'https://evil.example.com/x.png';
    const bad = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: { ...BASE, chrome: { logo: ext } } });
    expect(bad.status).toBe(422);
    m.store.findUnique.mockResolvedValue({ ...STORE, logo: ext, logoAr: null });
    const ok = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: { ...BASE, chrome: { logo: ext } } });
    expect(ok.status).toBe(200);
  });

  it('publish writes logo + logoAr in the SAME stores update and purges', async () => {
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
    expect(m.store.update).toHaveBeenCalledTimes(1);
    const data = m.store.update.mock.calls[0][0].data;
    expect(data.logo).toBe(LOGO);
    expect(data.logoAr).toBe(LOGO_AR);
    expect(data.layoutSettings).toBeDefined();
    expect(m.bustStoreCaches).toHaveBeenCalledWith('store-1', 'acme', 'acme.example.com');
  });

  it('a blank logo key and a draft without the key leave the live logo alone', async () => {
    rows({
      draft: {
        id: 'd1',
        rev: 3,
        status: 'draft',
        document: { ...BASE, chrome: { logo: '', navMenu: CHROME.navMenu } },
      },
    });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('logo');
    m.store.update.mockClear();
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: { ...BASE, chrome: CHROME } } });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('logo');
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('logoAr');
  });

  it('rollback re-applies the revision logo; a revision without one leaves it alone', async () => {
    rows({ byRev: { 1: { document: LOGO_DOC }, 2: { document: BASE } } });
    const a = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(a.status).toBe(200);
    expect(m.store.update.mock.calls[0][0].data.logo).toBe(LOGO);
    m.store.update.mockClear();
    const b = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 2 });
    expect(b.status).toBe(200);
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('logo');
  });
});

describe('classic builder save keeps a pending visual draft (E2)', () => {
  const section = (doc: PageDefinition, type: string) => doc.sections.find(s => s.type === type)!;
  const PUBLISHED = { id: 'p1', rev: 3, status: 'published', document: BASE };
  // The merchant's unpublished visual work: a categories title, a theme patch,
  // a chrome patch and a brand-new image-text section that exists nowhere live.
  const draftDoc: PageDefinition = {
    ...BASE,
    sections: [
      ...BASE.sections.map(s =>
        s.type === 'category-grid' ? { ...s, settings: { ...s.settings, title: 'Draft title' } } : s
      ),
      { id: 'image-text-9', type: 'image-text', settings: { heading: 'Draft only' } },
    ],
    theme: { primaryColor: '200 50% 40%' },
    chrome: CHROME,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue(STORE);
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 4 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
    rows({
      draft: { id: 'd1', rev: 4, status: 'draft', document: draftDoc },
      published: PUBLISHED,
    });
  });

  async function classicSave() {
    const { publishLegacyLayout } = await import('@api/services/page-builder.service');
    return publishLegacyLayout({
      storeId: 'store-1',
      // the classic builder changed ONE thing: a sticky header
      layout: resolveLayoutSettings({ header: { sticky: true } }, 'qamar'),
      userId: 'user-1',
    });
  }
  const draftUpdate = () =>
    m.rev.updateMany.mock.calls.map(c => c[0]).find((c: any) => c.where?.status === 'draft');

  it('publishes what it edited, and keeps the visual draft instead of archiving or deleting it', async () => {
    expect(await classicSave()).toBe('ok');
    const created = m.rev.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ status: 'published', rev: 5, baseRev: 4 });
    const live = created.document as PageDefinition;
    expect(live.sectionGroups.header.find(s => s.type === 'header')!.settings.sticky).toBe(true);
    // unpublished visual work does not leak live through the classic save
    expect(live.sections.some(s => s.type === 'image-text')).toBe(false);
    expect(section(live, 'category-grid').settings.title).not.toBe('Draft title');
    // nothing archived or deleted the draft: the only write that touches it is the re-base
    const archivedDraft = m.rev.updateMany.mock.calls.filter(
      c => c[0].data?.status === 'archived' && c[0].where?.status === 'draft'
    );
    expect(archivedDraft).toHaveLength(0);
  });

  it('merges the classic edit INTO the draft and keeps every pending visual edit', async () => {
    await classicSave();
    const upd = draftUpdate();
    expect(upd.where).toMatchObject({ id: 'd1', storeId: 'store-1', status: 'draft' });
    const merged = upd.data.document as PageDefinition;
    // the classic edit is now in the draft (a later Publish cannot revert it)
    expect(merged.sectionGroups.header.find(s => s.type === 'header')!.settings.sticky).toBe(true);
    // the visual work survives
    expect(section(merged, 'category-grid').settings.title).toBe('Draft title');
    expect(merged.sections.some(s => s.type === 'image-text')).toBe(true);
    expect(merged.theme).toEqual({ primaryColor: '200 50% 40%' });
    expect(merged.chrome).toEqual(CHROME);
  });

  it('moves the draft above the new head so it stays publishable (no 409 on its next save)', async () => {
    await classicSave();
    expect(draftUpdate().data).toMatchObject({ rev: 6, baseRev: 5 });
  });

  it('no draft: nothing to merge, behaves as before', async () => {
    rows({ published: PUBLISHED });
    expect(await classicSave()).toBe('ok');
    expect(draftUpdate()).toBeUndefined();
  });
});
