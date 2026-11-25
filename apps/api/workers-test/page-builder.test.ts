/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import {
  applyTemplateFamily,
  layoutToDefinition,
  pageDefinitionSchema,
  reduceDocument,
  resolveLayoutSettings,
  TEMPLATE_FAMILIES,
  type PageDefinition,
} from '@ebda/shared';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';
import { doCreate, doDeleteMany, doRead, doSetStoreFields, doStoreRecord } from './do-read';

// Ported from tests/integration/page-builder.test.ts (Postgres, strict RLS, express + service calls) to the built Worker + StoreDO, over HTTP:
// GET/PUT draft/POST publish/GET revisions/POST rollback on /admin/stores/:id/builder/pages/home, the legacy PUT /admin/stores/:id/layout,
// the public /public/stores/:id/layout and the revision rows read from the StoreDO. Same assertions: rev flow + 409/422/404, parallel writers
// (exactly one wins), cross-store refusal (403) + REF_NOT_FOUND warnings, the legacy PUT writes a revision and rebases the draft, an
// out-of-band layout write wins over a stale published document, document-only sections survive the legacy save, the publish-readiness
// gates (MISSING_IMAGE / PLACEHOLDER_COPY on publish AND rollback, hidden sections exempt, legacy PUT refuses imageless slides),
// BUILDER-PUBLISH-1 (the storefront route serves the published document per template family), the draft theme switch and hero video.
// Not ported (Postgres-only): the partial-unique / CHECK constraints on store_page_revisions and the FK cascade on store delete, strict RLS raw SQL
// (the DO is one store per Durable Object; cross-store refusal is asserted on the HTTP routes and the DO-held rows below).
const HOME = 'home';
const docFor = (raw: unknown): PageDefinition =>
  layoutToDefinition(resolveLayoutSettings(raw, 'qamar'));
const withRealCopy = (doc: PageDefinition): PageDefinition => ({
  ...doc,
  sections: doc.sections.map(n =>
    n.type === 'image-text'
      ? {
          ...n,
          settings: {
            ...n.settings,
            body: 'Handmade candles poured in small batches in Cairo.',
            bodyAr: 'شموع يدوية بنصبّها على دفعات صغيرة في القاهرة.',
          },
        }
      : n
  ),
});
const bp = (m: Merchant, tail = '', kind = HOME) =>
  `/admin/stores/${m.storeId}/builder/pages/${kind}${tail}`;
const state = async (m: Merchant) => {
  const r = await call(bp(m), { token: m.token });
  expect(r.status, r.text).toBe(200);
  return r.json.data;
};
const save = (m: Merchant, baseRev: number, definition: unknown) =>
  call(bp(m, '/draft'), { method: 'PUT', token: m.token, body: { baseRev, definition } });
const publish = (m: Merchant, baseRev: number) =>
  call(bp(m, '/publish'), { method: 'POST', token: m.token, body: { baseRev } });
const rollback = (m: Merchant, targetRev: number, baseRev: number) =>
  call(bp(m, '/rollback'), { method: 'POST', token: m.token, body: { targetRev, baseRev } });
const revRows = (m: Merchant) =>
  doRead<{ rev: number; status: string; document: unknown; storeId: string }>(
    m.storeId,
    'StorePageRevision',
    { where: { storeId: m.storeId }, orderBy: { rev: 'asc' } }
  );
const layoutOf = async (m: Merchant) =>
  (await doStoreRecord(m.storeId, ['layoutSettings'])).layoutSettings as Record<string, any>;
const publicLayout = (m: Merchant) => call(`/public/stores/${m.storeId}/layout`);
const errCodes = (r: { json: any }) =>
  (r.json?.error?.details?.errors ?? r.json?.error?.errors ?? []).map(
    (e: { code: string }) => e.code
  );
