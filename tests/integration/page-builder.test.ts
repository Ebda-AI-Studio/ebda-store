/**
 * Visual builder page documents (Phase 1): draft / publish / revisions /
 * rollback against a REAL Postgres, every assertion on a real `ebda_app`
 * login under strict RLS (the same harness as rls-ebda-app.test.ts: the
 * superuser URL only builds fixtures and cleans up).
 *
 * Proves: draft invisible to the public read; publish back-writes
 * layout_settings and becomes the public document; revisions list with a
 * cursor; rollback publishes a NEW revision; optimistic concurrency (stale
 * baseRev -> 409 with the latest; N concurrent writers -> exactly one wins,
 * nothing lost); tenant isolation; catalogue refs from another store are
 * warnings; the legacy layout PUT path writes a revision; an out-of-band
 * layout write wins over a stale published document; store delete cascades.
 *
 * RETRY: every describe pins `retry: 0`. The flow block is an ordered state
 * machine on one store (rev 1, 2, 3…), so a CI `--retry=1` re-run would fail
 * on attempt 2's artefacts and hide attempt 1's real error (CLAUDE.md,
 * "Integration tests must be RETRY-SAFE"); the race blocks each take a fresh
 * store, but a race assertion that passes only on retry is a finding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  prisma,
  TenantScopeViolation,
  type AppPrismaClient,
} from '@ebda/database';
import {
  applyTemplateFamily,
  layoutToDefinition,
  pageDefinitionSchema,
  reduceDocument,
  resolveLayoutSettings,
  TEMPLATE_FAMILIES,
  type PageDefinition,
} from '@ebda/shared';
import publicStoreLayoutRoutes from '../../apps/api/src/routes/public-store-layout.routes';
import {
  getPageState,
  saveDraft,
  publishDraft,
  listRevisions,
  rollbackToRevision,
  publishLegacyLayout,
  getPublishedDefinition,
} from '../../apps/api/src/services/page-builder.service';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = `pgb-${crypto.randomUUID().slice(0, 8)}-`;
const HOME = 'home';

let owner: AppPrismaClient;
const ids = { storeA: '', storeB: '', productA: '', productB: '' };

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const makeApp = () => createPrismaClient({ connectionString: appUrl(), max: 2 });

/** Run like an API request: ebda_app login, one tenant transaction for `storeId`. */
function inStore<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestDb(makeApp, () => runInTenantContext(storeId, fn));
}

async function layoutOf(storeId: string) {
  const s = await owner.store.findUnique({
    where: { id: storeId },
    select: { layoutSettings: true },
  });
  return s?.layoutSettings as Record<string, unknown>;
}

const docFor = (raw: unknown): PageDefinition =>
  layoutToDefinition(resolveLayoutSettings(raw, 'qamar'));

/**
 * The Add-section / template-family presets seed image-text with INSTRUCTIONAL
 * starter body copy, which the publish gate refuses (PLACEHOLDER_COPY). Tests
 * that publish such a document stand in for the merchant who wrote their own.
 */
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

async function freshStore(tag: string, template = 'qamar'): Promise<string> {
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
      template,
    },
  });
  return s.id;
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await setAppRoleLogin(owner, APP_PASSWORD);
  ids.storeA = await freshStore('a');
  ids.storeB = await freshStore('b');
  ids.productA = (
    await owner.product.create({
      data: { storeId: ids.storeA, name: 'pa', slug: `${PREFIX}pa`, price: 100 },
    })
  ).id;
  ids.productB = (
    await owner.product.create({
      data: { storeId: ids.storeB, name: 'pb', slug: `${PREFIX}pb`, price: 100 },
    })
  ).id;
});

