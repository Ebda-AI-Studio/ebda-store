/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { RETIRED_TEMPLATES, definitionToLayout, getLook } from '@ebda/shared';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';
import { doCreate, doDeleteMany, doRead, doSetStoreFields, doStoreRecord } from './do-read';

// Ported from tests/integration/store-look.test.ts (Postgres, ebda_app + tenant guard, express, vi.mock fault injection) to the built Worker +
// StoreDO, over HTTP with the REAL look registry: PUT /stores/:id/look keep vs reset of look-owned theme keys, INVALID_LOOK, an empty store
// PUBLISHES the family while a store with a published revision gets a DRAFT only, the design keys follow the look (Vitrine / Jasmine / Lamma real
// mixes, switched across skins), a hand-set hero presentation survives, a discarded draft re-bases on the published appliedLook, a legacy layout
// store gets a draft with layout untouched, reset strips look keys from a pending draft's theme patch, createdBy, another merchant's store is
// refused, PUT /template refuses a retired template (#111), PUT /theme validation + null delete.
// Not ported (they need in-process fault injection a built Worker has no hook for): the "every section unpublishable stays a DRAFT" case
// (vi.mock validatePublishReadiness), "a builder refusal leaves the store unchanged" (vi.mock validateDefinition), "a retry after the store
// update failed converges" (throw injected after the builder step), the invalidateCached / cleanupRemovedJsonUrls call spies, and the injected
// controlled look mixes (the real Lookbook / Vitrine / Jasmine / Lamma mixes are asserted instead).
let n = 0;
/** A store on the legacy `dahab` skin, no look, no page revisions, `theme` / `layoutSettings` as given (what the original seeded). */
async function seed(
  tag: string,
  theme: Record<string, unknown> = {},
  layout?: Record<string, unknown>
) {
  const m = await bootstrapMerchant(`lk-${tag}-${++n}`, { look: false });
  await doDeleteMany(m.storeId, 'StorePageRevision', { storeId: m.storeId });
  await doSetStoreFields(m.storeId, {
    template: 'dahab',
    look: null,
    theme,
    layoutSettings: layout ?? {},
  });
  return m;
}
const put = (m: Merchant, body: unknown, token = m.token, storeId = m.storeId) =>
  call(`/stores/${storeId}/look`, { method: 'PUT', token, body });
const putTheme = (m: Merchant, body: Record<string, unknown>) =>
  call(`/stores/${m.storeId}/theme`, { method: 'PUT', token: m.token, body });
const row = (m: Merchant) => doStoreRecord(m.storeId, ['look', 'template', 'theme']);
type Doc = {
  appliedLook?: string;
  theme?: Record<string, unknown>;
  sections: Array<{ type: string; settings: Record<string, any>; blocks?: unknown[] }>;
};
type Rev = {
  id: string;
  rev: number;
  status: string;
  document: Doc;
  createdBy: string | null;
  schemaVersion: number;
};
const revs = (m: Merchant) =>
  doRead<Rev>(m.storeId, 'StorePageRevision', {
    where: { storeId: m.storeId, pageKey: 'home' },
    orderBy: { rev: 'asc' },
  });
const docOf = async (m: Merchant, status: 'draft' | 'published') =>
  (await revs(m)).find(r => r.status === status)!;
const newest = async (m: Merchant) => (await revs(m)).at(-1)!.document;
const sec = (doc: Doc, type: string) => doc.sections.find(x => x.type === type)?.settings;
const ok = async (m: Merchant, lookId: string, design = 'keep') => {
  const res = await put(m, { lookId, design });
  expect(res.status, `${lookId}: ${res.text}`).toBe(200);
  return res;
};
// the plumbing look: any built look works for the switch mechanics (the original used an unbuilt fixture presented as built by a mock)
const PLAIN = 'qamar.atelier';

