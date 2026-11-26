/**
 * The fault-injection cases of tests/integration/store-look.test.ts that the workerd port (apps/api/workers-test/store-look.test.ts)
 * cannot drive, because a built Worker has no in-process hook (the Postgres original is deleted). The REAL `StoreService.applyLook`
 * and the REAL page-builder service run on the StoreDO schema (node:sqlite through prisma-lite, the wiring of
 * product-3d-models-do.test.ts); only the store RECORD (a D1 / DO profile row prisma-lite has no delegate for) is an in-memory stand-in.
 *   - every section of the family unpublishable (starter copy): the empty store stays a DRAFT, never an empty live home, and the
 *     draft keeps the whole family for the merchant to fill;
 *   - the builder refuses (422 INVALID_DEFINITION): look, template and theme are unchanged and the error propagates;
 *   - the store update fails AFTER the builder step (Ruling LOOKS-10): the row is not written, and a retry converges on the same
 *     draft as one clean switch;
 *   - a layout-built page (customised layout_settings, no revision): the switch writes a DRAFT only and leaves the layout alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

type Rec = Record<string, unknown>;
const h = vi.hoisted(() => ({
  stores: new Map<string, Record<string, unknown>>(),
  notReady: false,
  failValidation: false,
  failStoreUpdateOnce: false,
  storeWrites: 0,
}));

const raw = openSqlite();
const lite = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true }) as any;
const pick = (rec: Rec, select?: Rec) =>
  select ? Object.fromEntries(Object.keys(select).map(k => [k, rec[k]])) : { ...rec };
const storeStandIn = {
  findUnique: async (a: { where: { id: string }; select?: Rec }) => {
    const rec = h.stores.get(a.where.id);
    return rec ? pick(rec, a.select) : null;
  },
  update: async (a: { where: { id: string }; data: Rec }) => {
    const rec = h.stores.get(a.where.id)!;
    h.storeWrites++;
    Object.assign(rec, a.data);
    return { ...rec };
  },
};
const withStoreRecord = new Proxy(lite, {
  get: (t, prop) => (prop === 'store' ? storeStandIn : t[prop]),
});

vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeDb: async () => withStoreRecord,
  storeWriter: async () => withStoreRecord,
  storeRepo: async () => ({ backend: 'do', db: withStoreRecord, writer: withStoreRecord }),
  storeWritesToDo: async () => true,
  // the settings write of `applyLook` (the DO's applySettings): applied to the stand-in, or failed once on demand
  storeUpdateOnDo: async (id: string, a: { data: Rec }) => {
    if (h.failStoreUpdateOnce) {
      h.failStoreUpdateOnce = false;
      throw new Error('simulated store update failure after the builder step');
    }
    return storeStandIn.update({ where: { id }, data: a.data });
  },
  storeUpdate: async (_db: unknown, a: { where: { id: string }; data: Rec }) =>
    storeStandIn.update({ where: { id: a.where.id }, data: a.data }),
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  return { ...real, withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(real.prisma) };
});
vi.mock('../../apps/api/src/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, run: () => Promise<unknown>) => void (await run()),
}));
vi.mock('../../apps/api/src/lib/savepoint', () => ({
  withSavepoint: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../apps/api/src/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedJsonUrls: async () => undefined,
  cleanupRemovedImages: async () => undefined,
  deleteR2ObjectIfOrphan: async () => undefined,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => false,
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    deleteByPattern: async () => 0,
    getCacheGenerations: async (n: string[]) => n.map(() => '0'),
    bumpCacheGeneration: async () => undefined,
  },
}));
vi.mock('../../apps/api/src/lib/store-directory', () => ({
  invalidateStoreDirectory: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({ revalidateStorefront: () => {} }));
vi.mock('@ebda/shared', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/shared')>();
  return {
    ...real,
    validateDefinition: (...a: Parameters<typeof real.validateDefinition>) =>
      h.failValidation ? Promise.resolve({ ok: false, errors: [] }) : real.validateDefinition(...a),
    validatePublishReadiness: (...a: Parameters<typeof real.validatePublishReadiness>) =>
      h.notReady
        ? a[0].sections.map((_, i) => ({
            code: 'PLACEHOLDER_COPY' as const,
            path: `/sections/${i}/settings`,
            messageEn: 'starter copy',
            messageAr: 'starter copy',
          }))
        : real.validatePublishReadiness(...a),
  };
});

import { StoreService } from '../../apps/api/src/services/store.service';

let n = 0;
function seed(over: Rec = {}) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  h.stores.set(id, {
    id,
    slug: `look-${n}`,
    domain: null,
    name: 'Look',
    template: 'dahab',
    look: null,
    theme: {},
    layoutSettings: {},
    typography: null,
    status: 'active',
    ...over,
  });
  // `applyLook` reads the whole record through getById (owner join is a Postgres relation); answer it from the stand-in
  vi.spyOn(StoreService, 'getById').mockImplementation(
    async (sid: string) => ({ ...h.stores.get(sid)! }) as never
  );
  return id;
}
const revs = (id: string) =>
  raw
    .prepare(
      `SELECT rev, status, document FROM store_page_revisions WHERE store_id = ? AND page_key = 'home' ORDER BY rev`
    )
    .all(id) as Array<{ rev: number; status: string; document: string }>;
const doc = (r: { document: string }) =>
  JSON.parse(r.document) as {
    appliedLook?: string;
    sections: Array<{ type: string; settings: Rec; blocks?: unknown }>;
  };
const LOOK = 'qamar.atelier';

beforeEach(() => {
  h.notReady = false;
  h.failValidation = false;
  h.failStoreUpdateOnce = false;
  h.storeWrites = 0;
});

describe('StoreService.applyLook under faults (store DB)', () => {
  it('empty store whose every family section is unpublishable: stays a DRAFT, never an empty live home', async () => {
    const id = seed();
    h.notReady = true;
    const out = await StoreService.applyLook(id, LOOK, { design: 'keep' });
    expect(out.builder).toBe('draft');
    const rows = revs(id);
    expect(rows.filter(r => r.status === 'published')).toHaveLength(0);
    const draft = rows.find(r => r.status === 'draft')!;
    expect(doc(draft).sections.length).toBeGreaterThan(0);
    expect(h.stores.get(id)!.look).toBe(LOOK);
  });

  it('a builder refusal leaves look, template and theme unchanged and the error propagates', async () => {
    const id = seed({ theme: { primaryColor: 'X' } });
    h.failValidation = true;
    await expect(StoreService.applyLook(id, LOOK, { design: 'reset' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'INVALID_DEFINITION',
    });
    expect(h.stores.get(id)).toMatchObject({
      look: null,
      template: 'dahab',
      theme: { primaryColor: 'X' },
    });
    expect(h.storeWrites).toBe(0);
    expect(revs(id).filter(r => r.status === 'published')).toHaveLength(0);
  });

  it('a retry after the store update failed converges on the same draft as one clean switch', async () => {
    const shape = (id: string) => {
      const d = doc(revs(id).find(r => r.status === 'draft')!);
      return {
        appliedLook: d.appliedLook,
        sections: d.sections.map(x => ({ type: x.type, settings: x.settings, blocks: x.blocks })),
      };
    };
    const once = seed();
    await StoreService.applyLook(once, 'dahab.worn', { design: 'keep' });
    await StoreService.applyLook(once, 'qamar.lookbook', { design: 'keep' });

    const twice = seed();
    await StoreService.applyLook(twice, 'dahab.worn', { design: 'keep' });
    h.failStoreUpdateOnce = true;
    await expect(
      StoreService.applyLook(twice, 'qamar.lookbook', { design: 'keep' })
    ).rejects.toThrow('simulated store update failure');
    expect(h.stores.get(twice)!.look).toBe('dahab.worn'); // the store row was not written
    await StoreService.applyLook(twice, 'qamar.lookbook', { design: 'keep' });

    expect(shape(twice)).toEqual(shape(once));
    expect(h.stores.get(twice)).toMatchObject({ look: 'qamar.lookbook', template: 'qamar' });
  });

  it('a layout-built page (customised layout, no revision): the switch writes a DRAFT only and leaves the layout alone', async () => {
    const layout = {
      brandStory: { enabled: true, titleEn: 'Our story', image: 'https://pub-x.r2.dev/story.jpg' },
    };
    const id = seed({ layoutSettings: layout });
    const out = await StoreService.applyLook(id, LOOK, { design: 'keep' });
    expect(out.builder).toBe('draft');
    expect(JSON.stringify(h.stores.get(id)!.layoutSettings)).toBe(JSON.stringify(layout));
    expect(revs(id).map(r => r.status)).toEqual(['draft']);
  });
});