afterAll(async () => {
  await owner.$executeRawUnsafe(
    `DELETE FROM public.store_page_revisions WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM public.products WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
  );
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  await owner.$disconnect();
});

describe('draft -> publish -> revisions -> rollback (one store, in order)', { retry: 0 }, () => {
  let storeId = '';
  beforeAll(async () => {
    storeId = await freshStore('flow');
  });

  it('a fresh page opens at rev 0 from layout_settings (nothing to backfill)', async () => {
    const st = await inStore(storeId, () => getPageState(storeId, HOME));
    expect(st).toMatchObject({ rev: 0, source: 'layout', draftRev: null, publishedRev: null });
    expect(st!.definition).toEqual(docFor({}));
  });

  it('save draft: rev 1, invisible to the public read, layout_settings untouched', async () => {
    const doc = docFor({ newArrivals: { enabled: false, limit: 4 } });
    const r = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
    );
    expect(r).toMatchObject({ ok: true, value: { rev: 1 } });
    expect(await layoutOf(storeId)).toEqual({});
    const pub = await getPublishedDefinition(storeId, resolveLayoutSettings({}, 'qamar'), 'qamar');
    expect(pub.rev).toBeNull();
    expect(pub.definition.sections.find(s => s.type === 'new-arrivals')!.hidden).toBe(false);
    const st = await inStore(storeId, () => getPageState(storeId, HOME));
    expect(st).toMatchObject({ rev: 1, source: 'draft', draftRev: 1 });
  });

  it('a stale baseRev gets 409 REV_CONFLICT with the latest document, and writes nothing', async () => {
    const r = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: docFor({}), userId: null })
    );
    expect(r).toMatchObject({
      ok: false,
      status: 409,
      code: 'REV_CONFLICT',
      latest: { rev: 1, source: 'draft' },
    });
    const rows = await owner.storePageRevision.findMany({ where: { storeId } });
    expect(rows).toHaveLength(1);
  });

  it('an invalid document gets 422 with JSON-pointer errors, and writes nothing', async () => {
    const doc = docFor({});
    doc.sections.push({
      id: 'evil',
      type: 'product-carousel',
      settings: { id: 'e', productSource: 'featured', title: 'x', bgColor: 'javascript:1' },
    });
    const r = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: doc, userId: null })
    );
    expect(r).toMatchObject({ ok: false, status: 422, code: 'INVALID_DEFINITION' });
    expect(
      (r as { errors: Array<{ path: string }> }).errors.some(e => e.path.includes('bgColor'))
    ).toBe(true);
    expect(await owner.storePageRevision.count({ where: { storeId } })).toBe(1);
  });

  it('publish: promotes the draft, back-writes layout_settings, becomes the public document', async () => {
    const r = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    expect(r).toMatchObject({ ok: true, value: { rev: 1 } });
    const stored = await layoutOf(storeId);
    expect((stored.newArrivals as { enabled: boolean }).enabled).toBe(false);
    const layout = resolveLayoutSettings(stored, 'qamar');
    const pub = await getPublishedDefinition(storeId, layout, 'qamar');
    expect(pub.rev).toBe(1);
    expect(pub.definition.sections.find(s => s.type === 'new-arrivals')!.hidden).toBe(true);
  });

  it('publish with no draft is a 409 NO_DRAFT', async () => {
    const r = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'NO_DRAFT' });
  });

  it('second edit + publish archives rev 1; revisions list newest first with a cursor', async () => {
    const doc = docFor({ newArrivals: { enabled: true, limit: 9 } });
    expect(
      await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: doc, userId: null })
      )
    ).toMatchObject({ ok: true, value: { rev: 2 } });
    expect(
      await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 2 }))
    ).toMatchObject({ ok: true });
    const p1 = await inStore(storeId, () => listRevisions({ storeId, pageKey: HOME, limit: 1 }));
    expect(p1.revisions.map(r => [r.rev, r.status])).toEqual([[2, 'published']]);
    expect(p1.nextCursor).toBe(2);
    const p2 = await inStore(storeId, () =>
      listRevisions({ storeId, pageKey: HOME, limit: 1, cursor: 2 })
    );
    expect(p2.revisions.map(r => [r.rev, r.status])).toEqual([[1, 'archived']]);
    expect(p2.nextCursor).toBeNull();
    expect((p1.revisions[0] as Record<string, unknown>).document).toBeUndefined();
  });

  it('rollback to rev 1 publishes a NEW rev 3 with rev 1 content; history is never rewritten', async () => {
    // a working draft exists when rolling back: it is superseded, and reported
    await inStore(storeId, () =>
      saveDraft({
        storeId,
        pageKey: HOME,
        baseRev: 2,
        definition: docFor({ bestSellers: { enabled: false, limit: 2 } }),
        userId: null,
      })
    );
    const r = await inStore(storeId, () =>
      rollbackToRevision({ storeId, pageKey: HOME, targetRev: 1, baseRev: 3, userId: null })
    );
    expect(r).toMatchObject({ ok: true, value: { rev: 4, discardedDraftRev: 3 } });
    expect(((await layoutOf(storeId)).newArrivals as { enabled: boolean }).enabled).toBe(false);
    const rows = await owner.storePageRevision.findMany({
      where: { storeId },
      orderBy: { rev: 'asc' },
    });
    expect(rows.map(x => [x.rev, x.status])).toEqual([
      [1, 'archived'],
      [2, 'archived'],
      [3, 'archived'],
      [4, 'published'],
    ]);
    expect(rows[3].document).toEqual(rows[0].document);
  });

  it('rollback to a rev that does not exist is a 404; a stale baseRev a 409', async () => {
    expect(
      await inStore(storeId, () =>
        rollbackToRevision({ storeId, pageKey: HOME, targetRev: 99, baseRev: 4, userId: null })
      )
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await inStore(storeId, () =>
        rollbackToRevision({ storeId, pageKey: HOME, targetRev: 2, baseRev: 3, userId: null })
      )
    ).toMatchObject({ ok: false, status: 409 });
  });
});

describe('optimistic concurrency under real parallel transactions', { retry: 0 }, () => {
  it('5 editors save on the same baseRev: exactly one wins, four get 409, no lost or duplicated rows', async () => {
    const storeId = await freshStore('race-save');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        inStore(storeId, () =>
          saveDraft({
            storeId,
            pageKey: HOME,
            baseRev: 0,
            definition: docFor({ newArrivals: { enabled: true, limit: i + 1 } }),
            userId: null,
          })
        )
      )
    );
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok).map(r => (r as { status: number }).status)).toEqual([
      409, 409, 409, 409,
    ]);
    const rows = await owner.storePageRevision.findMany({ where: { storeId } });
    expect(rows.map(r => [r.rev, r.status])).toEqual([[1, 'draft']]);
    // and a second round, now updating the existing draft row in place
    const round2 = await Promise.all(
      Array.from({ length: 4 }, () =>
        inStore(storeId, () =>
          saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: docFor({}), userId: null })
        )
      )
    );
    expect(round2.filter(r => r.ok)).toHaveLength(1);
    expect(
      await owner.storePageRevision.findMany({ where: { storeId }, select: { rev: true } })
    ).toEqual([{ rev: 2 }]);
  });

  it('3 editors publish the same draft at once: exactly one publish, one published row', async () => {
    const storeId = await freshStore('race-pub');
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: docFor({}), userId: null })
    );
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }))
      )
    );
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(await owner.storePageRevision.count({ where: { storeId, status: 'published' } })).toBe(
      1
    );
  });

  it('a legacy layout PUT publishes a revision and rebases the pending draft above it; a stale-base save gets 409', async () => {
    const storeId = await freshStore('legacy');
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: docFor({}), userId: null })
    );
    const outcome = await inStore(storeId, () =>
      publishLegacyLayout({
        storeId,
        layout: resolveLayoutSettings(
          { hero: { enabled: false, mode: 'single', autoplayMs: 5000, slides: [] } },
          'qamar'
        ),
        userId: null,
      })
    );
    expect(outcome).toBe('ok');
    const rows = await owner.storePageRevision.findMany({
      where: { storeId },
      orderBy: { rev: 'asc' },
    });
    expect(rows.map(r => [r.rev, r.status])).toEqual([
      [2, 'published'],
      [3, 'draft'],
    ]);
    expect(
      await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: docFor({}), userId: null })
      )
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 3, definition: docFor({}), userId: null })
      )
    ).toMatchObject({ ok: true });
  });
});

describe('tenant isolation (strict RLS on store_page_revisions)', { retry: 0 }, () => {
  it("store B's scope sees none of store A's revisions and cannot write one for A", async () => {
    const { storeA, storeB } = ids;
    await inStore(storeA, () =>
      saveDraft({
        storeId: storeA,
        pageKey: HOME,
        baseRev: 0,
        definition: docFor({}),
        userId: null,
      })
    );
    // Layer 1, the code-level tenant guard (R-EBDA-003): a query naming store A from B's
    // scope is refused before it reaches Postgres, whether issued directly or by the service.
    await expect(
      inStore(storeB, () => prisma.storePageRevision.count({ where: { storeId: storeA } }))
    ).rejects.toBeInstanceOf(TenantScopeViolation);
    await expect(inStore(storeB, () => getPageState(storeA, HOME))).rejects.toBeInstanceOf(
      TenantScopeViolation
    );
    // Layer 2, RLS: the same read in raw SQL (allowed in a scope) still sees none of A's rows.
    const [{ n }] = await inStore(
      storeB,
      () =>
        prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM public.store_page_revisions WHERE store_id = ${storeA}`
    );
    expect(Number(n)).toBe(0);
    await expect(
      inStore(storeB, () =>
        prisma.storePageRevision.create({
          data: {
            storeId: storeA,
            pageKey: HOME,
            rev: 50,
            status: 'archived',
            schemaVersion: 1,
            document: {},
            docBytes: 2,
          },
        })
      )
    ).rejects.toBeInstanceOf(TenantScopeViolation);
    // ... and RLS rejects the same write issued as raw SQL from B's scope.
    await expect(
      inStore(
        storeB,
        () =>
          prisma.$executeRaw`
          INSERT INTO public.store_page_revisions
            (id, store_id, page_key, rev, status, schema_version, document, doc_bytes)
          VALUES (${crypto.randomUUID()}, ${storeA}, ${HOME}, 51, 'archived', 1, '{}'::jsonb, 2)`
      )
    ).rejects.toThrow(/row-level security/i);
    // control: A sees its own
    expect(
      await inStore(storeA, () => prisma.storePageRevision.count({ where: { storeId: storeA } }))
    ).toBe(1);
  });

  it('a product id from another store is reported as not found (warning), never resolved', async () => {
    const { storeA, productA, productB } = ids;
    const doc = docFor({});
    doc.sections.push({
      id: 'extra-m',
      type: 'product-carousel',
      settings: { id: 'm', productSource: 'manual', manualProductIds: [productA, productB] },
    });
    const head = (await inStore(storeA, () => getPageState(storeA, HOME)))!.rev;
    const r = await inStore(storeA, () =>
      saveDraft({ storeId: storeA, pageKey: HOME, baseRev: head, definition: doc, userId: null })
    );
    expect(r.ok).toBe(true);
    const warned = (r as { warnings: Array<{ code: string; path: string }> }).warnings;
    expect(warned.map(w => w.code)).toEqual(['REF_NOT_FOUND']);
    expect(warned[0].path).toMatch(/manualProductIds\/1$/);
  });

  it('a shop-the-look piece from another store gets the same REF_NOT_FOUND warning and is never served (C11)', async () => {
    const { storeA, storeB, productA, productB } = ids;
    const doc = docFor({});
    doc.sections.push({
      id: 'stl',
      type: 'shop-the-look',
      settings: { headingAr: 'شوف اللوك كامل' },
      blocks: [{ id: 'look-1', type: 'look', settings: { productIds: [productA, productB] } }],
    });
    const head = (await inStore(storeA, () => getPageState(storeA, HOME)))!.rev;
    const r = await inStore(storeA, () =>
      saveDraft({ storeId: storeA, pageKey: HOME, baseRev: head, definition: doc, userId: null })
    );
    expect(r.ok).toBe(true);
    const warned = (r as { warnings: Array<{ code: string; path: string }> }).warnings;
    expect(warned.map(w => [w.code, w.path])).toEqual([
      ['REF_NOT_FOUND', `/sections/${doc.sections.length - 1}/blocks/0/settings/productIds/1`],
    ]);
    // The storefront loads look pieces with the store-scoped ids query: another store's active
    // product never comes back, so it can never render in A's look.
    const run = crypto.randomUUID().slice(0, 8);
    const [a2, b2] = await Promise.all(
      [storeA, storeB].map(storeId =>
        owner.product.create({
          data: {
            storeId,
            name: `stl-${run}`,
            slug: `${PREFIX}stl-${run}`,
            price: 100,
            status: 'active',
          },
        })
      )
    );
    const { ProductService } = await import('../../apps/api/src/services/product.service');
    const listed = await inStore(storeA, () =>
      ProductService.listPublic(storeA, { ids: [a2.id, b2.id], limit: 50 })
    );
    const got = (listed as { products: Array<{ id: string }> }).products.map(p => p.id);
    expect(got).toContain(a2.id);
    expect(got).not.toContain(b2.id);
  });
});

