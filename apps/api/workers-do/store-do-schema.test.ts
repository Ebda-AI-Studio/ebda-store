import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createDoClient, decodeRpc } from '@ebda-src/repo';
import { Prisma } from '@prisma/client';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../src/cf/store-do/migrations';
import meta from '@ebda-src/prisma-meta';

// INFRA-CF-1 PR C: the real StoreDO carries the FULL generated cf-schema, versioned and idempotent, bound to ONE store,
// and answers prisma-lite reads for the API Worker. Real workerd, real Durable Object SQLite.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
const product = (storeId: string, id: string, over: Record<string, unknown> = {}) => ({
  id,
  storeId,
  name: `Name ${id}`,
  slug: `slug-${id}`,
  price: 1500,
  inventory: 4,
  status: 'active',
  ...over,
});
const storeDoTables = Object.entries(
  (meta as { models: Record<string, { db: string; table: string }> }).models
)
  .filter(([, m]) => m.db === 'store-do')
  .map(([, m]) => m.table);

describe('StoreDO schema: full generated cf-schema, versioned, idempotent', () => {
  it('a fresh Durable Object has every store-do table and records every migration once', async () => {
    const stub = stubFor('schema-fresh');
    expect((await stub.schemaVersion()).current).toBe(SCHEMA_VERSION);
    await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      const have = new Set(
        sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map(r => r.name as string)
      );
      expect(storeDoTables.length).toBeGreaterThan(100);
      expect(storeDoTables.filter(t => !have.has(t))).toEqual([]);
      const applied = sql
        .exec('SELECT id FROM _migrations ORDER BY applied_at, id')
        .toArray()
        .map(r => r.id);
      expect(applied.sort()).toEqual(MIGRATIONS.map(m => m.id).sort());
      // the derived-state bootstrap ran too (search index + dirty-marking triggers, payment claim index)
      expect(have.has('product_search_fts')).toBe(true);
      expect(have.has('payment_event_log')).toBe(true);
    });
  });

  it('re-running the migrations on a migrated Durable Object changes nothing', async () => {
    const stub = stubFor('schema-idem');
    await stub.schemaVersion();
    await runInDurableObject(stub, async (_i, state) => {
      const count = () =>
        state.storage.sql
          .exec("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE '_cf_%'")
          .one().n;
      const before = count();
      expect(runMigrations(state.storage)).toEqual([]); // nothing pending
      expect(runMigrations(state.storage)).toEqual([]);
      expect(count()).toBe(before);
      // and the DDL itself is idempotent: replaying a migration's statements by hand is a no-op, not an error
      const first = MIGRATIONS[1];
      expect(() => {
        for (const stmt of first.statements(new Set())) state.storage.sql.exec(stmt);
      }).not.toThrow();
    });
  });

  it('a constraint from the generated invariants is live (an enum outside its CHECK list is refused by the DO itself)', async () => {
    const stub = stubFor('schema-checks');
    await runInDurableObject(stub, async (_i, state) => {
      expect(() =>
        state.storage.sql.exec(
          "INSERT INTO products (id, store_id, name, slug, price, status) VALUES ('x','s','n','sl',1,'bogus')"
        )
      ).toThrow();
    });
  });
});

