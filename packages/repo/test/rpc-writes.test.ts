/**
 * PR D1 (Ruling CF-WRITES-1): the StoreDO write RPC. A batch is atomic, a keyed batch is replay-safe, and anything not
 * ported (money models, stock columns, another store's id) is refused as an ANSWER before or without touching rows.
 */
import { describe, expect, it } from 'vitest';
import { createPrismaLite } from '../src/prisma-lite/client';
import { createDoClient } from '../src/rpc/client';
import { decodeRpc } from '../src/rpc/codec';
import {
  DO_WRITABLE_MODELS,
  checkMutation,
  ensureIdempotencySchema,
  runWrites,
  type DoMutation,
} from '../src/rpc/writes';
import { META, openSqlite } from './diff-harness';
import { nodeSqlRunner } from './node-sql';

const STORE = 'store-a';
function rig(storeId = STORE) {
  const db = openSqlite();
  const sql = nodeSqlRunner(db);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId }) as never;
  let clock = 1_000_000;
  const run = (m: DoMutation) => runWrites(lite, sql, m, () => clock);
  const count = (t: string) =>
    (db.prepare(`SELECT count(*) n FROM "${t}"`).get() as { n: number }).n;
  return { db, sql, lite, run, count, tick: (ms: number) => (clock += ms) };
}
const page = (slug: string) => ({
  model: 'StorePage',
  op: 'create' as const,
  args: { data: { storeId: STORE, slug, title: slug, isPublished: true } },
});