describe('integrity guards', { retry: 0 }, () => {
  it('an out-of-band layout_settings write wins over a stale published document', async () => {
    const storeId = await freshStore('drift');
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: docFor({}), userId: null })
    );
    await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    const drifted = { ...(await layoutOf(storeId)), bestSellers: { enabled: false, limit: 3 } };
    await owner.store.update({ where: { id: storeId }, data: { layoutSettings: drifted } });
    const pub = await getPublishedDefinition(
      storeId,
      resolveLayoutSettings(drifted, 'qamar'),
      'qamar'
    );
    expect(pub.definition.sections.find(s => s.type === 'best-sellers')!.hidden).toBe(true);
  });

  it('the database refuses a second published row and a bad status (partial unique + CHECK)', async () => {
    const storeId = await freshStore('constraints');
    const row = (rev: number, status: string) =>
      owner.storePageRevision.create({
        data: { storeId, pageKey: HOME, rev, status, schemaVersion: 1, document: {}, docBytes: 2 },
      });
    await row(1, 'published');
    await expect(row(2, 'published')).rejects.toThrow();
    await row(3, 'draft');
    await expect(row(4, 'draft')).rejects.toThrow();
    await expect(row(5, 'live')).rejects.toThrow();
  });

  it('deleting a store cascades its revisions', async () => {
    const storeId = await freshStore('cascade');
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: docFor({}), userId: null })
    );
    await owner.store.delete({ where: { id: storeId } });
    expect(await owner.storePageRevision.count({ where: { storeId } })).toBe(0);
  });
});

