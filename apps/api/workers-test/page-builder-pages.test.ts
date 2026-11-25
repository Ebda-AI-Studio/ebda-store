/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { defaultPageDocument, reduceDocument, SECTION_PAGE_KINDS } from '@ebda/shared';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';
import { doStoreRecord } from './do-read';

// Ported from tests/integration/page-builder-pages.test.ts (Postgres, strict RLS, express + service calls) to the built Worker + StoreDO,
// driven over HTTP: GET/PUT draft/POST publish/POST rollback on /admin/stores/:id/builder/pages/:kind and the public
// /public/stores/:id/pages/:kind. Same assertions: default document at rev 0, a draft is never served publicly, publish never writes the home
// projection, the 422 guards write nothing, rollback republishes as a new rev, one store never sees another's documents, and each
// page writes only the layout keys it owns (Ruling VE-13). Cross-store write: store B's owner is refused (403) on A's builder routes.
let A: Merchant;
let B: Merchant;
const bp = (m: Merchant, kind: string, tail = '') =>
  `/admin/stores/${m.storeId}/builder/pages/${kind}${tail}`;
const pub = (m: Merchant, kind: string) => `/public/stores/${m.storeId}/pages/${kind}`;
const state = async (m: Merchant, kind: string) => {
  const r = await call(bp(m, kind), { token: m.token });
  expect(r.status, r.text).toBe(200);
  return r.json.data;
};
const draft = (m: Merchant, kind: string, baseRev: number, definition: unknown) =>
  call(bp(m, kind, '/draft'), { method: 'PUT', token: m.token, body: { baseRev, definition } });
const publish = (m: Merchant, kind: string, baseRev: number) =>
  call(bp(m, kind, '/publish'), { method: 'POST', token: m.token, body: { baseRev } });
const layoutOf = async (m: Merchant) =>
  (await doStoreRecord(m.storeId, ['layoutSettings'])).layoutSettings as Record<string, any> | null;
const ids = (doc: { sections: Array<{ id: string }> }) => doc.sections.map(s => s.id);

