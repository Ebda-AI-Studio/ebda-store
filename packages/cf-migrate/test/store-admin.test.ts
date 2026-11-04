import { describe, expect, it } from 'vitest';
import { TableDigest } from '../src/canon.mjs';
import { authorizeCutover, handleStoreAdmin } from '../src/store-admin.mjs';
import { ndjson, storeDo } from './helpers';

const URL_ = 'https://do.test/cutover/stores/s1';
const post = (
  ctx: ReturnType<typeof storeDo>,
  path: string,
  body: string,
  ct = 'application/x-ndjson'
) =>
  handleStoreAdmin(
    new Request(`${URL_}/${path}`, { method: 'POST', body, headers: { 'content-type': ct } }),
    ctx
  );

const CATS = ['id', 'store_id', 'name', 'slug', 'parent_id'];
const headOf = (over: Record<string, unknown> = {}) => ({
  batch: 'cut-test-1',
  table: 'categories',
  page: 0,
  columns: CATS,
  pk: ['id'],
  ...over,
});

function seedStore(ctx: ReturnType<typeof storeDo>) {
  // the DO schema keeps store_profile/store_config per store; categories reference nothing else here
  void ctx;
}

describe('authorizeCutover', () => {
  const req = (auth?: string) =>
    new Request('https://x/', { headers: auth ? { authorization: auth } : {} });
  const secret = 's'.repeat(32);
  it('accepts only the exact bearer secret', () => {
    expect(authorizeCutover(req(`Bearer ${secret}`), secret)).toBe(true);
    expect(authorizeCutover(req(`Bearer ${secret}x`), secret)).toBe(false);
    expect(authorizeCutover(req(secret), secret)).toBe(false);
    expect(authorizeCutover(req(), secret)).toBe(false);
  });
  it('fails closed when the secret is unset or too short', () => {
    expect(authorizeCutover(req('Bearer '), '')).toBe(false);
    expect(authorizeCutover(req('Bearer short'), 'short')).toBe(false);
    expect(authorizeCutover(req('Bearer undefined'), undefined as unknown as string)).toBe(false);
  });
});

