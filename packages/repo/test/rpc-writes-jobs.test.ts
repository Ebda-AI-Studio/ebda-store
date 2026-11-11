/**
 * Ruling CF-JOBS-4: the store-side writes the non-money background jobs make on a store that lives on its Durable Object,
 * run on the real DO schema (node:sqlite) through the same write RPC the Worker uses. Each job family is proved twice: the
 * write lands, and a second delivery of the same job (an at-least-once queue, a workflow replay, an alarm re-fire) leaves
 * the same state instead of a duplicate row or a lost guard.
 */
import { describe, expect, it } from 'vitest';
import { createPrismaLite } from '../src/prisma-lite/client';
import { decodeRpc } from '../src/rpc/codec';
import {
  DO_WRITABLE_MODELS,
  ensureIdempotencySchema,
  runWrites,
  type DoMutation,
} from '../src/rpc/writes';
import { META, openSqlite } from './diff-harness';
import { nodeSqlRunner } from './node-sql';

const STORE = 'store-a';
function rig() {
  const db = openSqlite();
  const sql = nodeSqlRunner(db);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const run = async (m: DoMutation) => {
    const out = await runWrites(lite, sql, m);
    if (!out.ok) throw new Error(`${out.code}: ${out.message}`);
    return decodeRpc<any[]>(out.json!);
  };
  const q = (s: string, ...p: unknown[]) => db.prepare(s).all(...(p as never[])) as any[];
  const count = (t: string) =>
    (db.prepare(`SELECT count(*) n FROM "${t}"`).get() as any).n as number;
  return { db, run, q, count };
}
const product = (r: ReturnType<typeof rig>, id: string, extra = '') =>
  r.db
    .prepare(
      `INSERT INTO products (id, store_id, name, slug, price, ai_field_sources${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?, ?, ?, ?, 1, '{}'${extra ? ', ?' : ''})`
    )
    .run(
      ...([id, STORE, `P ${id}`, `p-${id}`, ...(extra ? [extra.split('=')[1]] : [])] as never[])
    );

describe('the models the jobs write are on the DO allow-list', () => {
  it('lists every model of the non-money jobs', () => {
    for (const m of [
      'BulkAiJob',
      'BulkImportJob',
      'StoreFaq',
      'StoreHowto',
      'AiRecommendation',
      'FrequentlyBoughtTogether',
      'ProfitAnomaly',
      'CustomerCohortSnapshot',
      'FunnelSnapshot',
      'CustomerRfmSnapshot',
      'AnswerEngineCheck',
    ])
      expect(DO_WRITABLE_MODELS.has(m), m).toBe(true);
  });
});

describe('bulk AI / import job rows', () => {
  const job = (id = 'j1') => ({
    model: 'BulkAiJob',
    op: 'create' as const,
    args: { data: { id, storeId: STORE, kind: 'seo' } },
  });

  it('a job row is created, marked running and completed by id + storeId, and a second delivery changes nothing more', async () => {
    const r = rig();
    await r.run({ ops: [job()] });
    const mark = (status: string, extra: object = {}) => ({
      model: 'BulkAiJob',
      op: 'update' as const,
      args: { where: { id: 'j1', storeId: STORE }, data: { status, ...extra } },
    });
    await r.run({ ops: [mark('running', { startedAt: new Date() })] });
    await r.run({
      ops: [mark('completed', { total: 3, processed: 3, filled: 2, completedAt: new Date() })],
    });
    const once = r.q('SELECT * FROM bulk_ai_jobs');
    // the same job delivered again: the same terminal write, the same single row
    await r.run({ ops: [mark('completed', { total: 3, processed: 3, filled: 2 })] });
    expect(r.count('bulk_ai_jobs')).toBe(1);
    expect(r.q('SELECT status, total, filled FROM bulk_ai_jobs')[0]).toEqual({
      status: 'completed',
      total: 3,
      filled: 2,
    });
    expect(once[0].status).toBe('completed');
  });

  it("another store's job id cannot be updated (the where carries the store)", async () => {
    const r = rig();
    await r.run({ ops: [job()] });
    await expect(
      r.run({
        ops: [
          {
            model: 'BulkAiJob',
            op: 'update',
            args: { where: { id: 'j1', storeId: 'someone-else' }, data: { status: 'failed' } },
          },
        ],
      })
    ).rejects.toThrow();
    expect(r.q('SELECT status FROM bulk_ai_jobs')[0].status).not.toBe('failed');
  });

  it('the orphan sweep marks a stuck import failed once; the second pass finds nothing running', async () => {
    const r = rig();
    await r.run({
      ops: [
        {
          model: 'BulkImportJob',
          op: 'create',
          args: {
            data: {
              id: 'i1',
              storeId: STORE,
              userId: 'u',
              status: 'running',
              csvData: 'a,b',
              startedAt: new Date(Date.now() - 3 * 3600_000),
            },
          },
        },
      ],
    });
    const sweep = () =>
      r.run({
        ops: [
          {
            model: 'BulkImportJob',
            op: 'updateMany',
            args: {
              where: { id: { in: ['i1'] }, storeId: STORE, status: 'running' },
              data: { status: 'failed', errorMessage: 'orphaned', completedAt: new Date() },
            },
          },
        ],
      });
    expect((await sweep())[0]).toEqual({ count: 1 });
    expect((await sweep())[0]).toEqual({ count: 0 });
    expect(r.q('SELECT status FROM bulk_import_jobs')[0].status).toBe('failed');
  });
});