describe('document-only sections survive the legacy save paths', { retry: 0 }, () => {
  it('a legacy layout PUT keeps an image-text section the new builder added', async () => {
    const { reduceDocument } = await import('@ebda/shared');
    const storeId = await freshStore('doconly');
    const withImage = withRealCopy(
      reduceDocument(docFor({}), {
        type: 'addSection',
        list: 'template',
        sectionType: 'image-text',
        presetIndex: 0,
        index: 1,
      }).doc
    );
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: withImage, userId: null })
    );
    await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    const legacy = resolveLayoutSettings({ bestSellers: { enabled: false, limit: 2 } }, 'qamar');
    expect(
      await inStore(storeId, () => publishLegacyLayout({ storeId, layout: legacy, userId: null }))
    ).toBe('ok');
    // the legacy PUT route writes layout_settings right after (store-layout.routes.ts)
    await owner.store.update({
      where: { id: storeId },
      data: { layoutSettings: legacy as unknown as object },
    });
    const pub = await owner.storePageRevision.findFirst({
      where: { storeId, status: 'published' },
    });
    const ids = (pub!.document as unknown as PageDefinition).sections.map(s => s.id);
    expect(ids[1]).toBe('image-text-1');
    // and the public read serves it (projection still agrees with layout_settings)
    const layout = resolveLayoutSettings(await layoutOf(storeId), 'qamar');
    const served = await getPublishedDefinition(storeId, layout, 'qamar');
    expect(served.definition.sections.some(s => s.type === 'image-text')).toBe(true);
  });
});

