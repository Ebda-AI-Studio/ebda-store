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

describe('procedures (PR D1b)', () => {
  const prod = (r: ReturnType<typeof rig>, sources: string | null) =>
    r.db
      .prepare(
        "INSERT INTO products (id, store_id, name, slug, price, ai_field_sources) VALUES ('p1', ?, 'P', 'p', 1, ?)"
      )
      .run(STORE, sources);

  it('mergeAiFieldSources merges the delta into the row as it is now, drops removed keys, returns the map', async () => {
    const r = rig();
    prod(r, '{"metaTitle":"ai","excerpt":"ai","keep":"human"}');
    const out = await r.run({
      ops: [
        {
          model: '$proc',
          op: 'mergeAiFieldSources',
          args: { productId: 'p1', set: { metaTitle: 'human', fresh: 'ai' }, remove: ['excerpt'] },
        },
      ],
    });
    expect(out.ok && decodeRpc<any[]>((out as any).json)[0]).toEqual({
      metaTitle: 'human',
      keep: 'human',
      fresh: 'ai',
    });
  });

  it('works on an empty map, no-ops on a missing row, and runs in the batch transaction (rolls back with it)', async () => {
    const r = rig();
    prod(r, '{}');
    const args = { productId: 'p1', set: { a: 'ai' }, remove: [] };
    expect(
      decodeRpc<any[]>(
        ((await r.run({ ops: [{ model: '$proc', op: 'mergeAiFieldSources', args }] })) as any).json
      )[0]
    ).toEqual({ a: 'ai' });
    expect(
      decodeRpc<any[]>(
        (
          (await r.run({
            ops: [
              { model: '$proc', op: 'mergeAiFieldSources', args: { ...args, productId: 'nope' } },
            ],
          })) as any
        ).json
      )[0]
    ).toBeNull();
    // a later failing op rolls the merge back
    const bad = await r.run({
      ops: [
        { model: '$proc', op: 'mergeAiFieldSources', args: { ...args, set: { b: 'human' } } },
        page('x'),
        page('x'),
      ],
    });
    expect(bad.ok).toBe(false);
    expect(
      (r.db.prepare("SELECT ai_field_sources v FROM products WHERE id='p1'").get() as any).v
    ).not.toContain('"b"');
  });

  it('refuses unknown procedures and hostile arguments (no SQL text is ever accepted)', async () => {
    const r = rig();
    prod(r, '{}');
    expect(checkMutation({ ops: [{ model: '$proc', op: 'dropEverything' }] })).toMatchObject({
      code: 'PROC_NOT_ALLOWED',
    });
    for (const set of [{ 'a"); DROP TABLE products;--': 'ai' }, { ok: 'robot' }])
      expect(
        await r.run({
          ops: [
            {
              model: '$proc',
              op: 'mergeAiFieldSources',
              args: { productId: 'p1', set, remove: [] },
            },
          ],
        })
      ).toMatchObject({ ok: false, code: 'BAD_PROC_ARGS' });
    expect(
      await r.run({
        ops: [
          {
            model: '$proc',
            op: 'mergeAiFieldSources',
            args: { productId: 'p1', set: {}, remove: ['x"]; --'] },
          },
        ],
      })
    ).toMatchObject({ ok: false, code: 'BAD_PROC_ARGS' });
    expect(r.count('products')).toBe(1);
  });
});

