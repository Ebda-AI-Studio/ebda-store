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
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  prisma,
  type AppPrismaClient,
} from '@force/database';
import { layoutToDefinition, resolveLayoutSettings, type PageDefinition } from '@force/shared';
import {
  getPageState,
  saveDraft,
  publishDraft,
  listRevisions,
  rollbackToRevision,
  publishLegacyLayout,
  getPublishedDefinition,
} from '../../apps/api/src/services/page-builder.service';

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
  layoutToDefinition(resolveLayoutSettings(raw, 'modern'));

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
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3 });
  await owner.$executeRawUnsafe(`ALTER ROLE ebda_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
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
    const pub = await getPublishedDefinition(storeId, resolveLayoutSettings({}, 'modern'));
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
    const layout = resolveLayoutSettings(stored, 'modern');
    const pub = await getPublishedDefinition(storeId, layout);
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

  it('a legacy layout PUT publishes a revision; a draft based on the old head then gets 409', async () => {
    const storeId = await freshStore('legacy');
    await inStore(storeId, () =>
      saveDraft({ storeId, pageKey: HOME, baseRev: 0, definition: docFor({}), userId: null })
    );
    const outcome = await inStore(storeId, () =>
      publishLegacyLayout({
        storeId,
        layout: resolveLayoutSettings(
          { hero: { enabled: false, mode: 'single', autoplayMs: 5000, slides: [] } },
          'modern'
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
      [1, 'draft'],
      [2, 'published'],
    ]);
    expect(
      await inStore(storeId, () =>
        saveDraft({ storeId, pageKey: HOME, baseRev: 1, definition: docFor({}), userId: null })
      )
    ).toMatchObject({ ok: false, status: 409 });
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
    const seen = await inStore(storeB, () =>
      prisma.storePageRevision.count({ where: { storeId: storeA } })
    );
    expect(seen).toBe(0);
    // the service, asked for A from B's scope, sees an empty page (rev 0), never A's draft
    const st = await inStore(storeB, () => getPageState(storeA, HOME));
    expect(st?.rev).toBe(0);
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
    const pub = await getPublishedDefinition(storeId, resolveLayoutSettings(drifted, 'modern'));
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