/**
 * Bug: "A hero slide's autosave is blocked when it has no image." A freshly
 * added slide has no `image` yet — the draft schema allows that (so autosave
 * persists the in-progress edit) but publish must still refuse it, on BOTH
 * publish paths (the new builder's `publishDraft` and the classic editor's
 * `publishLegacyLayout`, which has no separate draft state at all).
 */
describe(
  'publish readiness: an imageless hero slide saves as a draft but cannot publish',
  { retry: 0 },
  () => {
    it('saveDraft accepts a hero slide with no image (autosave must not block)', async () => {
      const storeId = await freshStore('noimg-draft');
      const doc = reduceDocument(docFor({}), {
        type: 'addBlock',
        sectionId: 'hero',
        blockType: 'slide',
      }).doc;
      const r = await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
      );
      expect(r).toMatchObject({ ok: true, value: { rev: 1 } });
    });

    it('publishDraft refuses to publish it (422 MISSING_IMAGE), then succeeds once an image is added', async () => {
      const storeId = await freshStore('noimg-publish');
      const doc = reduceDocument(docFor({}), {
        type: 'addBlock',
        sectionId: 'hero',
        blockType: 'slide',
      }).doc;
      await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
      );
      const blocked = await inStore(storeId, () =>
        publishDraft({ storeId, pageKey: HOME, baseRev: 1 })
      );
      expect(blocked).toMatchObject({ ok: false, status: 422, code: 'INVALID_DEFINITION' });
      expect(
        (blocked as { errors: Array<{ code: string }> }).errors.some(
          e => e.code === 'MISSING_IMAGE'
        )
      ).toBe(true);
      expect(await owner.storePageRevision.count({ where: { storeId, status: 'published' } })).toBe(
        0
      );

      // Give the slide an image and retry — same rev, now publish-ready.
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
      await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: fixed, userId: null })
      );
      const ok = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 2 }));
      expect(ok).toMatchObject({ ok: true, value: { rev: 2 } });
    });

    it('the legacy layout PUT path (no separate draft state) also refuses an imageless slide', async () => {
      const storeId = await freshStore('noimg-legacy');
      const legacy = resolveLayoutSettings(
        { hero: { enabled: true, mode: 'single', autoplayMs: 5000, slides: [{ image: '' }] } },
        'qamar'
      );
      const outcome = await inStore(storeId, () =>
        publishLegacyLayout({ storeId, layout: legacy, userId: null })
      );
      expect(outcome).not.toBe('ok');
      expect(outcome).not.toBe('conflict');
      expect(
        (outcome as { invalid: Array<{ code: string }> }).invalid.some(
          e => e.code === 'MISSING_IMAGE'
        )
      ).toBe(true);
      expect(await owner.storePageRevision.count({ where: { storeId, status: 'published' } })).toBe(
        0
      );
    });

    it('rollback refuses to republish an ARCHIVED revision that predates this gate (code-review catch: a third publish path)', async () => {
      const storeId = await freshStore('noimg-rollback');
      const good = docFor({});

      // Simulate a pre-existing ARCHIVED revision with an imageless slide —
      // the shape `validatePublishReadiness` didn't exist to refuse when it
      // was first written (owner role bypasses the app-level guard, exactly
      // like a direct DB row from before this PR). Inserted FIRST, at rev 1,
      // so `head` (MAX(rev) across every status) accounts for it before the
      // real draft/publish flow below claims the next rev numbers.
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
      const badRev = await owner.storePageRevision.create({
        data: {
          storeId,
          pageKey: HOME,
          rev: 1,
          status: 'archived',
          schemaVersion: good.schemaVersion,
          document: bad as unknown as object,
          docBytes: Buffer.byteLength(JSON.stringify(bad)),
          baseRev: 0,
        },
      });

      await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: good, userId: null })
      );
      await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 2 }));

      const result = await inStore(storeId, () =>
        rollbackToRevision({
          storeId,
          pageKey: HOME,
          targetRev: badRev.rev,
          baseRev: 2,
          userId: null,
        })
      );
      expect(result).toMatchObject({ ok: false, status: 422, code: 'INVALID_DEFINITION' });
      expect(
        (result as { errors: Array<{ code: string }> }).errors.some(e => e.code === 'MISSING_IMAGE')
      ).toBe(true);
      // Still just the one published revision from the original publish — rollback never ran.
      expect(await owner.storePageRevision.count({ where: { storeId, status: 'published' } })).toBe(
        1
      );
    });
  }
);