describe('AI recommendations and store content', () => {
  it("replacing a product's recommendations is one atomic batch: delivered twice it leaves the same rows", async () => {
    const r = rig();
    for (const id of ['a', 'b', 'c']) product(r, id);
    const replace = () =>
      r.run({
        ops: [
          {
            model: 'AiRecommendation',
            op: 'deleteMany',
            args: { where: { storeId: STORE, sourceProductId: 'a' } },
          },
          {
            model: 'AiRecommendation',
            op: 'createMany',
            args: {
              data: [
                { storeId: STORE, sourceProductId: 'a', targetProductId: 'b', score: 0.9 },
                { storeId: STORE, sourceProductId: 'a', targetProductId: 'c', score: 0.5 },
              ],
              skipDuplicates: true,
            },
          },
        ],
      });
    await replace();
    await replace();
    expect(r.count('ai_recommendation')).toBe(2);
  });

  it('the product delete cleanup removes both directions of the graph and a replay removes nothing more', async () => {
    const r = rig();
    for (const id of ['a', 'b']) product(r, id);
    await r.run({
      ops: [
        {
          model: 'AiRecommendation',
          op: 'createMany',
          args: {
            data: [
              { storeId: STORE, sourceProductId: 'a', targetProductId: 'b', score: 1 },
              { storeId: STORE, sourceProductId: 'b', targetProductId: 'a', score: 1 },
            ],
          },
        },
        {
          model: 'FrequentlyBoughtTogether',
          op: 'create',
          args: {
            data: { storeId: STORE, productId1: 'a', productId2: 'b', coOccurrenceCount: 3 },
          },
        },
      ],
    });
    const cleanup = () =>
      r.run({
        ops: [
          {
            model: 'AiRecommendation',
            op: 'deleteMany',
            args: {
              where: { storeId: STORE, OR: [{ targetProductId: 'a' }, { sourceProductId: 'a' }] },
            },
          },
          {
            model: 'FrequentlyBoughtTogether',
            op: 'deleteMany',
            args: { where: { storeId: STORE, OR: [{ productId1: 'a' }, { productId2: 'a' }] } },
          },
        ],
      });
    expect((await cleanup()).map((x: any) => x.count)).toEqual([2, 1]);
    expect((await cleanup()).map((x: any) => x.count)).toEqual([0, 0]);
    expect(r.count('ai_recommendation')).toBe(0);
    expect(r.count('frequently_bought_together')).toBe(0);
  });

  it('FAQ and how-to rows replace as a batch (delete-then-create) and stay one set when delivered twice', async () => {
    const r = rig();
    const replace = () =>
      r.run({
        ops: [
          { model: 'StoreFaq', op: 'deleteMany', args: { where: { storeId: STORE } } },
          {
            model: 'StoreFaq',
            op: 'create',
            args: { data: { storeId: STORE, question: 'Q?', answer: 'A.' } },
          },
        ],
      });
    await replace();
    await replace();
    expect(r.count('store_faqs')).toBe(1);
  });
});