describe('audit trail is append-only on the DO write path (N-10d security review)', () => {
  const audit = (id: string, extra: Record<string, unknown> = {}) => ({
    model: 'AuditLog',
    op: 'create' as const,
    args: {
      data: {
        id,
        action: 'a',
        resourceType: 't',
        storeId: STORE,
        userId: 'u1',
        details: {},
        ...extra,
      },
    },
  });

  it('create works; update / updateMany / upsert / delete / deleteMany are refused and change nothing', async () => {
    const r = rig();
    expect((await r.run({ ops: [audit('r1')] })).ok).toBe(true);
    for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const) {
      const out = await r.run({
        ops: [{ model: 'AuditLog', op, args: { where: { id: 'r1' }, data: { action: 'x' } } }],
      });
      expect(out, op).toMatchObject({ ok: false, code: 'AUDIT_APPEND_ONLY' });
    }
    expect(r.count('audit_logs')).toBe(1);
  });

  it('the named procedures do the three narrow edits and refuse a young purge', async () => {
    const r = rig();
    await r.run({
      ops: [
        audit('r1', { action: 'agent.write.denied', details: { count: 1 } }),
        audit('r2', { userId: 'u2', action: 'agent.write.denied', details: { count: 1 } }),
        audit('r3'),
      ],
    });
    const proc = (op: string, args: Record<string, unknown>) =>
      r.run({ ops: [{ model: '$proc', op, args } as never] });
    expect(
      await proc('auditSetDetails', { id: 'r1', storeId: STORE, details: { count: 5 } })
    ).toMatchObject({ ok: true });
    expect(r.db.prepare(`SELECT details FROM audit_logs WHERE id='r1'`).get()).toEqual({
      details: '{"count":5}',
    });
    // another store's id changes nothing
    await proc('auditSetDetails', { id: 'r2', storeId: 'other', details: { count: 9 } });
    expect(r.db.prepare(`SELECT details FROM audit_logs WHERE id='r2'`).get()).toEqual({
      details: '{"count":1}',
    });
    // a row that is not a coalesced agent-denial row (r3: other action, no count) is never rewritten; nor is a bad shape
    await proc('auditSetDetails', { id: 'r3', storeId: STORE, details: { count: 3 } });
    expect(r.db.prepare(`SELECT details FROM audit_logs WHERE id='r3'`).get()).toEqual({
      details: '{}',
    });
    expect(
      await proc('auditSetDetails', { id: 'r1', storeId: STORE, details: { x: 1 } })
    ).toMatchObject({
      ok: false,
    });
    await proc('auditUnlinkUser', { userId: 'u2' });
    expect(r.db.prepare(`SELECT user_id FROM audit_logs WHERE id='r2'`).get()).toEqual({
      user_id: null,
    });
    expect(await proc('auditPurge', { before: Date.now(), upToId: 'zzz' })).toMatchObject({
      ok: false,
    });
    expect(r.count('audit_logs')).toBe(3);
    await proc('auditPurge', { before: Date.now() - 40 * 86_400_000, upToId: 'zzz' });
    expect(r.count('audit_logs')).toBe(3); // nothing is that old
  });

  it('waCustomerProfile reads ONLY the buyer key inside the store; a placeholder name is no name; default address wins', async () => {
    const r = rig();
    const BK = 'a'.repeat(64);
    const T = Date.now();
    const cust = r.db.prepare(
      'INSERT INTO customers (id, store_id, first_name, last_name, buyer_key, preferred_locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    cust.run('c1', STORE, 'Mona', 'Adel', BK, 'ar', T, T);
    cust.run('c2', 'other', 'Intruder', 'X', BK, 'en', T, T); // same key, another store
    cust.run('c3', STORE, 'WhatsApp', 'customer', 'b'.repeat(64), null, T, T);
    const adr = r.db.prepare(
      'INSERT INTO customer_addresses (id, customer_id, label, street, area, governorate, building_number, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    adr.run('a-new', 'c1', 'Work', '1 Tahrir', 'Dokki', 'Giza', '2', 0, T + 10, T + 10);
    adr.run('a-def', 'c1', 'Home', '9 Road 233', 'Maadi', 'Cairo', '4', 1, T, T);
    const raw = (buyerKey: string, storeId = STORE) =>
      r.run({
        ops: [{ model: '$proc', op: 'waCustomerProfile', args: { storeId, buyerKey } } as never],
      });
    const proc = async (buyerKey: string, storeId = STORE) =>
      decodeRpc<any[]>(((await raw(buyerKey, storeId)) as any).json)[0];
    expect(await proc(BK)).toMatchObject({
      known: true,
      firstName: 'Mona',
      preferredLocale: 'ar',
      defaultAddress: { id: 'a-def', governorate: 'Cairo', buildingNumber: '4' },
    });
    expect(await proc('b'.repeat(64))).toMatchObject({ known: true, firstName: null });
    expect(await proc('c'.repeat(64))).toMatchObject({ known: false, firstName: null });
    expect((await proc(BK, 'other')).firstName).toBe('Intruder');
    expect(await raw('not-a-key')).toMatchObject({ ok: false });
  });

  it('customerSetGroup / customerCreateInGroup move ONLY the group, inside the store, and roll back with the batch', async () => {
    const r = rig();
    const T = Date.now();
    r.db
      .prepare(
        `INSERT INTO customer_groups (id, store_id, name, created_at, updated_at) VALUES ('g1', ?, 'Wholesale', ?, ?), ('gx', 'other', 'Foreign', ?, ?)`
      )
      .run(STORE, T, T, T, T);
    const proc = (op: string, args: Record<string, unknown>) =>
      r.run({ ops: [{ model: '$proc', op, args } as never] });
    const made = await proc('customerCreateInGroup', {
      id: 'c1',
      storeId: STORE,
      email: 'a@x.test',
      firstName: 'A',
      lastName: 'B',
      userId: 'u1',
      groupId: 'g1',
    });
    expect(made).toMatchObject({ ok: true });
    expect(decodeRpc((made as { json: string }).json)).toEqual([
      { id: 'c1', groupId: 'g1', group: { id: 'g1', name: 'Wholesale', nameAr: null } },
    ]);
    // a group of another store is refused and nothing is written
    expect(
      await proc('customerCreateInGroup', {
        id: 'c2',
        storeId: STORE,
        email: null,
        firstName: 'A',
        lastName: 'B',
        groupId: 'gx',
      })
    ).toMatchObject({ ok: false, message: 'group not found' });
    expect(r.count('customers')).toBe(1);
    // the same user twice is a unique violation (P2002), not a second row
    expect(
      await proc('customerCreateInGroup', {
        id: 'c3',
        storeId: STORE,
        firstName: 'A',
        lastName: 'B',
        userId: 'u1',
        groupId: 'g1',
      })
    ).toMatchObject({ ok: false, code: 'P2002' });
    // set / clear the group; another store's customer id changes nothing and answers not found
    expect(
      await proc('customerSetGroup', { storeId: STORE, customerId: 'c1', groupId: null })
    ).toMatchObject({ ok: true });
    expect(r.db.prepare(`SELECT group_id FROM customers WHERE id='c1'`).get()).toEqual({
      group_id: null,
    });
    expect(
      await proc('customerSetGroup', { storeId: 'other', customerId: 'c1', groupId: null })
    ).toMatchObject({ ok: false, message: 'customer not found' });
  });
});