/**
 * Bug 10: "placeholder copy gets published." The Add-section / template-family
 * presets seed instructional starter text. Every path that makes a document
 * live (publishDraft, rollbackToRevision) must refuse it; the legacy layout PUT
 * is deliberately exempt (Ruling PLACEHOLDER-1: it cannot author that text).
 */
describe('publish readiness: starter placeholder copy cannot go live', { retry: 0 }, () => {
  const withStarterSection = (): PageDefinition =>
    reduceDocument(docFor({}), {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
      index: 1,
    }).doc;
  const codes = (r: unknown) => (r as { errors: Array<{ code: string }> }).errors.map(e => e.code);

  it('publishDraft refuses starter copy (422 PLACEHOLDER_COPY, bilingual, nothing published), then succeeds once rewritten', async () => {
    const storeId = await freshStore('ph-publish');
    const doc = withStarterSection();
    const saved = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
    );
    expect(saved).toMatchObject({ ok: true, value: { rev: 1 } }); // drafts may hold it
    const blocked = await inStore(storeId, () =>
      publishDraft({ storeId, pageKey: HOME, baseRev: 1 })
    );
    expect(blocked).toMatchObject({ ok: false, status: 422, code: 'INVALID_DEFINITION' });
    expect(codes(blocked)).toContain('PLACEHOLDER_COPY');
    const e = (blocked as { errors: Array<{ messageEn: string; messageAr: string }> }).errors[0];
    expect(e.messageEn).toContain('Image with text');
    expect(e.messageAr).toContain('صورة مع نص');
    expect(await owner.storePageRevision.count({ where: { storeId, status: 'published' } })).toBe(
      0
    );

    await inStore(storeId, () =>
      saveDraft({
        storeId,
        pageKey: HOME,
        baseRev: 1,
        definition: withRealCopy(doc),
        userId: null,
      })
    );
    const ok = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 2 }));
    expect(ok).toMatchObject({ ok: true, value: { rev: 2 } });
  });

  it('a HIDDEN section holding starter copy does not block publish', async () => {
    const storeId = await freshStore('ph-hidden');
    const doc = withStarterSection();
    const hidden: PageDefinition = {
      ...doc,
      sections: doc.sections.map(n => (n.type === 'image-text' ? { ...n, hidden: true } : n)),
    };
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: hidden, userId: null })
    );
    const r = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    expect(r).toMatchObject({ ok: true });
  });

  it('rollback refuses to republish an archived revision that holds starter copy', async () => {
    const storeId = await freshStore('ph-rollback');
    const good = docFor({});
    const bad = withStarterSection();
    const badRev = await owner.storePageRevision.create({
      data: {
        storeId,
        pageKey: HOME,
        rev: 1,
        status: 'archived',
        schemaVersion: good.schemaVersion,
        document: bad as unknown as object,
        docBytes: Buffer.byteLength(JSON.stringify(bad)),
        baseRev: 0,
      },
    });
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: good, userId: null })
    );
    await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 2 }));
    const result = await inStore(storeId, () =>
      rollbackToRevision({
        storeId,
        pageKey: HOME,
        targetRev: badRev.rev,
        baseRev: 2,
        userId: null,
      })
    );
    expect(result).toMatchObject({ ok: false, status: 422, code: 'INVALID_DEFINITION' });
    expect(codes(result)).toContain('PLACEHOLDER_COPY');
    expect(await owner.storePageRevision.count({ where: { storeId, status: 'published' } })).toBe(
      1
    );
  });

  it('tenant scoping unchanged: store B publishing clean content is unaffected by store A refusal', async () => {
    const a = await freshStore('ph-iso-a');
    const b = await freshStore('ph-iso-b');
    await inStore(a, () =>
      saveDraft({
        storeId: a,
        pageKey: HOME,
        baseRev: 0,
        definition: withStarterSection(),
        userId: null,
      })
    );
    await inStore(b, () =>
      saveDraft({ storeId: b, pageKey: HOME, baseRev: 0, definition: docFor({}), userId: null })
    );
    expect(
      await inStore(a, () => publishDraft({ storeId: a, pageKey: HOME, baseRev: 1 }))
    ).toMatchObject({ ok: false });
    expect(
      await inStore(b, () => publishDraft({ storeId: b, pageKey: HOME, baseRev: 1 }))
    ).toMatchObject({ ok: true });
  });
});