describe('profit anomalies, rollup snapshots, answer-engine checks', () => {
  it('a profit anomaly row is written and the 24 h dedupe count sees it', async () => {
    const r = rig();
    await r.run({
      ops: [
        {
          model: 'ProfitAnomaly',
          op: 'create',
          args: {
            data: {
              storeId: STORE,
              scope: 'store',
              metric: 'margin_drop',
              current7d: 1,
              baseline28d: 2,
              deltaPercent: -0.5,
              severity: 'p0',
              explanationEn: 'e',
              explanationAr: 'a',
            },
          },
        },
      ],
    });
    const n = await r.run({
      ops: [
        {
          model: 'ProfitAnomaly',
          op: 'count',
          args: {
            where: {
              storeId: STORE,
              metric: 'margin_drop',
              severity: 'p0',
              detectedAt: { gte: new Date(Date.now() - 86400_000) },
            },
          },
        },
      ],
    });
    expect(n[0]).toBe(1);
  });

  it('funnel snapshots: create the new day, update the existing one, a rerun keeps one row per day', async () => {
    const r = rig();
    const day = new Date('2026-10-01T00:00:00Z');
    const base = {
      storeId: STORE,
      periodDate: day,
      productViews: 1,
      cartsCreated: 1,
      cartItemsAdded: 1,
      checkoutsStarted: 1,
      ordersCompleted: 1,
      ordersAbandoned: 0,
      revenueFils: 100,
      computedAt: new Date(),
    };
    await r.run({ ops: [{ model: 'FunnelSnapshot', op: 'createMany', args: { data: [base] } }] });
    const existing = (
      await r.run({
        ops: [
          {
            model: 'FunnelSnapshot',
            op: 'findMany',
            args: { where: { storeId: STORE, periodDate: { in: [day] } }, select: { id: true } },
          },
        ],
      })
    )[0] as Array<{ id: string }>;
    expect(existing).toHaveLength(1);
    await r.run({
      ops: [
        {
          model: 'FunnelSnapshot',
          op: 'update',
          args: {
            where: { id: existing[0].id, storeId: STORE },
            data: { ordersCompleted: 5, computedAt: new Date() },
          },
        },
      ],
    });
    expect(r.count('funnel_snapshots')).toBe(1);
    expect(r.q('SELECT orders_completed n FROM funnel_snapshots')[0].n).toBe(5);
  });

  it('answer-engine checks append, and the resume read sees the rows of this run only', async () => {
    const r = rig();
    const t0 = new Date();
    await r.run({
      ops: [
        {
          model: 'AnswerEngineCheck',
          op: 'create',
          args: {
            data: {
              storeId: STORE,
              engine: 'gemini',
              promptText: 'best x',
              locale: 'en',
              cited: true,
              citedUrls: [],
              competitorUrls: [],
            },
          },
        },
      ],
    });
    const seen = await r.run({
      ops: [
        {
          model: 'AnswerEngineCheck',
          op: 'findMany',
          args: {
            where: { storeId: STORE, runAt: { gte: new Date(t0.getTime() - 1000) } },
            select: { engine: true, promptText: true, locale: true },
          },
        },
      ],
    });
    expect(seen[0]).toEqual([{ engine: 'gemini', promptText: 'best x', locale: 'en' }]);
  });
});