describe('__import', () => {
  it('upserts rows, is a no-op on an identical replay, and a changed replay of the same page is a 409', async () => {
    const ctx = storeDo();
    seedStore(ctx);
    const rows = [
      ['c1', 's1', 'Rings', 'rings', null],
      ['c2', 's1', 'Chains', 'chains', 'c1'],
    ];
    const r1 = await post(ctx, '__import', ndjson(headOf(), rows));
    expect(await r1.json()).toMatchObject({ ok: true, rows: 2, skipped: false });
    const r2 = await post(ctx, '__import', ndjson(headOf(), rows));
    expect(await r2.json()).toMatchObject({ ok: true, skipped: true });
    const r3 = await post(
      ctx,
      '__import',
      ndjson(headOf(), [['c1', 's1', 'CHANGED', 'rings', null]])
    );
    expect(r3.status).toBe(409);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 2 });
  });

  it('a new batch over the same rows updates in place (still one row per id)', async () => {
    const ctx = storeDo();
    await post(ctx, '__import', ndjson(headOf(), [['c1', 's1', 'Old', 'old', null]]));
    const r = await post(
      ctx,
      '__import',
      ndjson(headOf({ batch: 'cut-test-2' }), [['c1', 's1', 'New', 'old', null]])
    );
    expect(r.status).toBe(200);
    expect(ctx.db.prepare('SELECT name FROM categories WHERE id = ?').get('c1')).toEqual({
      name: 'New',
    });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 1 });
  });

  it('accepts a child before its parent (foreign keys are checked at the end, not per page)', async () => {
    const ctx = storeDo();
    const r = await post(
      ctx,
      '__import',
      ndjson(headOf(), [
        ['child', 's1', 'B', 'b', 'parent'],
        ['parent', 's1', 'A', 'a', null],
      ])
    );
    expect(r.status).toBe(200);
    const v = await post(
      ctx,
      '__verify',
      JSON.stringify({ tables: [], fk: true }),
      'application/json'
    );
    expect((await v.json()).fk.violations).toBe(0);
  });

  it('reports a real foreign-key violation at verify time', async () => {
    const ctx = storeDo();
    await post(ctx, '__import', ndjson(headOf(), [['child', 's1', 'B', 'b', 'ghost-parent']]));
    const v = await post(
      ctx,
      '__verify',
      JSON.stringify({ tables: [], fk: true }),
      'application/json'
    );
    expect((await v.json()).fk.violations).toBe(1);
  });

  it('rolls the whole page back when one row is rejected (no half pages)', async () => {
    const ctx = storeDo();
    const bad = await post(
      ctx,
      '__import',
      ndjson(headOf(), [
        ['c1', 's1', 'ok', 'ok', null],
        ['c2', 's1', null, 'x', null],
      ])
    ); // name NOT NULL
    expect(bad.status).toBe(500);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 0 });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM cf_import_ledger').get()).toEqual({ n: 0 });
  });

  it('rejects unknown tables, columns, pk mismatches, reserved tables and bad values', async () => {
    const ctx = storeDo();
    const go = async (head: Record<string, unknown>, rows: unknown[][]) =>
      (await post(ctx, '__import', ndjson(head, rows))).status;
    expect(await go(headOf({ table: 'nope' }), [])).toBe(400);
    expect(await go(headOf({ table: 'cf_import_ledger' }), [])).toBe(400);
    expect(await go(headOf({ table: 'categories"; DROP TABLE categories; --' }), [])).toBe(400);
    expect(await go(headOf({ columns: ['id', 'store_id', 'name', 'bogus'] }), [])).toBe(400);
    expect(await go(headOf({ pk: ['store_id'] }), [])).toBe(400);
    expect(await go(headOf({ batch: 'x' }), [])).toBe(400);
    expect(await go(headOf(), [['c1', 's1']])).toBe(400);
    expect(await go(headOf(), [['c1', 's1', { a: 1 }, 'x', null]])).toBe(400);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 0 });
  });

  it('writes a gold-rate product only through the import path (trigger flag raised and cleared inside the transaction)', async () => {
    const ctx = storeDo();
    const info = ctx.db
      .prepare(`SELECT name, "notnull", dflt_value FROM pragma_table_info('products')`)
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const required = info.filter(c => c.notnull && c.dflt_value === null).map(c => c.name);
    const val = (c: string) =>
      c === 'id'
        ? 'p1'
        : c === 'store_id'
          ? 's1'
          : /price|stock|count|quantity/.test(c)
            ? 1000
            : c === 'pricing_mode'
              ? 'gold_rate'
              : c === 'gold_karat'
                ? 21
                : c === 'making_charge_type'
                  ? 'fixed'
                  : c.startsWith('gold_') || c.startsWith('making_')
                    ? 5
                    : 'x';
    const cols = [
      ...new Set([
        ...required,
        'pricing_mode',
        'gold_karat',
        'gold_weight_mg',
        'making_charge_type',
        'making_charge_value',
      ]),
    ];
    // enum CHECKs may reject the filler text for some required columns; take the defaults of the real schema
    const rows = [cols.map(val)];
    const head = { batch: 'cut-gold-1', table: 'products', page: 0, columns: cols, pk: ['id'] };
    const r = await post(ctx, '__import', ndjson(head, rows));
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    expect(ctx.db.prepare(`SELECT value FROM do_flags WHERE name = 'gold_reprice'`).get()).toEqual({
      value: 0,
    });
    // outside the import, the guard still bites
    expect(() =>
      ctx.db.prepare(`UPDATE products SET price = price + 1 WHERE id = 'p1'`).run()
    ).toThrow(/GOLD_PRICE_MANAGED/);
  });

  it('refuses every import after __seal (the DO is live)', async () => {
    const ctx = storeDo();
    await post(ctx, '__import', ndjson(headOf(), [['c1', 's1', 'A', 'a', null]]));
    expect((await (await post(ctx, '__seal', '')).json()).sealed).toBe(true);
    expect(
      (await post(ctx, '__import', ndjson(headOf({ page: 1 }), [['c9', 's1', 'Z', 'z', null]])))
        .status
    ).toBe(423);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 1 });
  });
});