/**
 * Ruling BUILDER-PUBLISH-1 regression: builder publish -> the PUBLIC layout
 * route (the storefront's only source) must serve the published document,
 * never the layout-derived fallback. Before the fix every template family
 * and every removed section fell back, on every store template.
 */
describe('builder publish -> storefront route serves the published document', { retry: 0 }, () => {
  const app = express();
  app.use('/public', publicStoreLayoutRoutes);

  async function publishAndRead(template: string, edit: (d: PageDefinition) => PageDefinition) {
    const storeId = await freshStore(`pub-${template}`, template);
    const st = await inStore(storeId, () => getPageState(storeId, HOME));
    expect(st!.source).toBe('layout');
    const doc = withRealCopy(edit(st!.definition));
    const saved = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
    );
    expect(saved).toMatchObject({ ok: true, value: { rev: 1 } });
    const pub = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    expect(pub).toMatchObject({ ok: true, value: { rev: 1 } });
    const row = await owner.storePageRevision.findFirst({
      where: { storeId, pageKey: HOME, status: 'published' },
      select: { document: true },
    });
    const res = await request(app).get(`/public/stores/${storeId}/layout`);
    expect(res.status).toBe(200);
    return { storeId, res, published: row!.document as unknown as PageDefinition };
  }

  for (const template of ['qamar', 'souq', 'dahab']) {
    for (const family of TEMPLATE_FAMILIES) {
      it(`${template} store, ${family.id} family: the storefront renders the published document`, async () => {
        const { res, published } = await publishAndRead(template, d =>
          applyTemplateFamily(d, family.id)
        );
        expect(res.body.data.rev).toBe(1);
        // what the storefront parses (HomePageBody.parseDefinition) is the published document
        const parsed = pageDefinitionSchema.safeParse(res.body.data.definition);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data).toEqual(published);
        expect(res.body.data.definition.sections.map((s: { type: string }) => s.type)).toEqual(
          published.sections.map(s => s.type)
        );
      });
    }
  }

  it('an editor-removed section stays removed on the storefront (jasmine store)', async () => {
    const { res, published } = await publishAndRead('jasmine', d => {
      const r = reduceDocument(d, { type: 'removeSection', id: 'new-arrivals' });
      expect(r.rejected).toBeUndefined();
      return r.doc;
    });
    expect(published.sections.some(s => s.type === 'new-arrivals')).toBe(false);
    expect(res.body.data.definition).toEqual(published);
  });

  it('a ported product-card switch (showNewBadge; the five share one draft-theme path) goes draft -> publish -> live store theme', async () => {
    const storeId = await freshStore('cardsw', 'qamar');
    const st = await inStore(storeId, () => getPageState(storeId, HOME));
    const doc = withRealCopy({
      ...st!.definition,
      theme: { showNewBadge: true, saleBadgeLegacyCorner: true },
    } as PageDefinition);
    const saved = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
    );
    expect(saved).toMatchObject({ ok: true, value: { rev: 1 } });
    // a draft is invisible to the live theme
    const before = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { theme: true },
    });
    expect((before.theme as Record<string, unknown> | null)?.showNewBadge).toBeUndefined();
    const pub = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    expect(pub).toMatchObject({ ok: true, value: { rev: 1 } });
    // the live store row is what the storefront's store payload serves
    const live = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { theme: true },
    });
    expect(live.theme).toMatchObject({ showNewBadge: true, saleBadgeLegacyCorner: true });
    const res = await request(app).get(`/public/stores/${storeId}/layout`);
    expect(res.status).toBe(200);
  });

  it('an out-of-band layout_settings write still falls back (the guard still guards)', async () => {
    const { storeId } = await publishAndRead('souq', d => applyTemplateFamily(d, 'lamma'));
    const raw = await layoutOf(storeId);
    await owner.store.update({
      where: { id: storeId },
      data: {
        layoutSettings: {
          ...raw,
          hero: { ...(raw.hero as object), enabled: false },
        } as unknown as object,
      },
    });
    const res = await request(app).get(`/public/stores/${storeId}/layout`);
    expect(res.body.data.rev).toBe(1);
    expect(
      res.body.data.definition.sections.find((s: { type: string }) => s.type === 'hero').hidden
    ).toBe(true);
    expect(res.body.data.definition.sections.map((s: { type: string }) => s.type)).not.toEqual(
      applyTemplateFamily(
        layoutToDefinition(resolveLayoutSettings({}, 'souq')),
        'lamma'
      ).sections.map(s => s.type)
    );
  });
});