// Onboarding publishes the starter home as rev 1; the original suite starts from a store that never had a document ("nothing to backfill"),
// so each fixture store's page revisions are cleared and the page re-opens from layout_settings at rev 0.
const fresh = async (label: string) => {
  const m = await bootstrapMerchant(label, { look: false });
  await doDeleteMany(m.storeId, 'StorePageRevision', { storeId: m.storeId });
  return m;
};
const mkProduct = async (m: Merchant) => {
  const r = await call(`/stores/${m.storeId}/products`, {
    method: 'POST',
    token: m.token,
    body: { name: `pb ${crypto.randomUUID().slice(0, 6)}`, price: 5000, status: 'active' },
  });
  expect(r.status, r.text).toBe(201);
  return (r.json.data.product ?? r.json.data).id as string;
};

describe('visual builder page documents on the Worker', () => {
  let A: Merchant;
  let B: Merchant;
  beforeAll(async () => {
    A = await fresh('pb-a');
    B = await fresh('pb-b');
  }, 120_000);

  describe('draft -> publish -> revisions -> rollback (one store, in order)', () => {
    let F: Merchant;
    beforeAll(async () => {
      F = await fresh('pb-flow');
    }, 60_000);

    it('a fresh page opens at rev 0 from layout_settings (nothing to backfill)', async () => {
      const st = await state(F);
      expect(st).toMatchObject({ rev: 0, source: 'layout', draftRev: null, publishedRev: null });
      const rec = await doStoreRecord(F.storeId, ['layoutSettings', 'template', 'look']);
      expect(st.definition).toEqual(
        layoutToDefinition(resolveLayoutSettings(rec.layoutSettings, rec.template, rec.look))
      );
    });

    it('save draft: rev 1, invisible to the public read, layout_settings untouched', async () => {
      const before = await layoutOf(F);
      const pubBefore = await publicLayout(F);
      const r = await save(F, 0, docFor({ newArrivals: { enabled: false, limit: 4 } }));
      expect(r.status, r.text).toBe(200);
      expect(r.json.data.rev).toBe(1);
      expect(await layoutOf(F)).toEqual(before);
      const pub = await publicLayout(F);
      expect(pub.json.data.rev).toBeNull();
      expect(pub.json.data.definition).toEqual(pubBefore.json.data.definition); // the draft never reaches the public read
      expect(await state(F)).toMatchObject({ rev: 1, source: 'draft', draftRev: 1 });
    });

    it('a stale baseRev gets 409 REV_CONFLICT with the latest document, and writes nothing', async () => {
      const r = await save(F, 0, docFor({}));
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('REV_CONFLICT');
      expect(r.json.error.details.latest).toMatchObject({ rev: 1, source: 'draft' });
      expect(await revRows(F)).toHaveLength(1);
    });

    it('an invalid document gets 422 with JSON-pointer errors, and writes nothing', async () => {
      const doc = docFor({});
      doc.sections.push({
        id: 'evil',
        type: 'product-carousel',
        settings: { id: 'e', productSource: 'featured', title: 'x', bgColor: 'javascript:1' },
      });
      const r = await save(F, 1, doc);
      expect(r.status).toBe(422);
      expect(r.json.error.code).toBe('INVALID_DEFINITION');
      expect(
        r.json.error.details.errors.some((e: { path: string }) => e.path.includes('bgColor'))
      ).toBe(true);
      expect(await revRows(F)).toHaveLength(1);
    });

    it('publish: promotes the draft, back-writes layout_settings, becomes the public document', async () => {
      const r = await publish(F, 1);
      expect(r.status, r.text).toBe(200);
      expect(r.json.data.rev).toBe(1);
      expect((await layoutOf(F)).newArrivals.enabled).toBe(false);
      const pub = await publicLayout(F);
      expect(pub.json.data.rev).toBe(1);
      expect(
        pub.json.data.definition.sections.find((s: any) => s.type === 'new-arrivals').hidden
      ).toBe(true);
    });

    it('publish with no draft is a 409 NO_DRAFT', async () => {
      const r = await publish(F, 1);
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('NO_DRAFT');
    });

    it('second edit + publish archives rev 1; revisions list newest first with a cursor', async () => {
      expect(
        (await save(F, 1, docFor({ newArrivals: { enabled: true, limit: 9 } }))).json.data.rev
      ).toBe(2);
      expect((await publish(F, 2)).status).toBe(200);
      const p1 = await call(bp(F, '/revisions?limit=1'), { token: F.token });
      expect(p1.status, p1.text).toBe(200);
      expect(p1.json.data.revisions.map((r: any) => [r.rev, r.status])).toEqual([[2, 'published']]);
      expect(p1.json.data.nextCursor).toBe(2);
      const p2 = await call(bp(F, '/revisions?limit=1&cursor=2'), { token: F.token });
      expect(p2.json.data.revisions.map((r: any) => [r.rev, r.status])).toEqual([[1, 'archived']]);
      expect(p2.json.data.nextCursor).toBeNull();
      expect(p1.json.data.revisions[0].document).toBeUndefined();
    });

    it('rollback to rev 1 publishes a NEW rev with rev 1 content; history is never rewritten', async () => {
      // a working draft exists when rolling back: it is superseded, and reported
      expect((await save(F, 2, docFor({ bestSellers: { enabled: false, limit: 2 } }))).status).toBe(
        200
      );
      const r = await rollback(F, 1, 3);
      expect(r.status, r.text).toBe(200);
      expect(r.json.data).toMatchObject({ rev: 4, discardedDraftRev: 3 });
      expect((await layoutOf(F)).newArrivals.enabled).toBe(false);
      const rows = await revRows(F);
      expect(rows.map(x => [x.rev, x.status])).toEqual([
        [1, 'archived'],
        [2, 'archived'],
        [3, 'archived'],
        [4, 'published'],
      ]);
      expect(rows[3]!.document).toEqual(rows[0]!.document);
    });

    it('rollback to a rev that does not exist is a 404; a stale baseRev a 409', async () => {
      expect((await rollback(F, 99, 4)).status).toBe(404);
      expect((await rollback(F, 2, 3)).status).toBe(409);
    });
  });

  describe('optimistic concurrency under parallel requests', () => {
    it('5 editors save on the same baseRev: exactly one wins, four get 409, no lost or duplicated rows', async () => {
      const m = await fresh('pb-race-save');
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          save(m, 0, docFor({ newArrivals: { enabled: true, limit: i + 1 } }))
        )
      );
      expect(results.filter(r => r.status === 200)).toHaveLength(1);
      expect(results.filter(r => r.status !== 200).map(r => r.status)).toEqual([
        409, 409, 409, 409,
      ]);
      expect((await revRows(m)).map(r => [r.rev, r.status])).toEqual([[1, 'draft']]);
      const round2 = await Promise.all(Array.from({ length: 4 }, () => save(m, 1, docFor({}))));
      expect(round2.filter(r => r.status === 200)).toHaveLength(1);
      expect((await revRows(m)).map(r => r.rev)).toEqual([2]);
    });

    it('3 editors publish the same draft at once: exactly one publish, one published row', async () => {
      const m = await fresh('pb-race-pub');
      expect((await save(m, 0, docFor({}))).status).toBe(200);
      const results = await Promise.all(Array.from({ length: 3 }, () => publish(m, 1)));
      expect(results.filter(r => r.status === 200)).toHaveLength(1);
      expect((await revRows(m)).filter(r => r.status === 'published')).toHaveLength(1);
    });

    it('a legacy layout PUT publishes a revision and rebases the pending draft above it; a stale-base save gets 409', async () => {
      const m = await fresh('pb-legacy');
      expect((await save(m, 0, docFor({}))).status).toBe(200);
      const put = await call(`/admin/stores/${m.storeId}/layout`, {
        method: 'PUT',
        token: m.token,
        body: { hero: { enabled: false, mode: 'single', autoplayMs: 5000, slides: [] } },
      });
      expect(put.status, put.text).toBe(200);
      expect((await revRows(m)).map(r => [r.rev, r.status])).toEqual([
        [2, 'published'],
        [3, 'draft'],
      ]);
      expect((await save(m, 1, docFor({}))).status).toBe(409);
      expect((await save(m, 3, docFor({}))).status).toBe(200);
    });
  });

  describe('tenant isolation', () => {
    it("store B's owner cannot read, write or publish store A's pages, and A's revisions stay A's", async () => {
      expect((await save(A, 0, docFor({}))).status).toBe(200);
      expect((await call(bp(A), { token: B.token })).status).toBe(403);
      const w = await call(bp(A, '/draft'), {
        method: 'PUT',
        token: B.token,
        body: { baseRev: 1, definition: docFor({}) },
      });
      expect(w.status).toBe(403);
      expect(
        (await call(bp(A, '/publish'), { method: 'POST', token: B.token, body: { baseRev: 1 } }))
          .status
      ).toBe(403);
      expect((await call(bp(A, '/revisions'), { token: B.token })).status).toBe(403);
      expect((await revRows(A)).map(r => [r.rev, r.status])).toEqual([[1, 'draft']]);
      expect(await revRows(B)).toHaveLength(0);
      // the DO holds only its own store: asking A's DO for B's rows finds none
      expect(
        await doRead(A.storeId, 'StorePageRevision', { where: { storeId: B.storeId } })
      ).toHaveLength(0);
      expect((await state(A)).draftRev).toBe(1); // control: A sees its own
    });

    it('a product id from another store is reported as not found (warning), never resolved', async () => {
      const productA = await mkProduct(A);
      const productB = await mkProduct(B);
      const doc = docFor({});
      doc.sections.push({
        id: 'extra-m',
        type: 'product-carousel',
        settings: { id: 'm', productSource: 'manual', manualProductIds: [productA, productB] },
      });
      const head = (await state(A)).rev;
      const r = await save(A, head, doc);
      expect(r.status, r.text).toBe(200);
      const warned = r.json.data.warnings as Array<{ code: string; path: string }>;
      expect(warned.map(w => w.code)).toEqual(['REF_NOT_FOUND']);
      expect(warned[0]!.path).toMatch(/manualProductIds\/1$/);
    });

    it('a shop-the-look piece from another store gets the same REF_NOT_FOUND warning and is never served (C11)', async () => {
      const a2 = await mkProduct(A);
      const b2 = await mkProduct(B);
      const doc = docFor({});
      doc.sections.push({
        id: 'stl',
        type: 'shop-the-look',
        settings: { headingAr: 'شوف اللوك كامل' },
        blocks: [{ id: 'look-1', type: 'look', settings: { productIds: [a2, b2] } }],
      });
      const head = (await state(A)).rev;
      const r = await save(A, head, doc);
      expect(r.status, r.text).toBe(200);
      expect(r.json.data.warnings.map((w: any) => [w.code, w.path])).toEqual([
        ['REF_NOT_FOUND', `/sections/${doc.sections.length - 1}/blocks/0/settings/productIds/1`],
      ]);
      // the storefront loads look pieces with the store-scoped ids query: another store's active product never comes back
      const listed = await call(`/public/products?ids=${a2},${b2}&limit=50`, {
        headers: { 'x-store-id': A.storeId },
      });
      expect(listed.status, listed.text).toBe(200);
      const got = JSON.stringify(listed.json);
      expect(got).toContain(a2);
      expect(got).not.toContain(b2);
    });
  });

  describe('integrity guards', () => {
    it('an out-of-band layout_settings write wins over a stale published document', async () => {
      const m = await fresh('pb-drift');
      expect((await save(m, 0, docFor({}))).status).toBe(200);
      expect((await publish(m, 1)).status).toBe(200);
      await doSetStoreFields(m.storeId, {
        layoutSettings: { ...(await layoutOf(m)), bestSellers: { enabled: false, limit: 3 } },
      });
      const pub = await publicLayout(m);
      expect(pub.status, pub.text).toBe(200);
      expect(
        pub.json.data.definition.sections.find((s: any) => s.type === 'best-sellers').hidden
      ).toBe(true);
    });
  });

  describe('document-only sections survive the legacy save paths', () => {
    it('a legacy layout PUT keeps an image-text section the new builder added', async () => {
      const m = await fresh('pb-doconly');
      const withImage = withRealCopy(
        reduceDocument(docFor({}), {
          type: 'addSection',
          list: 'template',
          sectionType: 'image-text',
          presetIndex: 0,
          index: 1,
        }).doc
      );
      expect((await save(m, 0, withImage)).status).toBe(200);
      expect((await publish(m, 1)).status).toBe(200);
      const put = await call(`/admin/stores/${m.storeId}/layout`, {
        method: 'PUT',
        token: m.token,
        body: { bestSellers: { enabled: false, limit: 2 } },
      });
      expect(put.status, put.text).toBe(200);
      const pub = (await revRows(m)).find(r => r.status === 'published')!;
      expect((pub.document as PageDefinition).sections.map(s => s.id)[1]).toBe('image-text-1');
      const served = await publicLayout(m);
      expect(served.json.data.definition.sections.some((s: any) => s.type === 'image-text')).toBe(
        true
      );
    });
  });

  describe('publish readiness: an imageless hero slide saves as a draft but cannot publish', () => {
    const imageless = () =>
      reduceDocument(docFor({}), { type: 'addBlock', sectionId: 'hero', blockType: 'slide' }).doc;

    it('saveDraft accepts a hero slide with no image (autosave must not block)', async () => {
      const m = await fresh('pb-noimg-draft');
      const r = await save(m, 0, imageless());
      expect(r.status, r.text).toBe(200);
      expect(r.json.data.rev).toBe(1);
    });

    it('publish refuses it (422 MISSING_IMAGE), then succeeds once an image is added', async () => {
      const m = await fresh('pb-noimg-publish');
      const doc = imageless();
      await save(m, 0, doc);
      const blocked = await publish(m, 1);
      expect(blocked.status).toBe(422);
      expect(blocked.json.error.code).toBe('INVALID_DEFINITION');
      expect(errCodes(blocked)).toContain('MISSING_IMAGE');
      expect((await revRows(m)).filter(r => r.status === 'published')).toHaveLength(0);
      const fixed: PageDefinition = {
        ...doc,
        sections: doc.sections.map(s =>
          s.type === 'hero'
            ? {
                ...s,
                blocks: (s.blocks ?? []).map(b => ({
                  ...b,
                  settings: { ...b.settings, image: '/fixed-slide.jpg' },
                })),
              }
            : s
        ),
      };
      await save(m, 1, fixed);
      const ok = await publish(m, 2);
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json.data.rev).toBe(2);
    });

    it('the legacy layout PUT path (no separate draft state) also refuses an imageless slide', async () => {
      const m = await fresh('pb-noimg-legacy');
      const put = await call(`/admin/stores/${m.storeId}/layout`, {
        method: 'PUT',
        token: m.token,
        body: {
          hero: { enabled: true, mode: 'single', autoplayMs: 5000, slides: [{ image: '' }] },
        },
      });
      expect(put.status, put.text).toBe(422);
      expect(put.json.error.errors.some((e: { code: string }) => e.code === 'MISSING_IMAGE')).toBe(
        true
      );
      expect((await revRows(m)).filter(r => r.status === 'published')).toHaveLength(0);
    });

    it('rollback refuses to republish an ARCHIVED revision that predates this gate', async () => {
      const m = await fresh('pb-noimg-rollback');
      const good = docFor({});
      const bad: PageDefinition = {
        ...good,
        sections: good.sections.map(s =>
          s.type === 'hero'
            ? {
                ...s,
                blocks: [...(s.blocks ?? []), { id: 'slide-bad', type: 'slide', settings: {} }],
              }
            : s
        ),
      };
      // a row from before the gate existed: written into the DO directly, as no route can make it now
      await doCreate(m.storeId, 'StorePageRevision', {
        storeId: m.storeId,
        pageKey: HOME,
        rev: 1,
        status: 'archived',
        schemaVersion: good.schemaVersion,
        document: bad,
        docBytes: JSON.stringify(bad).length,
        baseRev: 0,
      });
      expect((await save(m, 1, good)).status).toBe(200);
      expect((await publish(m, 2)).status).toBe(200);
      const r = await rollback(m, 1, 2);
      expect(r.status, r.text).toBe(422);
      expect(r.json.error.code).toBe('INVALID_DEFINITION');
      expect(errCodes(r)).toContain('MISSING_IMAGE');
      expect((await revRows(m)).filter(x => x.status === 'published')).toHaveLength(1);
    });
  });

  describe('publish readiness: starter placeholder copy cannot go live', () => {
    const withStarterSection = (): PageDefinition =>
      reduceDocument(docFor({}), {
        type: 'addSection',
        list: 'template',
        sectionType: 'image-text',
        presetIndex: 0,
        index: 1,
      }).doc;

    it('publish refuses starter copy (422 PLACEHOLDER_COPY, bilingual, nothing published), then succeeds once rewritten', async () => {
      const m = await fresh('pb-ph-publish');
      const doc = withStarterSection();
      const saved = await save(m, 0, doc);
      expect(saved.status, saved.text).toBe(200); // drafts may hold it
      const blocked = await publish(m, 1);
      expect(blocked.status).toBe(422);
      expect(errCodes(blocked)).toContain('PLACEHOLDER_COPY');
      const e = blocked.json.error.details.errors[0];
      expect(e.messageEn).toContain('Image with text');
      expect(e.messageAr).toContain('صورة مع نص');
      expect((await revRows(m)).filter(r => r.status === 'published')).toHaveLength(0);
      await save(m, 1, withRealCopy(doc));
      const ok = await publish(m, 2);
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json.data.rev).toBe(2);
    });

    it('a HIDDEN section holding starter copy does not block publish', async () => {
      const m = await fresh('pb-ph-hidden');
      const doc = withStarterSection();
      const hidden = {
        ...doc,
        sections: doc.sections.map(n => (n.type === 'image-text' ? { ...n, hidden: true } : n)),
      };
      await save(m, 0, hidden);
      expect((await publish(m, 1)).status).toBe(200);
    });

    it('rollback refuses to republish an archived revision that holds starter copy', async () => {
      const m = await fresh('pb-ph-rollback');
      const good = docFor({});
      const bad = withStarterSection();
      await doCreate(m.storeId, 'StorePageRevision', {
        storeId: m.storeId,
        pageKey: HOME,
        rev: 1,
        status: 'archived',
        schemaVersion: good.schemaVersion,
        document: bad,
        docBytes: JSON.stringify(bad).length,
        baseRev: 0,
      });
      await save(m, 1, good);
      await publish(m, 2);
      const r = await rollback(m, 1, 2);
      expect(r.status).toBe(422);
      expect(errCodes(r)).toContain('PLACEHOLDER_COPY');
      expect((await revRows(m)).filter(x => x.status === 'published')).toHaveLength(1);
    });

    it("tenant scoping unchanged: store B publishing clean content is unaffected by store A's refusal", async () => {
      const a = await fresh('pb-ph-iso-a');
      const b = await fresh('pb-ph-iso-b');
      await save(a, 0, withStarterSection());
      await save(b, 0, docFor({}));
      expect((await publish(a, 1)).status).toBe(422);
      expect((await publish(b, 1)).status).toBe(200);
    });
  });

  describe('builder publish -> storefront route serves the published document (BUILDER-PUBLISH-1)', () => {
    async function publishAndRead(m: Merchant, edit: (d: PageDefinition) => PageDefinition) {
      const st = await state(m);
      const doc = withRealCopy(edit(st.definition));
      const saved = await save(m, st.rev, doc);
      expect(saved.status, saved.text).toBe(200);
      const pub = await publish(m, saved.json.data.rev);
      expect(pub.status, pub.text).toBe(200);
      const row = (await revRows(m)).find(r => r.status === 'published')!;
      const res = await publicLayout(m);
      expect(res.status, res.text).toBe(200);
      return { res, published: row.document as PageDefinition, rev: pub.json.data.rev as number };
    }

    for (const [i, template] of ['qamar', 'souq', 'dahab'].entries()) {
      it(`${template} store: every template family's storefront render is the published document`, async () => {
        const m = await fresh(`pb-fam${i}`);
        await doSetStoreFields(m.storeId, { template });
        for (const family of TEMPLATE_FAMILIES) {
          const { res, published, rev } = await publishAndRead(m, d =>
            applyTemplateFamily(d, family.id)
          );
          expect(res.json.data.rev, family.id).toBe(rev);
          const parsed = pageDefinitionSchema.safeParse(res.json.data.definition);
          expect(parsed.success, family.id).toBe(true);
          expect(parsed.success && parsed.data).toEqual(published);
        }
      }, 60_000);
    }

    it('an editor-removed section stays removed on the storefront (jasmine store)', async () => {
      const m = await fresh('pb-jasmine');
      await doSetStoreFields(m.storeId, { template: 'jasmine' });
      const { res, published } = await publishAndRead(m, d => {
        const r = reduceDocument(d, { type: 'removeSection', id: 'new-arrivals' });
        expect(r.rejected).toBeUndefined();
        return r.doc;
      });
      expect(published.sections.some(s => s.type === 'new-arrivals')).toBe(false);
      expect(res.json.data.definition).toEqual(published);
    });

    it('a ported product-card switch (showNewBadge) goes draft -> publish -> live store theme', async () => {
      const m = await fresh('pb-cardsw');
      const st = await state(m);
      const doc = withRealCopy({
        ...st.definition,
        theme: { showNewBadge: true, saleBadgeLegacyCorner: true },
      } as PageDefinition);
      const saved = await save(m, 0, doc);
      expect(saved.status, saved.text).toBe(200);
      const before = (await doStoreRecord(m.storeId, ['theme'])).theme as Record<
        string,
        unknown
      > | null;
      expect(before?.showNewBadge).toBeUndefined(); // a draft is invisible to the live theme
      expect((await publish(m, 1)).status).toBe(200);
      expect((await doStoreRecord(m.storeId, ['theme'])).theme).toMatchObject({
        showNewBadge: true,
        saleBadgeLegacyCorner: true,
      });
      expect((await publicLayout(m)).status).toBe(200);
    });

    it('an out-of-band layout_settings write still falls back (the guard still guards)', async () => {
      const m = await fresh('pb-oob');
      await doSetStoreFields(m.storeId, { template: 'souq' });
      await publishAndRead(m, d => applyTemplateFamily(d, 'lamma'));
      const raw = await layoutOf(m);
      await doSetStoreFields(m.storeId, {
        layoutSettings: { ...raw, hero: { ...raw.hero, enabled: false } },
      });
      const res = await publicLayout(m);
      expect(res.json.data.rev).toBe(1);
      expect(res.json.data.definition.sections.find((s: any) => s.type === 'hero').hidden).toBe(
        true
      );
      expect(res.json.data.definition.sections.map((s: any) => s.type)).not.toEqual(
        applyTemplateFamily(
          layoutToDefinition(resolveLayoutSettings({}, 'souq')),
          'lamma'
        ).sections.map(s => s.type)
      );
    });
  });

  describe('hero slide video survives draft -> publish -> public read', () => {
    it('video and videoMobile are not stripped by any layer (the imageMobile trap)', async () => {
      const m = await fresh('pb-herovid');
      const slide = {
        image: 'https://media.ebda.app/s/poster.webp',
        imageMobile: 'https://media.ebda.app/s/poster-m.webp',
        video: 'https://media.ebda.app/s/a.mp4',
        videoMobile: 'https://media.ebda.app/s/a-m.mp4',
      };
      const doc = withRealCopy(
        docFor({ hero: { enabled: true, mode: 'single', autoplayMs: 5000, slides: [slide] } })
      );
      expect((await save(m, 0, doc)).status).toBe(200);
      const pub = await publish(m, 1);
      expect(pub.status, pub.text).toBe(200);
      expect((await layoutOf(m)).hero.slides[0]).toMatchObject({
        video: slide.video,
        videoMobile: slide.videoMobile,
      });
      const read = await publicLayout(m);
      const heroNode = read.json.data.definition.sections.find((s: any) => s.type === 'hero');
      expect(heroNode.blocks[0].settings).toMatchObject({
        video: slide.video,
        videoMobile: slide.videoMobile,
      });
    });

    it('a javascript: video is a 422 on the draft', async () => {
      const m = await fresh('pb-herovidbad');
      const doc = docFor({
        hero: {
          enabled: true,
          mode: 'single',
          autoplayMs: 5000,
          slides: [{ image: '/a.webp', video: 'javascript:alert(1)' }],
        },
      });
      expect((await save(m, 0, doc)).status).toBe(422);
    });
  });
});
