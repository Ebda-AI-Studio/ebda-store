/**
 * NEON-ZERO-1: the D1 client (journal replay over the synchronous prisma-lite engine) against the real platform
 * migration on node:sqlite wrapped as an ASYNC D1. Proves: reads/writes match the synchronous engine, every statement
 * reaches D1 exactly once (no double-applied write), ids/timestamps survive replay, constraint errors map to Prisma
 * codes, `$transaction` is refused.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createD1Client, type D1Like } from '../src/prisma-lite/d1';
import { createPrismaLite } from '../src/prisma-lite/client';
import { META } from './diff-harness';
import { nodeSqlRunner } from './node-sql';

const SQL = ['0001_init.sql', '0002_invariants.sql']
  .map(f =>
    fs.readFileSync(new URL(`../../cf-schema/migrations/platform/${f}`, import.meta.url), 'utf8')
  )
  .join('\n');

function rig() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SQL);
  const log: string[] = [];
  const d1: D1Like = {
    prepare: sql => ({
      bind: (...v) => {
        const exec = async () => {
          await Promise.resolve(); // genuinely asynchronous
          log.push(sql);
          if (/^\s*select/i.test(sql))
            return { results: db.prepare(sql).all(...(v as never[])) as never[] };
          const r = db.prepare(sql).run(...(v as never[]));
          return { meta: { changes: Number(r.changes) } };
        };
        return { all: exec as never, run: exec as never };
      },
    }),
  };
  return { db, d1, log, client: createD1Client(META, d1) };
}

describe('D1 client', () => {
  it('create + findUnique + update + updateMany + count + delete round-trip, each write statement once', async () => {
    const { client, db, log } = rig();
    const created = await client.plan.create({
      data: {
        code: 'pro',
        nameEn: 'Pro',
        nameAr: 'برو',
        limits: { maxStores: 3 },
        featureTier: 'professional',
      },
    });
    expect(created.code).toBe('pro');
    expect(created.limits).toEqual({ maxStores: 3 });
    const inserts = log.filter(s => /^\s*insert/i.test(s));
    expect(inserts).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) n FROM plans').get() as { n: number }).n).toBe(1);

    expect((await client.plan.findUnique({ where: { id: created.id } })).nameEn).toBe('Pro');
    expect(await client.plan.findUnique({ where: { code: 'nope' } })).toBeNull();

    const upd = await client.plan.update({ where: { code: 'pro' }, data: { nameEn: 'Pro+' } });
    expect(upd.nameEn).toBe('Pro+');
    expect(log.filter(s => /^\s*update/i.test(s))).toHaveLength(1);

    expect(await client.plan.updateMany({ where: { code: 'pro' }, data: { sort: 5 } })).toEqual({
      count: 1,
    });
    expect(await client.plan.count({ where: { sort: 5 } })).toBe(1);
    await client.plan.delete({ where: { code: 'pro' } });
    expect(await client.plan.count()).toBe(0);
  });

  it('matches the synchronous engine on the same data (findMany with where/orderBy/select)', async () => {
    const { client, db } = rig();
    const lite = createPrismaLite(META, nodeSqlRunner(db), 'd1', { unscoped: true });
    for (const [i, code] of ['a', 'b', 'c'].entries())
      await lite.plan.create({ data: { code, nameEn: code, nameAr: code, limits: {}, sort: i } });
    const args = {
      where: { sort: { gte: 1 } },
      orderBy: { sort: 'desc' },
      select: { code: true, sort: true },
    };
    expect(await client.plan.findMany(args)).toEqual(await lite.plan.findMany(args));
  });

  it('generated id and timestamp are the same across replays (create returns the row it inserted)', async () => {
    const { client, db } = rig();
    const p = await client.plan.create({
      data: { code: 'x', nameEn: 'x', nameAr: 'x', limits: {} },
    });
    const row = db.prepare('SELECT id, created_at FROM plans WHERE code = ?').get('x') as {
      id: string;
      created_at: number;
    };
    expect(p.id).toBe(row.id);
    expect(new Date(p.createdAt).getTime()).toBe(row.created_at);
  });

  it('a unique violation is a Prisma P2002 and nothing is double-applied', async () => {
    const { client, db } = rig();
    const data = { code: 'dup', nameEn: 'x', nameAr: 'x', limits: {} };
    await client.plan.create({ data });
    await expect(client.plan.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    expect((db.prepare('SELECT COUNT(*) n FROM plans').get() as { n: number }).n).toBe(1);
  });

  it('upsert creates then updates', async () => {
    const { client } = rig();
    const args = {
      where: { code: 'u' },
      create: { code: 'u', nameEn: 'one', nameAr: 'x', limits: {} },
      update: { nameEn: 'two' },
    };
    expect((await client.plan.upsert(args)).nameEn).toBe('one');
    expect((await client.plan.upsert(args)).nameEn).toBe('two');
  });

  it('refuses $transaction and a non-D1 model', async () => {
    const { client } = rig();
    await expect(client.$transaction([])).rejects.toMatchObject({ code: 'D1_NO_TRANSACTION' });
    expect(() => client.product).toThrow(/no model delegate/);
  });

  it('is lazy: nothing runs until awaited', async () => {
    const { client, log } = rig();
    client.plan.findMany({});
    await Promise.resolve();
    expect(log).toHaveLength(0);
  });
});

describe('D1 client: sessions, batch, call counting', () => {
  it('onStatement counts every statement that reaches D1 and flags replica reads', async () => {
    const { db, d1 } = rig();
    const seen: Array<{ kind: string; replica: boolean }> = [];
    const sessions: string[] = [];
    const withSession = (c?: string) => (
      sessions.push(c ?? ''),
      { prepare: d1.prepare, getBookmark: () => 'bm1' }
    );
    const client = createD1Client(
      META,
      { ...d1, withSession },
      { replicaReads: true, onStatement: e => seen.push(e) }
    );
    db.prepare(
      "INSERT INTO plans (id, code, name_en, name_ar, limits) VALUES ('p','c','n','n','{}')"
    ).run();
    await client.plan.findMany({});
    expect(seen).toEqual([{ kind: 'all', sql: expect.any(String), replica: true }]);
    expect(sessions).toEqual(['first-unconstrained']);
    expect(client.$bookmark()).toBe('bm1');
    seen.length = 0;
    await client.plan.update({ where: { code: 'c' }, data: { sort: 2 } }); // a write op never touches a replica
    expect(seen.every(s => s.replica === false)).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('a read-only client without the Sessions API falls back to the primary', async () => {
    const { d1 } = rig();
    const seen: boolean[] = [];
    const client = createD1Client(META, d1, {
      replicaReads: true,
      onStatement: e => seen.push(e.replica),
    });
    await client.plan.count();
    expect(seen).toEqual([false]);
  });

  it('$batch runs independent statements in one d1.batch call', async () => {
    const { d1, db } = rig();
    let batches = 0;
    const client = createD1Client(META, {
      ...d1,
      batch: async stmts => (batches++, stmts.map(() => ({}))),
    });
    await client.$batch([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]);
    expect(batches).toBe(1);
    void db;
  });
});
