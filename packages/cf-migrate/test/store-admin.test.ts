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