describe('runWrites', () => {
  it('commits a batch and returns each result in order', async () => {
    const r = rig();
    const out = await r.run({ ops: [page('a'), page('b'), { model: 'StorePage', op: 'count' }] });
    expect(out.ok).toBe(true);
    const rows = decodeRpc<any[]>((out as { json: string }).json);
    expect(rows[0].slug).toBe('a');
    expect(rows[2]).toBe(2);
    expect(r.count('store_pages')).toBe(2);
  });

  it('is atomic: a failing op rolls the whole batch back and reports the Prisma code', async () => {
    const r = rig();
    const out = await r.run({ ops: [page('a'), page('a')] }); // second hits the (storeId, slug) unique
    expect(out).toMatchObject({ ok: false, code: 'P2002' });
    expect(r.count('store_pages')).toBe(0);
  });

  it('replays a keyed batch without running it twice, and refuses the key for a different batch', async () => {
    const r = rig();
    const m = { key: 'req-key-0001', ops: [page('a')] };
    const first = await r.run(m);
    const again = await r.run(m);
    expect(again).toEqual(first);
    expect(r.count('store_pages')).toBe(1);
    expect(await r.run({ key: 'req-key-0001', ops: [page('other')] })).toMatchObject({
      ok: false,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(r.count('store_pages')).toBe(1);
  });

  it('a failed keyed batch stores nothing, so the retry runs', async () => {
    const r = rig();
    await r.run({ ops: [page('a')] });
    const m = { key: 'req-key-0002', ops: [page('b'), page('a')] };
    expect((await r.run(m)).ok).toBe(false);
    expect(r.count('_idempotency')).toBe(0);
    await r.db.exec("DELETE FROM store_pages WHERE slug = 'a'");
    expect((await r.run(m)).ok).toBe(true);
  });

  it('expires a key after 24h (the batch runs again) and prunes the old row', async () => {
    const r = rig();
    const m = {
      key: 'req-key-0003',
      ops: [
        {
          model: 'StorePage',
          op: 'upsert' as const,
          args: {
            where: { storeId_slug: { storeId: STORE, slug: 'u' } },
            create: { storeId: STORE, slug: 'u', title: 'v1' },
            update: { title: 'v2' },
          },
        },
      ],
    };
    await r.run(m);
    r.tick(25 * 60 * 60 * 1000);
    const out = await r.run(m);
    expect(out.ok).toBe(true);
    expect(r.count('_idempotency')).toBe(1);
    expect((r.db.prepare('SELECT title FROM store_pages').get() as { title: string }).title).toBe(
      'v2'
    );
  });
});

describe('refusals (nothing ported silently)', () => {
  it.each([
    'Order',
    'OrderItem',
    'Payment',
    'Refund',
    'StockReservation',
    'Coupon',
    'LedgerEntry',
    'Store',
    'User',
  ])('refuses a write to %s (money/lock/platform = D2 or D1 platform repo)', async model => {
    expect(DO_WRITABLE_MODELS.has(model)).toBe(false);
    const r = rig();
    expect(await r.run({ ops: [{ model, op: 'create', args: { data: {} } }] })).toMatchObject({
      ok: false,
      code: 'MODEL_NOT_WRITABLE',
    });
  });

  it('refuses stock columns on Product/ProductVariant, nested or via upsert, but allows a stock FILTER', async () => {
    const r = rig();
    const bad = (args: Record<string, unknown>, model = 'Product') =>
      r.run({ ops: [{ model, op: 'updateMany', args }] });
    expect(await bad({ where: {}, data: { inventory: 5 } })).toMatchObject({
      code: 'STOCK_WRITE_REFUSED',
    });
    expect(await bad({ where: {}, data: { inventory: { increment: 1 } } })).toMatchObject({
      code: 'STOCK_WRITE_REFUSED',
    });
    expect(await bad({ where: {}, data: { inventory: 1 } }, 'ProductVariant')).toMatchObject({
      code: 'STOCK_WRITE_REFUSED',
    });
    expect(
      await r.run({
        ops: [
          {
            model: 'Product',
            op: 'upsert',
            args: { where: { id: 'x' }, create: { inventory: 1 }, update: {} },
          },
        ],
      })
    ).toMatchObject({ code: 'STOCK_WRITE_REFUSED' });
    expect(
      await r.run({
        ops: [
          {
            model: 'Product',
            op: 'create',
            args: { data: { variants: { create: [{ inventory: 3 }] } } },
          },
        ],
      })
    ).toMatchObject({ code: 'STOCK_WRITE_REFUSED' });
    expect(
      checkMutation({
        ops: [
          {
            model: 'Product',
            op: 'updateMany',
            args: { where: { inventory: 0 }, data: { lowStockThreshold: 2 } },
          },
        ],
      })
    ).toBeUndefined();
  });

  it('refuses unknown ops, bad models, empty/oversized batches and bad keys', () => {
    expect(
      checkMutation({ ops: [{ model: 'StorePage', op: 'executeRaw' as never }] })
    ).toMatchObject({ code: 'OP_NOT_ALLOWED' });
    expect(checkMutation({ ops: [{ model: 'store_pages; DROP', op: 'create' }] })).toMatchObject({
      code: 'BAD_MODEL',
    });
    expect(checkMutation({ ops: [] })).toMatchObject({ code: 'BAD_BATCH' });
    expect(checkMutation({ ops: Array(201).fill(page('a')) })).toMatchObject({ code: 'BAD_BATCH' });
    expect(checkMutation({ key: 'short', ops: [page('a')] })).toMatchObject({
      code: 'BAD_IDEMPOTENCY_KEY',
    });
  });

  it("tenant isolation: a write carrying another store's id is refused and rolls the batch back", async () => {
    const r = rig();
    const out = await r.run({
      ops: [
        page('ok'),
        {
          model: 'StorePage',
          op: 'create',
          args: { data: { storeId: 'store-b', slug: 'x', title: 'x' } },
        },
      ],
    });
    expect(out.ok).toBe(false);
    expect(r.count('store_pages')).toBe(0);
  });
});

describe('client over the RPC', () => {
  it('writes go through mutate as ONE batch with the idempotency key; reads still use query; errors keep their class', async () => {
    const r = rig();
    const calls: DoMutation[] = [];
    const c = createDoClient(
      async () => ({ ok: false, code: 'X', message: 'no reads here' }),
      async m => (calls.push(m), r.run(m))
    ) as any;
    const [a, b] = await c.$transaction(
      [c.storePage.create(page('a').args), c.storePage.create(page('b').args)],
      { idempotencyKey: 'client-key-01' }
    );
    expect([a.slug, b.slug]).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('client-key-01');
    await expect(c.storePage.create(page('a').args)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a client without mutate refuses writes before sending anything', async () => {
    const c = createDoClient(async () => ({ ok: true, json: '[]' })) as any;
    expect(() => c.storePage.create({ data: {} })).toThrow(); // no write delegate exists
  });
});
