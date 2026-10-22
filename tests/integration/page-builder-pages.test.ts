/**
 * Product / collection / cart page documents (Ruling VE-3 amended, VE-12), against a REAL Postgres on an
 * `ebda_app` login under strict RLS (same harness as page-builder.test.ts).
 *
 * Proves: an unsaved page opens at its default document; draft -> publish -> rollback work for the
 * section pages; publishing one NEVER writes stores.layout_settings (the home projection stays the home
 * page's); the public route serves the default, then the published document, never a draft; one store's
 * page documents are invisible to another; the home document is unaffected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  type AppPrismaClient,
} from '@ebda/database';
import { defaultPageDocument, reduceDocument, SECTION_PAGE_KINDS } from '@ebda/shared';
import publicStoreLayoutRoutes from '../../apps/api/src/routes/public-store-layout.routes';
import {
  getPageState,
  saveDraft,
  publishDraft,
  rollbackToRevision,
} from '../../apps/api/src/services/page-builder.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = `pgk-${crypto.randomUUID().slice(0, 8)}-`;

let owner: AppPrismaClient;
const appUrl = () => {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
};
const makeApp = () => createPrismaClient({ connectionString: appUrl(), max: 2 });
const inStore = <T>(storeId: string, fn: () => Promise<T>): Promise<T> =>
  runWithRequestDb(makeApp, () => runInTenantContext(storeId, fn));

async function freshStore(tag: string): Promise<string> {
  const u = await owner.user.create({
    data: {
      email: `${PREFIX}${tag}-${crypto.randomUUID().slice(0, 6)}@test.com`,
      passwordHash: 'x',
      firstName: tag,
      lastName: 'T',
      role: 'store_admin' as never,
    },
  });
  const s = await owner.store.create({
    data: {
      slug: `${PREFIX}${tag}-${crypto.randomUUID().slice(0, 6)}`,
      name: tag,
      ownerId: u.id,
      template: 'modern',
    },
  });
  return s.id;
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await owner.$executeRawUnsafe(`ALTER ROLE ebda_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
});

afterAll(async () => {
  await owner.$executeRawUnsafe(
    `DELETE FROM public.store_page_revisions WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
  );
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  await owner.$disconnect();
});

const layoutOf = async (storeId: string) =>
  (await owner.store.findUnique({ where: { id: storeId }, select: { layoutSettings: true } }))
    ?.layoutSettings;

describe('section page documents: default -> draft -> publish -> rollback', { retry: 0 }, () => {
  const app = express();
  app.use('/public', publicStoreLayoutRoutes);
  let storeId = '';
  let layoutBefore: unknown;
  beforeAll(async () => {
    storeId = await freshStore('flow');
    layoutBefore = await layoutOf(storeId);
  });

  it.each(SECTION_PAGE_KINDS)('%s opens at rev 0 as its default document', async kind => {
    const st = await inStore(storeId, () => getPageState(storeId, kind));
    expect(st).toMatchObject({ rev: 0, source: 'layout', draftRev: null, publishedRev: null });
    expect(st!.definition).toEqual(defaultPageDocument(kind));
  });

  it('the public route serves the default document before anything is saved, and 404s an unknown page', async () => {
    const res = await request(app).get(`/public/stores/${storeId}/pages/product`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ definition: defaultPageDocument('product'), rev: null });
    expect(res.headers['cache-control']).toContain('s-maxage');
    expect((await request(app).get(`/public/stores/${storeId}/pages/home`)).status).toBe(404);
    expect((await request(app).get(`/public/stores/${storeId}/pages/checkout`)).status).toBe(404);
    const missing = crypto.randomUUID();
    expect((await request(app).get(`/public/stores/${missing}/pages/cart`)).status).toBe(404);
  });

  it('a draft is not served publicly; publishing serves it and does not touch layout_settings', async () => {
    const base = defaultPageDocument('product');
    const moved = reduceDocument(base, { type: 'moveSection', id: 'product-reviews', toIndex: 1 });
    expect(moved.rejected).toBeUndefined();
    const saved = await inStore(storeId, () =>
      saveDraft({
        storeId,
        pageKey: 'product',
        baseRev: 0,
        definition: moved.doc,
        userId: null,
      })
    );
    expect(saved).toMatchObject({ ok: true, value: { rev: 1 } });
    // the draft is the editor's state, the public still gets the default
    const state = await inStore(storeId, () => getPageState(storeId, 'product'));
    expect(state).toMatchObject({ source: 'draft', rev: 1 });
    const pubBefore = await request(app).get(`/public/stores/${storeId}/pages/product`);
    expect(pubBefore.body.data.rev).toBeNull();
    expect(pubBefore.body.data.definition.sections.map((s: { id: string }) => s.id)[1]).toBe(
      'product-faq'
    );

    const pub = await inStore(storeId, () =>
      publishDraft({ storeId, pageKey: 'product', baseRev: 1 })
    );
    expect(pub).toMatchObject({ ok: true, value: { rev: 1 } });
    const live = await request(app).get(`/public/stores/${storeId}/pages/product`);
    expect(live.body.data.rev).toBe(1);
    expect(live.body.data.definition.sections.map((s: { id: string }) => s.id)[1]).toBe(
      'product-reviews'
    );
    // the home projection is the home page's alone
    expect(await layoutOf(storeId)).toEqual(layoutBefore);
    // and the other section pages did not change
    const cart = await request(app).get(`/public/stores/${storeId}/pages/cart`);
    expect(cart.body.data).toEqual({ definition: defaultPageDocument('cart'), rev: null });
  });

  it('the API refuses a product document with its main section removed or hidden (422), writing nothing', async () => {
    const base = defaultPageDocument('product');
    const noMain = { ...base, sections: base.sections.filter(n => n.id !== 'product-main') };
    const r = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: 'product', baseRev: 1, definition: noMain, userId: null })
    );
    expect(r).toMatchObject({ ok: false, status: 422, code: 'INVALID_DEFINITION' });
    const hidden = {
      ...base,
      sections: base.sections.map(n => (n.id === 'product-main' ? { ...n, hidden: true } : n)),
    };
    const h = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: 'product', baseRev: 1, definition: hidden, userId: null })
    );
    expect(h).toMatchObject({ ok: false, status: 422 });
    // a document for another page under this URL is refused too
    const wrong = await inStore(storeId, () =>
      saveDraft({
        storeId,
        pageKey: 'product',
        baseRev: 1,
        definition: defaultPageDocument('cart'),
        userId: null,
      })
    );
    expect(wrong).toMatchObject({ ok: false, status: 422 });
    const st = await inStore(storeId, () => getPageState(storeId, 'product'));
    expect(st!.rev).toBe(1);
  });

  it('rollback republishes an earlier revision as a new one, still without touching layout_settings', async () => {
    // rev 2: put reviews last, publish; then roll back to rev 1
    const cur = await inStore(storeId, () => getPageState(storeId, 'product'));
    const next = reduceDocument(cur!.definition, {
      type: 'moveSection',
      id: 'product-reviews',
      toIndex: 5,
    }).doc;
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: 'product', baseRev: 1, definition: next, userId: null })
    );
    await inStore(storeId, () => publishDraft({ storeId, pageKey: 'product', baseRev: 2 }));
    const rb = await inStore(storeId, () =>
      rollbackToRevision({ storeId, pageKey: 'product', targetRev: 1, baseRev: 2, userId: null })
    );
    expect(rb).toMatchObject({ ok: true, value: { rev: 3 } });
    const live = await request(app).get(`/public/stores/${storeId}/pages/product`);
    expect(live.body.data.rev).toBe(3);
    expect(live.body.data.definition.sections.map((s: { id: string }) => s.id)[1]).toBe(
      'product-reviews'
    );
    expect(await layoutOf(storeId)).toEqual(layoutBefore);
  });

  it('another store never sees these documents', async () => {
    const other = await freshStore('other');
    const res = await request(app).get(`/public/stores/${other}/pages/product`);
    expect(res.body.data).toEqual({ definition: defaultPageDocument('product'), rev: null });
    const st = await inStore(other, () => getPageState(other, 'product'));
    expect(st).toMatchObject({ rev: 0, source: 'layout' });
    // a cross-store write: store `other`'s scope cannot save for `storeId`
    await expect(
      inStore(other, () =>
        saveDraft({
          storeId,
          pageKey: 'product',
          baseRev: 3,
          definition: defaultPageDocument('product'),
          userId: null,
        })
      )
    ).rejects.toBeDefined();
  });
});