describe('__verify', () => {
  it('matches a TableDigest of the same rows, and a single changed cell breaks equality', async () => {
    const ctx = storeDo();
    const rows = [
      ['c1', 's1', 'Rings', 'r', null],
      ['c2', 's1', 'Chains', 'c', 'c1'],
      ['c3', 's1', 'Beads', 'b', null],
    ];
    await post(ctx, '__import', ndjson(headOf(), rows));
    const want = new TableDigest();
    for (const r of rows) await want.add(CATS, r, ['id']);
    const w = await want.finish();
    const ask = async () =>
      (
        await (
          await post(
            ctx,
            '__verify',
            JSON.stringify({ tables: [{ table: 'categories', columns: CATS, pk: ['id'] }] }),
            'application/json'
          )
        ).json()
      ).tables.categories;
    expect(await ask()).toEqual(w);
    ctx.db.prepare(`UPDATE categories SET name = 'Rings ' WHERE id = 'c1'`).run(); // a tamper the counts cannot see
    const got = await ask();
    expect(got.count).toBe(w.count);
    expect(got.digest).not.toBe(w.digest);
  });

  it('returns SUM aggregates for integer columns', async () => {
    const ctx = storeDo();
    const cols = ['id', 'store_id', 'name', 'slug', 'position'];
    await post(
      ctx,
      '__import',
      ndjson(headOf({ columns: cols }), [
        ['c1', 's1', 'A', 'a', 4],
        ['c2', 's1', 'B', 'b', 6],
      ])
    );
    const body = {
      tables: [
        { table: 'categories', columns: cols, pk: ['id'], aggs: [{ col: 'position', op: 'sum' }] },
      ],
    };
    const r = await post(ctx, '__verify', JSON.stringify(body), 'application/json');
    expect((await r.json()).tables.categories.aggs).toEqual({ position: '10' });
  });
});

describe('__seal baseline, __diff, __unseal (rollback safety, Audit DB-1)', () => {
  const rows = [
    ['c1', 's1', 'Rings', 'rings', null],
    ['c2', 's1', 'Chains', 'chains', null],
    ['c3', 's1', 'Beads', 'beads', null],
  ];
  const diff = async (ctx: ReturnType<typeof storeDo>) =>
    (await (await post(ctx, '__diff', '', 'application/json')).json()) as any;

  it('refuses to diff before a seal (no baseline)', async () => {
    const ctx = storeDo();
    expect((await post(ctx, '__diff', '', 'application/json')).status).toBe(409);
  });

  it('a sealed store with no writes diffs to nothing', async () => {
    const ctx = storeDo();
    await post(ctx, '__import', ndjson(headOf(), rows));
    const seal = await (await post(ctx, '__seal', '')).json();
    expect(seal.baselineRows).toBe(3);
    expect((await diff(ctx)).total).toBe(0);
  });

  it('reports added, changed and deleted rows after the seal, with full rows for replay', async () => {
    const ctx = storeDo();
    await post(ctx, '__import', ndjson(headOf(), rows));
    await post(ctx, '__seal', '');
    ctx.db
      .prepare(
        `INSERT INTO categories (id, store_id, name, slug) VALUES ('c4', 's1', 'New', 'new')`
      )
      .run();
    ctx.db.prepare(`UPDATE categories SET name = 'Renamed' WHERE id = 'c1'`).run();
    ctx.db.prepare(`DELETE FROM categories WHERE id = 'c3'`).run();
    const d = await diff(ctx);
    expect(d.total).toBe(3);
    const t = d.tables.categories;
    expect(t.added.map((r: unknown[]) => r[t.columns.indexOf('id')])).toEqual(['c4']);
    expect(t.changed.map((r: unknown[]) => r[t.columns.indexOf('name')])).toEqual(['Renamed']);
    expect(t.deleted).toEqual([['c3']]);
  });

  it('unseal wipes rows and bookkeeping, needs the exact confirmation, and re-opens imports', async () => {
    const ctx = storeDo();
    await post(ctx, '__import', ndjson(headOf(), rows));
    await post(ctx, '__seal', '');
    expect(
      (await post(ctx, '__unseal', JSON.stringify({ confirm: 'yes' }), 'application/json')).status
    ).toBe(400);
    expect(
      (
        await post(
          ctx,
          '__unseal',
          JSON.stringify({ confirm: 'wipe-and-unseal' }),
          'application/json'
        )
      ).status
    ).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 0 });
    expect(
      (await post(ctx, '__import', ndjson(headOf({ batch: 'cut-retry-1' }), rows))).status
    ).toBe(200);
  });
});