describe('hero slide video survives draft -> publish -> public read', () => {
  it('video and videoMobile are not stripped by any layer (the imageMobile trap)', async () => {
    const storeId = await freshStore('herovid');
    const slide = {
      image: 'https://media.ebda.app/s/poster.webp',
      imageMobile: 'https://media.ebda.app/s/poster-m.webp',
      video: 'https://media.ebda.app/s/a.mp4',
      videoMobile: 'https://media.ebda.app/s/a-m.mp4',
    };
    const doc = withRealCopy(
      docFor({ hero: { enabled: true, mode: 'single', autoplayMs: 5000, slides: [slide] } })
    );
    const saved = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
    );
    expect(saved).toMatchObject({ ok: true, value: { rev: 1 } });
    const pub = await inStore(storeId, () => publishDraft({ storeId, pageKey: HOME, baseRev: 1 }));
    expect(pub).toMatchObject({ ok: true });
    const stored = await layoutOf(storeId);
    expect((stored.hero as { slides: unknown[] }).slides[0]).toMatchObject({
      video: slide.video,
      videoMobile: slide.videoMobile,
    });
    const read = await getPublishedDefinition(
      storeId,
      resolveLayoutSettings(stored, 'qamar'),
      'qamar'
    );
    const heroNode = read.definition.sections.find(s => s.type === 'hero')!;
    expect(heroNode.blocks![0].settings).toMatchObject({
      video: slide.video,
      videoMobile: slide.videoMobile,
    });
  });

  it('a javascript: video is a 422 on the draft', async () => {
    const storeId = await freshStore('herovidbad');
    const doc = docFor({
      hero: {
        enabled: true,
        mode: 'single',
        autoplayMs: 5000,
        slides: [{ image: '/a.webp', video: 'javascript:alert(1)' }],
      },
    });
    const r = await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: doc, userId: null })
    );
    expect(r).toMatchObject({ ok: false, status: 422 });
  });
});