describe('page documents on the Worker', () => {
  beforeAll(async () => {
    A = await bootstrapMerchant('pbp-a', { look: false });
    B = await bootstrapMerchant('pbp-b', { look: false });
  }, 180_000);

  describe('section page documents: default -> draft -> publish -> rollback', () => {
    let layoutBefore: unknown;
    beforeAll(async () => {
      layoutBefore = await layoutOf(A);
    });

    it.each(SECTION_PAGE_KINDS)('%s opens at rev 0 as its default document', async kind => {
      const st = await state(A, kind);
      expect(st).toMatchObject({ rev: 0, source: 'layout', draftRev: null, publishedRev: null });
      expect(st.definition).toEqual(defaultPageDocument(kind));
    });

    it('the public route serves the default before anything is saved, and 404s an unknown page', async () => {
      const res = await call(pub(A, 'product'));
      expect(res.status, res.text).toBe(200);
      expect(res.json.data).toEqual({ definition: defaultPageDocument('product'), rev: null });
      expect(res.headers.get('cache-control')).toContain('s-maxage');
      expect((await call(pub(A, 'home'))).status).toBe(404);
      expect((await call(pub(A, 'checkout'))).status).toBe(404);
      const missing = await call(`/public/stores/${crypto.randomUUID()}/pages/cart`);
      expect(missing.status).toBe(404);
    });

    it('a draft is not served publicly; publishing serves it and does not touch the home projection', async () => {
      const moved = reduceDocument(defaultPageDocument('product'), {
        type: 'moveSection',
        id: 'product-reviews',
        toIndex: 1,
      });
      expect(moved.rejected).toBeUndefined();
      const saved = await draft(A, 'product', 0, moved.doc);
      expect(saved.status, saved.text).toBe(200);
      expect(saved.json.data.rev).toBe(1);
      expect(await state(A, 'product')).toMatchObject({ source: 'draft', rev: 1 });
      const pubBefore = await call(pub(A, 'product'));
      expect(pubBefore.json.data.rev).toBeNull();
      expect(ids(pubBefore.json.data.definition)[1]).toBe('product-faq');

      const p = await publish(A, 'product', 1);
      expect(p.status, p.text).toBe(200);
      expect(p.json.data.rev).toBe(1);
      const live = await call(pub(A, 'product'));
      expect(live.json.data.rev).toBe(1);
      expect(ids(live.json.data.definition)[1]).toBe('product-reviews');
      expect(await layoutOf(A)).toEqual(layoutBefore);
      const cart = await call(pub(A, 'cart'));
      expect(cart.json.data).toEqual({ definition: defaultPageDocument('cart'), rev: null });
    });

    it('refuses a product document with its main section removed or hidden (422), writing nothing', async () => {
      const base = defaultPageDocument('product');
      const noMain = { ...base, sections: base.sections.filter(n => n.id !== 'product-main') };
      const r = await draft(A, 'product', 1, noMain);
      expect(r.status).toBe(422);
      expect(r.json.error.code).toBe('INVALID_DEFINITION');
      const hidden = {
        ...base,
        sections: base.sections.map(n => (n.id === 'product-main' ? { ...n, hidden: true } : n)),
      };
      expect((await draft(A, 'product', 1, hidden)).status).toBe(422);
      expect((await draft(A, 'product', 1, defaultPageDocument('cart'))).status).toBe(422);
      expect((await state(A, 'product')).rev).toBe(1);
    });

    it('rollback republishes an earlier revision as a new one, still without touching the home projection', async () => {
      const cur = await state(A, 'product');
      const next = reduceDocument(cur.definition, {
        type: 'moveSection',
        id: 'product-reviews',
        toIndex: 5,
      }).doc;
      expect((await draft(A, 'product', 1, next)).status).toBe(200);
      expect((await publish(A, 'product', 2)).status).toBe(200);
      const rb = await call(bp(A, 'product', '/rollback'), {
        method: 'POST',
        token: A.token,
        body: { targetRev: 1, baseRev: 2 },
      });
      expect(rb.status, rb.text).toBe(200);
      expect(rb.json.data.rev).toBe(3);
      const live = await call(pub(A, 'product'));
      expect(live.json.data.rev).toBe(3);
      expect(ids(live.json.data.definition)[1]).toBe('product-reviews');
      expect(await layoutOf(A)).toEqual(layoutBefore);
    });

    it('another store never sees these documents and cannot write them', async () => {
      const res = await call(pub(B, 'product'));
      expect(res.json.data).toEqual({ definition: defaultPageDocument('product'), rev: null });
      expect(await state(B, 'product')).toMatchObject({ rev: 0, source: 'layout' });
      const cross = await call(bp(A, 'product', '/draft'), {
        method: 'PUT',
        token: B.token,
        body: { baseRev: 3, definition: defaultPageDocument('product') },
      });
      expect(cross.status).toBe(403);
      expect((await call(bp(A, 'product'), { token: B.token })).status).toBe(403);
      expect((await state(A, 'product')).rev).toBe(3);
    });
  });

  describe('page-type settings (Ruling VE-13): each page writes only the layout keys it owns', () => {
    let C: Merchant;
    beforeAll(async () => {
      C = await bootstrapMerchant('pbp-c', { look: false });
      // seed the page-owned layout keys through the real publish path (home owns sizing; product/cart own theirs)
      const seed = async (kind: string, key: string, path: string, value: unknown) => {
        const st = await state(C, kind);
        const doc = reduceDocument(st.definition, {
          type: 'setSiteSetting',
          key,
          path,
          value,
        } as never);
        expect(doc.rejected).toBeUndefined();
        // the starter home carries a placeholder "Image with text" the publish gate refuses: a merchant would write copy, the test drops it
        const sections =
          kind === 'home' ? doc.doc.sections.filter((_, i) => i !== 4) : doc.doc.sections;
        expect((await draft(C, kind, st.rev, { ...doc.doc, sections })).status).toBe(200);
        const p = await publish(C, kind, st.rev + 1);
        expect(p.status, p.text).toBe(200);
      };
      await seed('product', 'productDetailPage', 'density', 'spacious');
      await seed('product', 'productDetailPage', 'bgColor', '#101010');
      await seed('cart', 'cartPage', 'textScale', 'lg');
      await seed('home', 'sizing', 'heroAspect', '16:9');
    }, 180_000);
    const layoutNow = () => layoutOf(C) as Promise<Record<string, any>>;

    it('a page opens on the live values of its own keys', async () => {
      const st = await state(C, 'product');
      expect(st.definition.siteSettings).toEqual({
        productDetailPage: { density: 'spacious', bgColor: '#101010' },
      });
      expect((await state(C, 'cart')).definition.siteSettings).toEqual({
        cartPage: { textScale: 'lg' },
      });
    });

    it('publishing the product page writes productDetailPage and nothing else', async () => {
      const st = await state(C, 'product');
      const doc = reduceDocument(st.definition, {
        type: 'setSiteSetting',
        key: 'productDetailPage',
        path: 'density',
        value: 'compact',
      });
      expect(doc.rejected).toBeUndefined();
      expect((await draft(C, 'product', st.rev, doc.doc)).status).toBe(200);
      expect((await layoutNow()).productDetailPage.density).toBe('spacious'); // a draft is not live
      expect((await publish(C, 'product', st.rev + 1)).status).toBe(200);
      const after = await layoutNow();
      expect(after.productDetailPage).toEqual({ density: 'compact', bgColor: '#101010' });
      expect(after.cartPage).toEqual({ textScale: 'lg' });
      expect(after.sizing.heroAspect).toBe('16:9');
    });

    it('clearing the last value removes the key; a reorder alone writes no layout key', async () => {
      let st = await state(C, 'cart');
      const cleared = reduceDocument(st.definition, {
        type: 'setSiteSetting',
        key: 'cartPage',
        path: 'textScale',
        value: undefined,
      }).doc;
      expect(cleared.siteSettings).toEqual({});
      expect((await draft(C, 'cart', st.rev, cleared)).status).toBe(200);
      expect((await publish(C, 'cart', st.rev + 1)).status).toBe(200);
      expect('cartPage' in (await layoutNow())).toBe(false);
      st = await state(C, 'cart');
      const reordered = reduceDocument(st.definition, {
        type: 'moveSection',
        id: 'cart-recommendations',
        toIndex: 0,
      }).doc;
      const before = await layoutNow();
      expect((await draft(C, 'cart', st.rev, reordered)).status).toBe(200);
      expect((await publish(C, 'cart', st.rev + 1)).status).toBe(200);
      expect(await layoutNow()).toEqual(before);
    });

    it('a cart document cannot write the home or product keys (422), nor an invalid value', async () => {
      const st = await state(C, 'cart');
      for (const foreign of [
        { sizing: { heroAspect: '4:3' } },
        { productDetailPage: { density: 'compact' } },
        { cartPage: { density: 'huge' } },
      ]) {
        const r = await draft(C, 'cart', st.rev, { ...st.definition, siteSettings: foreign });
        expect(r.status, JSON.stringify(foreign)).toBe(422);
      }
    });

    it("publishing HOME keeps the live value of the other pages' keys, even when its own copy is stale", async () => {
      const st = await state(C, 'home');
      expect(st.definition.siteSettings.productDetailPage).toEqual({
        density: 'compact',
        bgColor: '#101010',
      });
      const stale = {
        ...st.definition,
        siteSettings: {
          ...st.definition.siteSettings,
          productDetailPage: { density: 'spacious' },
          cartPage: { textScale: 'xl' },
          sizing: { heroAspect: '4:3', productImageAspect: '1:1', categoryImageAspect: '1:1' },
        },
      };
      expect((await draft(C, 'home', st.rev, stale)).status).toBe(200);
      expect((await publish(C, 'home', st.rev + 1)).status).toBe(200);
      const after = await layoutNow();
      expect(after.productDetailPage).toEqual({ density: 'compact', bgColor: '#101010' });
      expect('cartPage' in after).toBe(false);
      expect(after.sizing.heroAspect).toBe('4:3');
    });

    it('productsPage.bgColor reaches the PUBLIC storefront layout through the editor save', async () => {
      const st = await state(C, 'collection');
      const edited = reduceDocument(st.definition, {
        type: 'setSiteSetting',
        key: 'productsPage',
        path: 'bgColor',
        value: '#112233',
      });
      expect(edited.rejected).toBeUndefined();
      const saved = await draft(C, 'collection', st.rev, edited.doc);
      expect(saved.status, saved.text).toBe(200);
      const before = await call(`/public/stores/${C.storeId}/layout`);
      expect(before.json.data.layout.productsPage?.bgColor).toBeUndefined();
      expect((await publish(C, 'collection', saved.json.data.rev)).status).toBe(200);
      const after = await call(`/public/stores/${C.storeId}/layout`);
      expect(after.status, after.text).toBe(200);
      expect(after.json.data.layout.productsPage.bgColor).toBe('#112233');
    });
  });
});
