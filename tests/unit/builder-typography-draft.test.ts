/**
 * Ruling VE-4: fonts, typography zones and Smart Palette are DRAFT edits, like everything else.
 *   - shared: the patch schema, the merge, the snapshot, the theme reset (`null`), Smart Palette on a document;
 *   - service: a draft save writes nothing live; publish merges over `stores.typography` in the SAME
 *     stores update as the layout back-write and snapshots; rollback restores a snapshot and a revision
 *     without one leaves typography alone; removed custom fonts are cleaned up from R2 after publish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { emitZoneCss } from '../../apps/web/src/lib/emit-zone-css';
import request from 'supertest';
import {
  DERIVED_THEME_KEYS,
  THEME_SETTINGS_SCHEMA,
  applySmartPalette,
  applyThemePatch,
  applyTypographyPatch,
  draftThemeSchema,
  draftTypographySchema,
  effectiveTheme,
  hasTypographyPatch,
  layoutToDefinition,
  pageDefinitionSchema,
  resolveLayoutSettings,
  snapshotEditableTheme,
  snapshotTypography,
} from '@ebda/shared';

const BASE = layoutToDefinition(resolveLayoutSettings({}, 'modern'));
const GOOGLE = {
  type: 'google' as const,
  family: 'Tajawal',
  url: 'https://fonts.googleapis.com/css2?family=Tajawal',
};
const CUSTOM = {
  type: 'custom' as const,
  family: 'Brand',
  url: 'https://cdn.example.com/stores/store-1/fonts/brand.woff2',
  format: 'woff2' as const,
};
const LIVE_TYPO = {
  fonts: [CUSTOM],
  zones: { header: { fontWeight: '700' }, footer: { color: 'token:muted' } },
};

describe('draftTypographySchema', () => {
  it('accepts fonts, zones and a null zone, and the document accepts the patch', () => {
    const patch = { fonts: [GOOGLE], zones: { header: { fontSize: '1.2rem' }, footer: null } };
    expect(draftTypographySchema.safeParse(patch).success).toBe(true);
    expect(pageDefinitionSchema.safeParse({ ...BASE, typography: patch }).success).toBe(true);
  });
  it('is strict: an unknown zone, an unknown key and a non-https font are refused', () => {
    expect(draftTypographySchema.safeParse({ zones: { nope: {} } }).success).toBe(false);
    expect(draftTypographySchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      draftTypographySchema.safeParse({ fonts: [{ ...GOOGLE, url: 'http://x.test/a.css' }] })
        .success
    ).toBe(false);
    expect(
      draftTypographySchema.safeParse({ fonts: [{ ...GOOGLE, url: 'javascript:alert(1)' }] })
        .success
    ).toBe(false);
    expect(draftTypographySchema.safeParse({ fonts: Array(21).fill(GOOGLE) }).success).toBe(false);
  });
  it('a zone value is bound like the typography PUT (length caps)', () => {
    expect(
      draftTypographySchema.safeParse({ zones: { header: { fontFamily: 'x'.repeat(300) } } })
        .success
    ).toBe(false);
  });
});

describe('applyTypographyPatch / snapshotTypography', () => {
  it('replaces the font library, merges zones per zone and clears a zone with null', () => {
    const out = applyTypographyPatch(LIVE_TYPO, {
      fonts: [GOOGLE],
      zones: { header: { fontSize: '2rem' }, footer: null },
    });
    expect(out.fonts).toEqual([GOOGLE]);
    expect(out.zones).toEqual({ header: { fontSize: '2rem' } });
  });
  it('an absent patch changes nothing, and an empty live blob works', () => {
    expect(applyTypographyPatch(LIVE_TYPO, undefined)).toEqual(LIVE_TYPO);
    expect(applyTypographyPatch(null, { zones: { header: { fontWeight: '400' } } })).toEqual({
      fonts: [],
      zones: { header: { fontWeight: '400' } },
    });
    expect(hasTypographyPatch({})).toBe(false);
    expect(hasTypographyPatch({ zones: {} })).toBe(false);
    expect(hasTypographyPatch({ fonts: [] })).toBe(true);
  });
  it('the snapshot is the whole blob after the patch, every unset zone listed as null', () => {
    const snap = snapshotTypography(LIVE_TYPO, {
      zones: { footer: null, header: { fontSize: '2rem' } },
    });
    expect(snap.fonts).toEqual([CUSTOM]);
    expect(snap.zones?.header).toEqual({ fontSize: '2rem' });
    expect(snap.zones?.footer).toBeNull();
    expect(snap.zones?.sectionTitle).toBeNull();
    // so applying it later gives back exactly that typography, even after the live store gained a zone
    const later = {
      fonts: [GOOGLE],
      zones: { header: { fontSize: '9px' }, products: { color: 'red' } },
    };
    expect(applyTypographyPatch(later, snap)).toEqual({
      fonts: [CUSTOM],
      zones: { header: { fontSize: '2rem' } },
    });
  });
  it('never mutates its inputs', () => {
    const live = JSON.parse(JSON.stringify(LIVE_TYPO));
    applyTypographyPatch(live, { fonts: [], zones: { header: null } });
    expect(live).toEqual(LIVE_TYPO);
  });
});

describe('theme reset is a draft edit (null)', () => {
  it('null is accepted for an editable key only, and removes it from the effective theme', () => {
    expect(draftThemeSchema.safeParse({ primaryColor: null }).success).toBe(true);
    expect(draftThemeSchema.safeParse({ showBranchesInFooter: null }).success).toBe(false);
    expect(
      effectiveTheme({ primaryColor: 'a', fontFamily: 'serif' }, { primaryColor: null })
    ).toEqual({
      fontFamily: 'serif',
    });
    expect(applyThemePatch({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
  it('the snapshot records the reset so a rollback removes the key again', () => {
    const snap = snapshotEditableTheme(
      { primaryColor: 'a', fontFamily: 'serif' },
      { primaryColor: null }
    );
    expect(snap).toEqual({ primaryColor: null, fontFamily: 'serif' });
  });
  it('the theme has no dividers control (there is no editor for it; per-section dividers replace it)', () => {
    const types = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings.map(s => s.type));
    expect(types).not.toContain('dividers');
  });
});

describe('applySmartPalette', () => {
  const entry = (bg: string) => ({
    bgColor: bg,
    cardFrameColor: 'token:border',
    cardFrameWidth: 'thin' as never,
    cardFrameSize: 'normal' as never,
  });
  const palette = {
    hero: entry('#111111'),
    categories: entry('#222222'),
    newArrivals: entry('#333333'),
    bestSellers: entry('#444444'),
    testimonials: entry('#555555'),
  };
  it('colours the sections and puts the brand tokens in the draft theme (one document)', () => {
    const out = applySmartPalette(BASE, palette, {
      primaryColor: '10 20% 30%',
      primaryForeground: '0 0% 100%',
      showQuickAdd: true, // a card toggle: never part of a palette
      fontFamily: 'serif', // not a colour: never part of a palette
    });
    const by = (t: string) => out.sections.find(n => n.type === t)!.settings;
    expect(by('hero').bgColor).toBe('#111111');
    expect(by('category-grid')).toMatchObject({
      bgColor: '#222222',
      showCardFrame: true,
      cardFrameColor: 'token:border',
    });
    expect(by('testimonials').bgColor).toBe('#555555');
    expect(by('testimonials').showCardFrame).toBeUndefined();
    expect(out.theme).toEqual({ primaryColor: '10 20% 30%', primaryForeground: '0 0% 100%' });
    expect(DERIVED_THEME_KEYS).toContain('primaryForeground');
    expect(pageDefinitionSchema.safeParse(out).success).toBe(true);
    // the input document is untouched
    expect(BASE.theme).toBeUndefined();
  });
});

describe('the canvas paints the draft typography', () => {
  it('the zone CSS follows the patch: a changed zone updates, a cleared zone and a removed font vanish', () => {
    const live = emitZoneCss(LIVE_TYPO);
    expect(live).toContain('[data-zone="footer"]');
    expect(live).toContain("@font-face{font-family:'Brand'");
    const draft = emitZoneCss(
      applyTypographyPatch(LIVE_TYPO, {
        fonts: [GOOGLE],
        zones: { header: { fontSize: '2rem' }, footer: null },
      })
    );
    expect(draft).toMatch(/\[data-zone="header"\][^{]*\{[^}]*font-size:2rem/);
    expect(draft).not.toContain('[data-zone="footer"]');
    expect(draft).not.toContain("font-family:'Brand'");
    expect(draft).toContain(GOOGLE.url);
  });
  it('an unsafe value in a draft never reaches the stylesheet', () => {
    const css = emitZoneCss(
      applyTypographyPatch(null, { zones: { header: { fontFamily: 'x; } body { display:none' } } })
    );
    expect(css).not.toContain('display:none');
  });
});

/* ---------------------------------- service ---------------------------------- */