describe('StoreDO isolation: an instance serves exactly one store', () => {
  it("store A's Durable Object never serves store B (reads, writes and the loader entry points)", async () => {
    const a = stubFor('iso-A');
    const b = stubFor('iso-B');
    expect(await a.seed({ products: [product('iso-A', 'pa')] })).toMatchObject({ ok: true });
    expect(await b.seed({ products: [product('iso-B', 'pb')] })).toMatchObject({ ok: true });
    expect(await a.boundStoreId()).toBe('iso-A');

    // routed to A's instance but naming B: refused on every entry point, nothing leaks
    const read = await a.query('iso-B', [{ model: 'Product', op: 'findMany' }]);
    expect(read).toMatchObject({ ok: false, code: 'STORE_MISMATCH' });
    expect(await a.listProducts('iso-B', 10)).toMatchObject({ ok: false, code: 'STORE_MISMATCH' });
    expect(await a.seed({ products: [product('iso-B', 'leak')] })).toMatchObject({
      ok: false,
      code: 'STORE_MISMATCH',
    });
    expect(await a.createOrder('iso-B', 's')).toMatchObject({ ok: false, code: 'STORE_MISMATCH' });
    // thrown (the nightly sweep needs a failure to alert on), so catch it inside the DO: a throw across RPC is also "unhandled"
    const backupRefusal = await runInDurableObject(a, async d => {
      try {
        await d.backupNow('iso-B');
        return 'allowed';
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(backupRefusal).toMatch(/different store/);

    // a seed that smuggles a foreign store's row in with its own is refused whole
    const mixed = await a.seed({ products: [product('iso-A', 'pa2'), product('iso-B', 'pb2')] });
    expect(mixed).toMatchObject({ ok: false, code: 'STORE_MISMATCH' });

    // each instance holds only its own rows
    const ra = await a.query('iso-A', [
      { model: 'Product', op: 'findMany', args: { select: { id: true } } },
    ]);
    const rb = await b.query('iso-B', [
      { model: 'Product', op: 'findMany', args: { select: { id: true } } },
    ]);
    expect(ra.ok && decodeRpc<{ id: string }[][]>(ra.json)[0]).toEqual([{ id: 'pa' }]);
    expect(rb.ok && decodeRpc<{ id: string }[][]>(rb.json)[0]).toEqual([{ id: 'pb' }]);
  });

  it('an invalid store id never binds an instance', async () => {
    const stub = stubFor('iso-bad');
    for (const bad of ['', '../x', 'a b', 'x'.repeat(200)])
      expect(await stub.listProducts(bad, 1)).toMatchObject({ ok: false });
    expect(await stub.boundStoreId()).toBeUndefined();
  });
});

describe('StoreDO.query: prisma-lite reads for the API Worker, reads only', () => {
  it('answers findMany/findUnique/count with Prisma-shaped values (Date, Decimal-free ints) and maps not-found to P2025', async () => {
    const stub = stubFor('q-reads');
    await stub.seed({
      products: [
        product('q-reads', 'p1', { createdAt: 1_700_000_000_000 }),
        product('q-reads', 'p2', { status: 'draft' }),
      ],
    });
    const ok = await stub.query('q-reads', [
      {
        model: 'Product',
        op: 'findMany',
        args: { where: { status: 'active' }, select: { id: true, createdAt: true, price: true } },
      },
      { model: 'Product', op: 'count' },
      { model: 'Product', op: 'findUnique', args: { where: { id: 'nope' } } },
    ]);
    expect(ok.ok).toBe(true);
    const [rows, n, missing] = decodeRpc<unknown[]>((ok as { json: string }).json);
    expect(rows).toHaveLength(1);
    expect((rows as { createdAt: unknown }[])[0].createdAt).toBeInstanceOf(Date);
    expect((rows as { createdAt: Date }[])[0].createdAt.getTime()).toBe(1_700_000_000_000);
    expect(n).toBe(2);
    expect(missing).toBeNull();

    const nf = await stub.query('q-reads', [
      { model: 'Product', op: 'findUniqueOrThrow', args: { where: { id: 'nope' } } },
    ]);
    expect(nf).toMatchObject({ ok: false, code: 'P2025' });
  });

  it('refuses writes, unknown ops and unknown models before anything runs', async () => {
    const stub = stubFor('q-refuse');
    await stub.seed({ products: [product('q-refuse', 'p1')] });
    const w = await stub.query('q-refuse', [
      { model: 'Product', op: 'deleteMany' as never, args: { where: {} } },
    ]);
    expect(w).toMatchObject({ ok: false, code: 'OP_NOT_ALLOWED' });
    expect((await stub.query('q-refuse', [{ model: 'product', op: 'findMany' }])).ok).toBe(false);
    expect((await stub.query('q-refuse', [{ model: 'User', op: 'findMany' }])).ok).toBe(false); // D1 model: not in a store DO
    const after = await stub.query('q-refuse', [{ model: 'Product', op: 'count' }]);
    expect(after.ok && decodeRpc<number[]>(after.json)[0]).toBe(1);
  });
});

describe('the Worker-side read client over a real Durable Object', () => {
  const clientFor = (name: string, calls: unknown[][] = []) => {
    const stub = stubFor(name);
    const client = createDoClient(q => (calls.push(q), stub.query(name, q)));
    return { stub, client: client as any, calls };
  };

  it('returns Prisma-shaped values: Date, Prisma.Decimal, nested include, and a real PrismaClientKnownRequestError', async () => {
    const { stub, client } = clientFor('cl-shape');
    await stub.seed({
      products: [product('cl-shape', 'p1', { createdAt: 1_700_000_000_000, hasVariants: true })],
      variants: [{ id: 'v1', productId: 'p1', sku: 'S', price: 1500, inventory: 2 }],
    });
    const rows = await client.product.findMany({
      where: { status: 'active' },
      include: { variants: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    // a Decimal column (tax_rates.rate, scale 2: stored as the integer 1400) comes back as a Prisma.Decimal 14
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO tax_rates (id, store_id, name, rate) VALUES ('t1', 'cl-shape', 'VAT', 1400)"
      );
    });
    const rate = await client.taxRate.findUnique({ where: { id: 't1' } });
    expect(Prisma.Decimal.isDecimal(rate.rate)).toBe(true);
    expect(String(rate.rate)).toBe('14');
    expect(rows[0].variants.map((v: { id: string }) => v.id)).toEqual(['v1']);
    expect(await client.product.count()).toBe(1);
    expect(await client.product.findUnique({ where: { id: 'none' } })).toBeNull();
    const err = await client.product.findUniqueOrThrow({ where: { id: 'none' } }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
  });

  it('$transaction of reads is ONE round trip; writes and raw access do not exist on the client', async () => {
    const calls: unknown[][] = [];
    const { stub, client } = clientFor('cl-batch', calls);
    await stub.seed({ products: [product('cl-batch', 'p1'), product('cl-batch', 'p2')] });
    const [n, first] = await client.$transaction([
      client.product.count(),
      client.product.findFirst({ orderBy: { slug: 'asc' }, select: { slug: true } }),
    ]);
    expect(n).toBe(2);
    expect(first).toEqual({ slug: 'slug-p1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(client.product.create).toBeUndefined();
    expect(client.product.deleteMany).toBeUndefined();
    expect(() => client.$queryRaw).toThrow(/not available/);
  });

  it("a client for store A pointed at store B's id gets STORE_MISMATCH, not B's rows", async () => {
    const a = stubFor('cl-iso-A');
    await a.seed({ products: [product('cl-iso-A', 'pa')] });
    const wrong = createDoClient(q => a.query('cl-iso-B', q)) as any;
    await expect(wrong.product.findMany()).rejects.toThrow(/different store/);
  });
});