describe('guardedAiWrite: the in-DO twin of the guarded AI product write', () => {
  const call = (r: ReturnType<typeof rig>, args: object) =>
    r.run({ ops: [{ model: '$proc', op: 'guardedAiWrite', args }] }).then(x => x[0] as any);

  it("writes a field that still equals the baseline, stamps it ai, and keeps another field's human stamp", async () => {
    const r = rig();
    r.db
      .prepare(
        "INSERT INTO products (id, store_id, name, slug, price, description, ai_field_sources) VALUES ('p1', ?, 'P', 'p', 1, 'old', '{\"name\":\"human\"}')"
      )
      .run(STORE);
    const out = await call(r, {
      productId: 'p1',
      baseline: { description: 'old', name: 'P' },
      writes: { description: 'new', name: 'Renamed' },
      extra: {},
      fillOnly: false,
    });
    expect(out).toMatchObject({ found: true, written: ['description'], stale: ['name'] });
    const row = r.q('SELECT name, description, ai_field_sources s FROM products')[0];
    expect(row.name).toBe('P'); // human-owned: untouched
    expect(row.description).toBe('new');
    expect(JSON.parse(row.s)).toEqual({ name: 'human', description: 'ai' });
  });

  it('a field the merchant changed since the read is left alone (compare-and-set), and a replay writes nothing', async () => {
    const r = rig();
    r.db
      .prepare(
        "INSERT INTO products (id, store_id, name, slug, price, description, ai_field_sources) VALUES ('p1', ?, 'P', 'p', 1, 'edited by merchant', '{}')"
      )
      .run(STORE);
    const args = {
      productId: 'p1',
      baseline: { description: 'old' },
      writes: { description: 'ai text' },
      extra: {},
      fillOnly: false,
    };
    expect(await call(r, args)).toMatchObject({ written: [], stale: ['description'] });
    expect(r.q('SELECT description d FROM products')[0].d).toBe('edited by merchant');
    // the matching baseline writes once; the same call again finds the value changed (its own write) and writes nothing
    const ok = { ...args, baseline: { description: 'edited by merchant' } };
    expect((await call(r, ok)).written).toEqual(['description']);
    expect((await call(r, ok)).written).toEqual([]);
    expect(r.q('SELECT description d FROM products')[0].d).toBe('ai text');
  });

  it('reports a missing or deleted product, stores the balance backup, and counts categories', async () => {
    const r = rig();
    expect(
      await call(r, { productId: 'nope', baseline: {}, writes: { description: 'x' }, extra: {} })
    ).toMatchObject({
      found: false,
    });
    r.db
      .prepare(
        "INSERT INTO products (id, store_id, name, slug, price, description, ai_field_sources) VALUES ('p1', ?, 'P', 'p', 1, 'd', '{}')"
      )
      .run(STORE);
    const out = await call(r, {
      productId: 'p1',
      baseline: { description: 'd' },
      writes: { description: 'e' },
      extra: { aiBalanceBackup: { description: 'd' } },
      fillOnly: false,
    });
    expect(out.categoryCount).toBe(0);
    expect(JSON.parse(r.q('SELECT ai_balance_backup b FROM products')[0].b)).toEqual({
      description: 'd',
    });
  });

  it('is fill-only by default: a stored value is never replaced, an empty one is filled (NEVER-OVERWRITE-1)', async () => {
    const r = rig();
    r.db
      .prepare(
        "INSERT INTO products (id, store_id, name, name_ar, slug, price, description, ai_field_sources) VALUES ('p1', ?, 'Signal Signet', 'خاتم الإشارة', 'p', 1, NULL, '{\"nameAr\":\"ai\"}')"
      )
      .run(STORE);
    const out = await call(r, {
      productId: 'p1',
      baseline: { nameAr: 'خاتم الإشارة', description: null },
      writes: { nameAr: 'سيجنال سيجنيت', description: 'new' },
      extra: {},
    });
    expect(out).toMatchObject({ written: ['description'], stale: ['nameAr'] });
    expect(r.q('SELECT name_ar n FROM products')[0].n).toBe('خاتم الإشارة');
  });

  it('refuses hostile field names (no SQL text is ever accepted)', async () => {
    const r = rig();
    r.db
      .prepare(
        "INSERT INTO products (id, store_id, name, slug, price, ai_field_sources) VALUES ('p1', ?, 'P', 'p', 1, '{}')"
      )
      .run(STORE);
    await expect(
      call(r, { productId: 'p1', baseline: {}, writes: { 'name = 1; --': 'x' }, extra: {} })
    ).rejects.toThrow();
  });
});
