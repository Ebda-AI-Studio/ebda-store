import { describe, expect, it } from 'vitest';
import { env, applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { encodeRpc } from '@ebda-src/repo';
import { buyerKeyFor, toE164 } from '@ebda/shared';
import { createPostgresRemovedClient, runWithRequestDb } from '@ebda/database';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';
import { runBuyerKeyBackfill, decodeCursor } from '../src/lib/wa/buyer-key-backfill';

// WA-BRIDGE-BIND-3: the buyer-key backfill on REAL StoreDOs. Same derivation as checkout, idempotent, dry-run writes nothing, resumable,
// gone stores skipped, and a stamped key is never overwritten.
const SECRET = 'backfill-test-suite-secret-32-chars-minimum';
const e = env as unknown as {
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: DurableObjectNamespace<StoreDO>;
};
const S1 = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const S2 = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const GONE = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const stub = (id: string) => e.STORE_DO.get(e.STORE_DO.idFromName(id));
const sql = <T>(id: string, q: string, ...a: unknown[]) =>
  runInDurableObject(stub(id), (_i, s) => s.storage.sql.exec(q, ...a).toArray() as T[]);
const run = <T>(f: () => Promise<T>) =>
  runWithRequestDb(() => createPostgresRemovedClient(() => undefined), f);

async function seedStore(id: string, slug: string, deleted: boolean) {
  const T = Date.now();
  await e.PLATFORM_DB.prepare(
    "INSERT INTO stores (id, name, slug, owner_id, storage_backend, status, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, 'owner', 'do', 'active', ?4, ?4, ?5)"
  )
    .bind(id, slug, slug, T, deleted ? T : null)
    .run();
  await stub(id).seed({
    store: { id, slug, name: slug, currency: 'EGP', createdAt: T, updatedAt: T },
    products: [
      {
        id: `${slug}-p`,
        storeId: id,
        name: 'W',
        slug: 'w',
        price: 1000,
        inventory: 100,
        status: 'active',
        hasVariants: false,
        createdAt: T,
        updatedAt: T,
      },
    ],
  });
  await sql(
    id,
    "INSERT OR IGNORE INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')",
    id,
    slug
  );
}
async function order(id: string, slug: string, phone: string | null, n: number) {
  const r = await stub(id).moneyOp(
    id,
    'createOrder',
    encodeRpc({
      lines: [{ productId: `${slug}-p`, quantity: 1 }],
      shippingAddress: { name: 'A', ...(phone ? { phone } : {}) },
      paymentMethod: 'cod',
      idempotencyKey: `bf-${slug}-${n}`,
    }),
    `bf-${slug}-${n}`
  );
  if (!r.ok) throw new Error(`order failed ${JSON.stringify(r)}`);
}
const keys = async (id: string) =>
  (
    await sql<{ phone: string | null; k: string | null }>(
      id,
      "SELECT json_extract(shipping_address, '$.phone') AS phone, buyer_key AS k FROM orders ORDER BY id"
    )
  ).map(r => [r.phone, r.k] as const);
const reset = (id: string) => sql(id, 'UPDATE orders SET buyer_key = NULL');
const expectKey = async (phone: string) => buyerKeyFor(SECRET, toE164(phone)!);

describe('buyer-key backfill', () => {
  it('fixture: two live DO stores with orders (valid phones, a local-format phone, none) and a deleted store', async () => {
    setCfBindings(e as unknown as CfBindings);
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    await seedStore(S1, 'bf-one', false);
    await seedStore(S2, 'bf-two', false);
    await seedStore(GONE, 'bf-gone', true);
    for (const [i, p] of (['+201001234567', '01112345678', null] as const).entries())
      await order(S1, 'bf-one', p, i);
    await order(S2, 'bf-two', '+201212345678', 0);
    await order(GONE, 'bf-gone', '+201512345678', 0);
  });

  it('dry run counts per store and writes nothing', async () => {
    const r = await run(() => runBuyerKeyBackfill({ secret: SECRET, dryRun: true, budget: 100 }));
    expect(r.nextCursor).toBeNull();
    expect(r.totals).toMatchObject({ scanned: 4, keyed: 3, noPhone: 1, skippedStores: 0 });
    expect(r.stores.map(s => [s.storeId, s.keyed, s.noPhone]).sort()).toEqual(
      [
        [S1, 2, 1],
        [S2, 1, 0],
      ].sort()
    );
    expect((await keys(S1)).every(([, k]) => k === null)).toBe(true);
  });

  it('apply stamps the same key checkout derives, leaves the phone-less order alone, and the deleted store untouched', async () => {
    const r = await run(() => runBuyerKeyBackfill({ secret: SECRET, dryRun: false, budget: 100 }));
    expect(r.totals).toMatchObject({ keyed: 3, noPhone: 1 });
    const one = new Map(await keys(S1));
    expect(one.get('+201001234567')).toBe(await expectKey('+201001234567'));
    expect(one.get('+201112345678')).toBe(await expectKey('01112345678')); // the engine stores the E.164 form;
    expect(one.get(null as never)).toBeNull();
    expect((await keys(S2))[0]![1]).toBe(await expectKey('+201212345678'));
    expect((await keys(GONE))[0]![1]).toBeNull();
  });

  it('is idempotent: a rerun stamps nothing and never overwrites a stamped key', async () => {
    const before = await keys(S1);
    const r = await run(() => runBuyerKeyBackfill({ secret: SECRET, dryRun: false, budget: 100 }));
    expect(r.totals.keyed).toBe(0);
    expect(await keys(S1)).toEqual(before);
    // a different key already on an order is not replaced
    await sql(S2, 'UPDATE orders SET buyer_key = ?', 'ab'.repeat(32));
    await run(() => runBuyerKeyBackfill({ secret: SECRET, dryRun: false, budget: 100 }));
    expect((await keys(S2))[0]![1]).toBe('ab'.repeat(32));
  });

  it('is resumable: a budget of 2 walks the whole fleet through nextCursor to the same result, then reports done', async () => {
    await reset(S1);
    await reset(S2);
    let cursor: string | undefined;
    let keyed = 0;
    let calls = 0;
    do {
      const r = await run(() =>
        runBuyerKeyBackfill({ secret: SECRET, dryRun: false, budget: 2, cursor })
      );
      keyed += r.totals.keyed;
      cursor = r.nextCursor ?? undefined;
      calls++;
      if (cursor) expect(decodeCursor(cursor)).not.toBeNull();
    } while (cursor && calls < 20);
    expect(cursor).toBeUndefined();
    expect(calls).toBeGreaterThan(1);
    expect(keyed).toBe(3);
    expect((await keys(S1)).filter(([, k]) => k).length).toBe(2);
    expect((await keys(S2))[0]![1]).toBe(await expectKey('+201212345678'));
  });

  it('can be limited to one store, and refuses to run without the suite secret', async () => {
    await reset(S1);
    const r = await run(() => runBuyerKeyBackfill({ secret: SECRET, dryRun: false, storeId: S1 }));
    expect(r.stores.map(s => s.storeId)).toEqual([S1]);
    await expect(runBuyerKeyBackfill({ secret: 'short', dryRun: true })).rejects.toThrow(
      'SUITE_BUYER_KEY_SECRET'
    );
  });

  it('a live store with no orders is done with nothing to do (not skipped)', async () => {
    const empty = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
    await e.PLATFORM_DB.prepare(
      "INSERT INTO stores (id, name, slug, owner_id, storage_backend, status, created_at, updated_at) VALUES (?1, 'x', 'bf-empty', 'owner', 'do', 'active', 1, 1)"
    )
      .bind(empty)
      .run();
    const r = await run(() => runBuyerKeyBackfill({ secret: SECRET, dryRun: true, budget: 100 }));
    expect(r.stores.find(s => s.storeId === empty)).toMatchObject({
      scanned: 0,
      keyed: 0,
      skipped: null,
      done: true,
    });
  });
});