describe('PUT /stores/:id/look on the Worker', () => {
  it('keep: sets look + skin template and leaves the theme untouched', async () => {
    const m = await seed('keep', { primaryColor: 'X', showQuickAdd: true });
    const res = await ok(m, PLAIN, 'keep');
    expect(res.json.data).toMatchObject({ look: PLAIN, template: getLook(PLAIN)!.skin });
    expect(await row(m)).toMatchObject({
      look: PLAIN,
      template: getLook(PLAIN)!.skin,
      theme: { primaryColor: 'X', showQuickAdd: true },
    });
  });

  it('reset: drops look-owned keys, keeps non-look keys', async () => {
    const m = await seed('reset', { primaryColor: 'X', showQuickAdd: true });
    await ok(m, PLAIN, 'reset');
    const s = await row(m);
    expect(s.theme).toEqual({ showQuickAdd: true });
    expect(s.look).toBe(PLAIN);
  });

  it('reset: also drops the optional look UI tokens a merchant stored (W2a)', async () => {
    const m = await seed('reset-ui', {
      wordmarkSize: 'xl',
      overPhotoChrome: 'soft',
      receiptStyle: 'device',
      cardCta: 'quiet',
      cardHover: 'lift',
      showQuickAdd: true,
    });
    await ok(m, PLAIN, 'reset');
    expect((await row(m)).theme).toEqual({ showQuickAdd: true });
  });

  it('theme PUT: density / imageRatio / motion accept only their known values (null deletes)', async () => {
    const m = await seed('look-keys', { density: 'airy', motion: 'subtle' });
    for (const bad of [
      { density: 'huge' },
      { imageRatio: '16/9' },
      { imageRatio: '1 / 1' },
      { motion: 'wild' },
      { density: 3 },
      { motion: '' },
      { wordmarkSize: 'huge' },
      { overPhotoChrome: 'glass' },
      { receiptStyle: 'thermal' },
      { cardCta: 'slab' },
      { cardHover: 'bounce' },
      { cardBadge: 'red' },
    ]) {
      const res = await putTheme(m, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await row(m)).theme).toEqual({ density: 'airy', motion: 'subtle' });
    const good = await putTheme(m, { density: 'compact', imageRatio: '3/4', motion: null });
    expect(good.status, good.text).toBe(200);
    expect((await row(m)).theme).toEqual({ density: 'compact', imageRatio: '3/4' });
    const ui = await putTheme(m, {
      wordmarkSize: 'lg',
      overPhotoChrome: 'bare',
      receiptStyle: null,
    });
    expect(ui.status, ui.text).toBe(200);
    expect((await row(m)).theme).toEqual({
      density: 'compact',
      imageRatio: '3/4',
      wordmarkSize: 'lg',
      overPhotoChrome: 'bare',
    });
    const card = await putTheme(m, { cardCta: 'quiet', cardHover: 'lift', cardBadge: 'accent' });
    expect(card.status, card.text).toBe(200);
    expect((await row(m)).theme).toMatchObject({
      cardCta: 'quiet',
      cardHover: 'lift',
      cardBadge: 'accent',
    });
  });

  it('unknown look: 400 INVALID_LOOK and the store is unchanged', async () => {
    const m = await seed('bad', { primaryColor: 'X' });
    const res = await put(m, { lookId: 'nope.nothing', design: 'reset' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('INVALID_LOOK');
    expect(await row(m)).toMatchObject({
      look: null,
      template: 'dahab',
      theme: { primaryColor: 'X' },
    });
  });

  it('empty store: the look family is PUBLISHED as the home page', async () => {
    const m = await seed('empty');
    const res = await ok(m, PLAIN, 'keep');
    expect(res.json.data.builder).toBe('published');
    const r = await revs(m);
    expect(r.filter(x => x.status === 'published')).toHaveLength(1);
    expect(r.filter(x => x.status === 'draft')).toHaveLength(0);
    // LOOKS-15: derived for the NEW skin + look, so no skin card shape or aspect is baked into the document
    const doc = (await docOf(m, 'published')).document;
    const published = definitionToLayout(doc as Parameters<typeof definitionToLayout>[0]);
    expect(published.productCardDefaults?.cardShape).toBeUndefined();
    expect(published.productCardDefaults?.cardAspect).toBeUndefined();
    for (const s of doc.sections.filter(x => x.type === 'product-carousel'))
      expect(s.settings.cardShape, s.type).toBeUndefined();
  });

  for (const id of ['souq.catalogue', 'souq.night', 'souq.showroom'])
    it(`Souq ${id} on an empty store: the souq skin + look are set and a home revision is written`, async () => {
      const m = await seed(`mix-${id.split('.')[1]}`);
      await ok(m, id, 'keep');
      expect(await row(m)).toMatchObject({ look: id, template: 'souq' });
      const r = await revs(m);
      expect(r.length).toBeGreaterThan(0);
      const mixTypes = new Set(getLook(id)!.sections!.map(x => x.type));
      for (const s of r.at(-1)!.document.sections) expect(mixTypes.has(s.type), s.type).toBe(true);
    });

  it('store with a published revision: a DRAFT is created and published is untouched', async () => {
    const m = await seed('pub');
    await ok(m, PLAIN, 'keep');
    const published = (await revs(m)).find(r => r.status === 'published')!;
    const res = await ok(m, 'qamar.vitrine', 'keep');
    expect(res.json.data.builder).toBe('draft');
    const after = await revs(m);
    expect(after.find(r => r.status === 'published')).toEqual(published);
    expect(after.filter(r => r.status === 'draft')).toHaveLength(1);
  });

  describe('look switch design keys', () => {
    it('Atelier -> the REAL Vitrine mix: bands, one quote and the frame line pass the draft validation', async () => {
      const v = await seed('vitrine-real');
      await ok(v, 'qamar.atelier');
      await ok(v, 'qamar.vitrine');
      const draft = (await docOf(v, 'draft')).document;
      expect(draft.appliedLook).toBe('qamar.vitrine');
      expect(sec(draft, 'hero')).toMatchObject({ presentation: 'framed', frame: 'line' });
      expect(sec(draft, 'collection-list')).toMatchObject({
        tileShape: 'band',
        headingAr: 'تسوّق حسب المناسبة',
      });
      expect(sec(draft, 'testimonials')?.layout).toBe('single');
      // content seeded by Atelier is kept (B1-3): only design keys follow Vitrine
      expect(sec(draft, 'featured-collection')).toMatchObject({
        headingAr: 'وصل حديثًا',
        columns: 4,
        mobileColumns: 2,
      });
      expect((await row(v)).look).toBe('qamar.vitrine');
    });

    it('a look-owned key returns to the skin default when the next look does not set it (Lookbook -> Vitrine)', async () => {
      const a = await seed('mixa');
      await ok(a, PLAIN);
      await ok(a, 'qamar.lookbook');
      const onLookbook = (await docOf(a, 'draft')).document;
      expect(onLookbook.appliedLook).toBe('qamar.lookbook');
      const lookbookCols = getLook('qamar.lookbook')!.sections!.find(
        s => s.type === 'category-grid'
      )?.design?.desktopColumns;
      if (lookbookCols !== undefined)
        expect(sec(onLookbook, 'category-grid')?.desktopColumns).toBe(lookbookCols);
      await ok(a, 'qamar.vitrine');
      const onVitrine = (await docOf(a, 'draft')).document;
      expect(onVitrine.appliedLook).toBe('qamar.vitrine');
      expect(sec(onVitrine, 'hero')?.presentation).toBe('framed'); // Vitrine's own hero design
    });

    it('keep: a hand-set hero presentation survives the switch', async () => {
      const b = await seed('mixb');
      await ok(b, 'souq.catalogue'); // fresh store: published
      await ok(b, 'qamar.atelier'); // draft, baseline hero presentation full-bleed
      const draft = await docOf(b, 'draft');
      const edited = {
        ...draft.document,
        sections: draft.document.sections.map(x =>
          x.type === 'hero' ? { ...x, settings: { ...x.settings, presentation: 'framed' } } : x
        ),
      };
      const saved = await call(`/admin/stores/${b.storeId}/builder/pages/home/draft`, {
        method: 'PUT',
        token: b.token,
        body: { baseRev: draft.rev, definition: edited },
      });
      expect(saved.status, saved.text).toBe(200);
      await ok(b, 'qamar.lookbook'); // Lookbook sets collage: the hand-set value differs from the baseline, so it is kept
      expect(sec((await docOf(b, 'draft')).document, 'hero')?.presentation).toBe('framed');
    });

    it("A -> B with B's draft discarded, then B -> C: the published document's appliedLook is the baseline", async () => {
      const c = await seed('mixc');
      await ok(c, 'qamar.lookbook'); // fresh store: published, composed by Lookbook
      expect((await docOf(c, 'published')).document.appliedLook).toBe('qamar.lookbook');
      await ok(c, 'qamar.atelier'); // draft only; the store row now says Atelier
      await doDeleteMany(c.storeId, 'StorePageRevision', { storeId: c.storeId, status: 'draft' });
      await ok(c, 'qamar.vitrine');
      const onVitrine = (await docOf(c, 'draft')).document;
      expect(onVitrine.appliedLook).toBe('qamar.vitrine');
      expect((await docOf(c, 'published')).document.appliedLook).toBe('qamar.lookbook'); // a switch never touches the published page
    });
  });

  it('legacy store with customised layout_settings and no builder revision: DRAFT only, layout untouched', async () => {
    const layout = {
      brandStory: { enabled: true, titleEn: 'Our story', image: 'https://pub-x.r2.dev/story.jpg' },
    };
    const m = await seed('legacy-layout', {}, layout);
    const before = (await doStoreRecord(m.storeId, ['layoutSettings'])).layoutSettings;
    const res = await ok(m, PLAIN, 'keep');
    expect(res.json.data.builder).toBe('draft');
    const after = (await doStoreRecord(m.storeId, ['layoutSettings'])).layoutSettings;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect((await revs(m)).map(r => r.status)).toEqual(['draft']);
  });

  it("reset strips look keys from a pending draft's theme patch", async () => {
    const m = await seed('draft-theme', { primaryColor: 'X' });
    await ok(m, PLAIN, 'keep');
    const pub = await docOf(m, 'published');
    await doCreate(m.storeId, 'StorePageRevision', {
      storeId: m.storeId,
      pageKey: 'home',
      rev: pub.rev + 1,
      status: 'draft',
      schemaVersion: pub.schemaVersion,
      document: { ...pub.document, theme: { primaryColor: '#112233' } },
      docBytes: 10,
      baseRev: pub.rev,
    });
    await ok(m, PLAIN, 'reset');
    expect((await docOf(m, 'draft')).document.theme?.primaryColor).toBeUndefined();
  });

  it('keeps createdBy on the revision it writes', async () => {
    const m = await seed('actor');
    await ok(m, PLAIN, 'keep');
    const r = (await revs(m))[0]!;
    expect(r.createdBy).toBeTruthy();
    expect(r.createdBy).toBe(m.sub);
  });

  it("another merchant's store is refused and not modified", async () => {
    const a = await seed('own');
    const b = await seed('intruder');
    const res = await put(a, { lookId: PLAIN, design: 'reset' }, b.token);
    expect([403, 404]).toContain(res.status);
    expect((await row(a)).look).toBeNull();
    expect(await revs(a)).toHaveLength(0);
  });

  it('PUT /template refuses a bare legacy template and leaves the look alone (#111)', async () => {
    const m = await seed('legacy');
    await put(m, { lookId: PLAIN, design: 'keep' });
    expect((await row(m)).look).toBe(PLAIN);
    const res = await call(`/stores/${m.storeId}/template`, {
      method: 'PUT',
      token: m.token,
      body: { template: RETIRED_TEMPLATES[1] },
    });
    expect(res.status, res.text).toBe(400);
    expect(res.json.error.code).toBe('TEMPLATE_RETIRED');
    expect(await row(m)).toMatchObject({ look: PLAIN, template: getLook(PLAIN)!.skin });
  });

  describe('Jasmine mixes (real, Phase B3)', () => {
    it('Apothecary -> Bloom -> Clinic -> Apothecary: the store lands on the jasmine skin, the mix follows, no design leaks', async () => {
      const m = await seed('jasmine-cycle');
      await ok(m, 'jasmine.apothecary');
      expect(await row(m)).toMatchObject({ look: 'jasmine.apothecary', template: 'jasmine' });
      let doc = await newest(m);
      expect(doc.appliedLook).toBe('jasmine.apothecary');
      expect(sec(doc, 'category-grid')).toMatchObject({ source: 'tags', layout: 'chips' });
      expect(sec(doc, 'featured-collection')?.bgColor).toBe('token:inverse');

      await ok(m, 'jasmine.bloom');
      doc = await newest(m);
      expect(sec(doc, 'category-grid')).toMatchObject({ layout: 'rail' });
      expect(sec(doc, 'category-grid')?.source).not.toBe('tags');
      expect(sec(doc, 'featured-collection')?.bgColor).not.toBe('token:inverse');
      expect(sec(doc, 'hero')?.presentation).toBe('framed');

      await ok(m, 'jasmine.clinic');
      doc = await newest(m);
      expect(doc.sections.map(x => x.type).slice(0, 3)).toEqual([
        'category-grid',
        'product-spotlight',
        'steps',
      ]);
      expect(sec(doc, 'category-grid')).toMatchObject({ source: 'tags', layout: 'chips' });
      expect((doc.sections.find(x => x.type === 'steps')?.blocks ?? []).length).toBe(3);
      const types = doc.sections.map(x => x.type);
      expect(types[types.indexOf('featured-collection') + 1]).toBe('key-ingredients');
      expect(await row(m)).toMatchObject({ look: 'jasmine.clinic', template: 'jasmine' });

      await ok(m, 'jasmine.apothecary');
      doc = await newest(m);
      expect(sec(doc, 'featured-collection')?.bgColor).toBe('token:inverse');
      expect((doc.sections.find(x => x.type === 'steps')?.blocks ?? []).length).toBe(3);
      // an UNTOUCHED section the outgoing look seeded leaves the DRAFT when the incoming look does not use it (B1-45);
      // the PUBLISHED page is never touched by a switch
      await ok(m, 'jasmine.bloom');
      doc = await newest(m);
      expect(doc.sections.some(x => x.type === 'steps')).toBe(false);
      const published = (await docOf(m, 'published')).document;
      expect(published.appliedLook).toBe('jasmine.apothecary');
      expect(published.sections.some(x => x.type === 'steps')).toBe(true);
    });

    it('Souq <-> Jasmine and Qamar <-> Jasmine switches keep the skin and the look in step', async () => {
      const m = await seed('jasmine-cross');
      await ok(m, 'souq.night');
      expect(await row(m)).toMatchObject({ look: 'souq.night', template: 'souq' });
      await ok(m, 'jasmine.bloom');
      expect(await row(m)).toMatchObject({ look: 'jasmine.bloom', template: 'jasmine' });
      await ok(m, 'qamar.atelier');
      expect(await row(m)).toMatchObject({ look: 'qamar.atelier', template: 'qamar' });
      await ok(m, 'jasmine.clinic');
      expect(await row(m)).toMatchObject({ look: 'jasmine.clinic', template: 'jasmine' });
      expect(sec(await newest(m), 'category-grid')).toMatchObject({
        source: 'tags',
        layout: 'chips',
      });
    });
  });

  describe('Lamma mixes (real, Phase B4)', () => {
    it('Table -> Notebook -> Market -> Table: the store lands on the lamma skin, the mix follows, no design leaks', async () => {
      const m = await seed('lamma-cycle');
      await ok(m, 'lamma.table');
      expect(await row(m)).toMatchObject({ look: 'lamma.table', template: 'lamma' });
      let doc = await newest(m);
      expect(doc.appliedLook).toBe('lamma.table');
      expect(doc.sections.map(x => x.type).slice(0, 5)).toEqual([
        'hero',
        'product-carousel',
        'featured-collection',
        'kitchen-days',
        'maker-profile',
      ]);
      expect(sec(doc, 'featured-collection')).toMatchObject({ layout: 'menu', tabs: 'categories' });
      expect(sec(doc, 'maker-profile')?.variant).toBe('strip');

      await ok(m, 'lamma.notebook');
      doc = await newest(m);
      expect(sec(doc, 'maker-profile')?.variant).toBe('lead');
      expect(doc.sections.filter(x => x.type === 'kitchen-days')).toHaveLength(1);
      expect(sec(doc, 'featured-collection')?.layout).not.toBe('menu');
      expect(sec(doc, 'featured-collection')).toMatchObject({
        bgColor: 'token:inverse',
        columns: 2,
      });

      await ok(m, 'lamma.market');
      doc = await newest(m);
      expect(doc.sections.filter(x => x.type === 'kitchen-days')).toHaveLength(1);
      expect(sec(doc, 'category-grid')).toMatchObject({
        layout: 'tiles',
        tint: 'aisles',
        mobileColumns: 3,
      });
      expect(sec(doc, 'featured-collection')?.bgColor).not.toBe('token:inverse');
      expect(await row(m)).toMatchObject({ look: 'lamma.market', template: 'lamma' });

      await ok(m, 'lamma.table');
      doc = await newest(m);
      expect(sec(doc, 'featured-collection')).toMatchObject({ layout: 'menu' });
      expect(sec(doc, 'category-grid')?.tint).not.toBe('aisles');
    });

    it('Souq <-> Lamma and Qamar <-> Lamma switches keep the skin and the look in step', async () => {
      const m = await seed('lamma-cross');
      await ok(m, 'souq.night');
      await ok(m, 'lamma.market');
      expect(await row(m)).toMatchObject({ look: 'lamma.market', template: 'lamma' });
      await ok(m, 'qamar.atelier');
      expect(await row(m)).toMatchObject({ look: 'qamar.atelier', template: 'qamar' });
      await ok(m, 'lamma.notebook');
      expect(await row(m)).toMatchObject({ look: 'lamma.notebook', template: 'lamma' });
      expect(sec(await newest(m), 'maker-profile')?.variant).toBe('lead');
    });
  });

  it('PUT /theme with a null value removes that key', async () => {
    const m = await seed('null', { accentColor: 'Y', fontFamily: 'Cairo' });
    const res = await putTheme(m, { accentColor: null });
    expect(res.status, res.text).toBe(200);
    expect((await row(m)).theme).toEqual({ fontFamily: 'Cairo' });
  });
});