const m = vi.hoisted(() => ({
  bustStoreCaches: vi.fn(),
  deleteR2: vi.fn(),
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
vi.mock('../../apps/api/src/config', () => ({
  config: { storagePublicUrl: 'https://cdn.example.com', storageEndpoint: '', storageBucket: '' },
}));
vi.mock('@api/services/r2-cleanup.service', async importOriginal => {
  // the real key helpers (the font URL guard needs them), a stubbed delete
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    cleanupRemovedJsonUrls: vi.fn().mockResolvedValue(undefined),
    deleteR2ObjectIfOrphan: m.deleteR2,
  };
});
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (_n: string, run: () => Promise<unknown>) => run(),
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

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/admin/stores/:storeId/builder', routes);
  a.use(errorHandler);
  return a;
};
const PATCH = { fonts: [GOOGLE], zones: { header: { fontSize: '2rem' }, footer: null } };
const DRAFT_DOC = { ...BASE, typography: PATCH };
const STORE = {
  layoutSettings: {},
  template: 'modern',
  slug: 'acme',
  domain: 'acme.example.com',
  theme: { primaryColor: '1 1% 1%' },
  typography: LIVE_TYPO,
};
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

describe('typography rides the draft, not the live store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue(STORE);
    m.store.update.mockResolvedValue({});
    m.bustStoreCaches.mockResolvedValue(undefined);
    m.deleteR2.mockResolvedValue(undefined);
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 3 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: DRAFT_DOC } });
  });

  it('saving a draft with a typography patch writes no live column and purges nothing', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: DRAFT_DOC });
    expect(res.status).toBe(200);
    expect(m.store.update).not.toHaveBeenCalled();
    expect(m.bustStoreCaches).not.toHaveBeenCalled();
    expect(m.rev.updateMany.mock.calls[0][0].data.document.typography).toEqual(PATCH);
  });

  it('an invalid patch (unknown zone) is a 422 and writes nothing', async () => {
    const res = await request(app())
      .put('/admin/stores/store-1/builder/pages/home/draft')
      .send({ baseRev: 3, definition: { ...BASE, typography: { zones: { bogus: {} } } } });
    expect(res.status).toBe(422);
    expect(m.rev.updateMany).not.toHaveBeenCalled();
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it('publish merges the patch over the CURRENT live typography in the same stores update, and purges once', async () => {
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(res.status).toBe(200);
    expect(m.store.update).toHaveBeenCalledTimes(1);
    const data = m.store.update.mock.calls[0][0].data;
    expect(data.layoutSettings).toBeDefined();
    expect(data.typography).toEqual({ fonts: [GOOGLE], zones: { header: { fontSize: '2rem' } } });
    expect(data).not.toHaveProperty('theme');
    expect(m.bustStoreCaches).toHaveBeenCalledTimes(1);
    expect(m.bustStoreCaches).toHaveBeenCalledWith('store-1', 'acme', 'acme.example.com');
  });

  it('publish records a full snapshot, and deletes a custom font that left the library from R2', async () => {
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    const snap = publishedUpdate().data.document.typography;
    expect(snap.fonts).toEqual([GOOGLE]);
    expect(snap.zones.header).toEqual({ fontSize: '2rem' });
    expect(snap.zones.footer).toBeNull();
    expect(m.deleteR2).toHaveBeenCalledTimes(1);
    expect(m.deleteR2).toHaveBeenCalledWith(CUSTOM.url);
  });

  it('a draft with no typography patch leaves stores.typography out of the write', async () => {
    rows({ draft: { id: 'd1', rev: 3, status: 'draft', document: BASE } });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('typography');
    expect(publishedUpdate().data).not.toHaveProperty('document');
    expect(m.deleteR2).not.toHaveBeenCalled();
  });

  it('rollback re-applies the target snapshot; one that predates typography leaves it alone', async () => {
    // a snapshot as publish writes it: every zone listed, unset ones null
    const old = {
      ...BASE,
      typography: snapshotTypography(null, {
        fonts: [CUSTOM],
        zones: { header: { fontWeight: '900' } },
      }),
    };
    rows({ byRev: { 1: { document: old } } });
    const res = await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(res.status).toBe(200);
    expect(m.store.update.mock.calls[0][0].data.typography).toEqual({
      fonts: [CUSTOM],
      zones: { header: { fontWeight: '900' } },
    });
    vi.clearAllMocks();
    m.store.findUnique.mockResolvedValue(STORE);
    m.store.update.mockResolvedValue({});
    m.rev.aggregate.mockResolvedValue({ _max: { rev: 3 } });
    m.rev.updateMany.mockResolvedValue({ count: 1 });
    m.rev.create.mockResolvedValue({});
    rows({ byRev: { 1: { document: BASE } } });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/rollback')
      .send({ baseRev: 3, targetRev: 1 });
    expect(m.store.update.mock.calls[0][0].data).not.toHaveProperty('typography');
  });

  it('a theme reset (null) removes the key from the live theme at publish', async () => {
    rows({
      draft: {
        id: 'd1',
        rev: 3,
        status: 'draft',
        document: { ...BASE, theme: { primaryColor: null } },
      },
    });
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    expect(m.store.update.mock.calls[0][0].data.theme).toEqual({});
    expect(publishedUpdate().data.document.theme).toEqual({ primaryColor: null });
  });

  it('the canvas reads the DRAFT typography; a published snapshot is never re-opened as a pending edit', async () => {
    expect((await getPreviewDefinition('store-1', 'home'))?.definition.typography).toEqual(PATCH);
    rows({
      published: {
        id: 'p1',
        rev: 3,
        status: 'published',
        document: { ...BASE, typography: { fonts: [] } },
      },
    });
    const state = await request(app()).get('/admin/stores/store-1/builder/pages/home');
    expect(state.body.data.definition).not.toHaveProperty('typography');
    expect(state.body.data.source).toBe('published');
  });

  it('every revision query stays scoped to the caller store', async () => {
    await request(app())
      .post('/admin/stores/store-1/builder/pages/home/publish')
      .send({ baseRev: 3 });
    for (const [a] of m.rev.updateMany.mock.calls) expect(a.where.storeId).toBe('store-1');
  });
});