describe('__rebase', () => {
  it('makes the current state the new baseline so a replayed change is no longer a diff', async () => {
    const ctx = storeDo();
    await post(ctx, '__import', ndjson(headOf(), [['c1', 's1', 'A', 'a', null]]));
    await post(ctx, '__seal', '');
    ctx.db.prepare(`UPDATE categories SET name = 'B' WHERE id = 'c1'`).run();
    expect(((await (await post(ctx, '__diff', '', 'application/json')).json()) as any).total).toBe(
      1
    );
    expect((await post(ctx, '__rebase', '')).status).toBe(200);
    expect(((await (await post(ctx, '__diff', '', 'application/json')).json()) as any).total).toBe(
      0
    );
  });
  it('refuses before a seal', async () => {
    expect((await post(storeDo(), '__rebase', '')).status).toBe(409);
  });
});

describe('__auditimport (N-10d): the one write a sealed store accepts', () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    action: 'order.updated',
    user_id: 'u1',
    store_id: 's1',
    resource_type: 'order',
    resource_id: 'o1',
    details: '{"a":1}',
    ip_address: '1.1.1.1',
    user_agent: 'ua',
    created_at: 1_790_000_000_000,
    ...over,
  });
  const send = (ctx: ReturnType<typeof storeDo>, rows: unknown[]) =>
    handleStoreAdmin(
      new Request(`${URL_}/__auditimport`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
        headers: { 'content-type': 'application/json' },
      }),
      ctx
    );
  const rig = () => {
    const ctx = storeDo();
    ctx.db.exec(`CREATE TABLE IF NOT EXISTS _identity (k TEXT PRIMARY KEY, v TEXT)`);
    ctx.db.exec(`INSERT INTO _identity (k, v) VALUES ('store_id', 's1')`);
    return ctx;
  };

  it('inserts by id, is idempotent, and reports how many of the sent ids the table holds', async () => {
    const ctx = rig();
    const a = await (await send(ctx, [row('a1'), row('a2')])).json();
    expect(a).toMatchObject({ ok: true, inserted: 2, present: 2, sent: 2 });
    const b = await (await send(ctx, [row('a1'), row('a3')])).json();
    expect(b).toMatchObject({ ok: true, inserted: 1, present: 2, sent: 2 });
    expect((ctx.db.prepare('SELECT count(*) n FROM audit_logs').get() as { n: number }).n).toBe(3);
    expect(
      ctx.db.prepare(`SELECT details, created_at FROM audit_logs WHERE id='a1'`).get()
    ).toEqual({
      details: '{"a":1}',
      created_at: 1_790_000_000_000,
    });
  });

  it('refuses a row of another store and an oversized batch, and never overwrites an existing row', async () => {
    const ctx = rig();
    expect((await send(ctx, [row('x', { store_id: 'other' })])).status).toBe(400);
    expect(
      (
        await send(
          ctx,
          Array.from({ length: 501 }, (_, i) => row(`r${i}`))
        )
      ).status
    ).toBe(400);
    await send(ctx, [row('a1')]);
    await send(ctx, [row('a1', { action: 'tampered' })]);
    expect(ctx.db.prepare(`SELECT action FROM audit_logs WHERE id='a1'`).get()).toEqual({
      action: 'order.updated',
    });
  });
});
