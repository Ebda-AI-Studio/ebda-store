import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyD1Migrations } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';
import {
  HUB_FANOUT_CAP,
  HUB_FANOUT_CONCURRENCY,
  hubFanout,
  hubFanoutStoreIds,
  hubStorePage,
} from '../src/lib/platform-hub';

// N-17 (NEON-ZERO, plan item 5): the super-admin cross-store fan-out over the D1 directory and REAL StoreDOs. Every store is
// visited (no silent cap), pages are complete and disjoint, the bound is REPORTED (`truncated`), a failing store is skipped
// without dropping the others, and in-flight work never exceeds the pool. The HTTP side (403 for a store admin, the admin
// product/store lists over four DO stores) is workers-test/admin-cross-store.test.ts.
const e = env as unknown as {
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: DurableObjectNamespace<StoreDO>;
};
const T0 = 1_700_000_000_000;
const PER_STORE = [2, 3, 1, 4];
const ids = PER_STORE.map((_, i) => `hub-store-${i}`);

const insertStore = (id: string, owner: string, createdAt: number, deleted = false) =>
  e.PLATFORM_DB.prepare(
    'INSERT INTO stores (id, name, slug, owner_id, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)'
  )
    .bind(id, `Name ${id}`, `slug-${id}`, owner, createdAt, deleted ? createdAt : null)
    .run();

describe('hub fan-out over the D1 directory and real StoreDOs', () => {
  it('fixture: four DO stores with 2/3/1/4 products, one deleted store, bindings set', async () => {
    setCfBindings(e as unknown as CfBindings);
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const [i, id] of ids.entries()) {
      await insertStore(id, i < 2 ? 'owner-a' : 'owner-b', T0 + i * 1000);
      await e.STORE_DO.get(e.STORE_DO.idFromName(id)).seed({
        store: { id, slug: `slug-${id}`, name: id, currency: 'EGP', createdAt: T0, updatedAt: T0 },
        products: Array.from({ length: PER_STORE[i]! }, (_, j) => ({
          id: `${id}-p${j}`,
          storeId: id,
          name: `P${j}`,
          slug: `p${j}`,
          price: 100,
          inventory: 1,
          status: 'active',
          hasVariants: false,
          createdAt: T0,
          updatedAt: T0,
        })),
      });
    }
    await insertStore('hub-store-deleted', 'owner-a', T0 + 9000, true);
  });

  it('hubFanoutStoreIds returns every live store, newest first, and none that is deleted', async () => {
    const r = await hubFanoutStoreIds();
    expect(r.truncated).toBe(false);
    expect(r.ids).toEqual([...ids].reverse());
    expect((await hubFanoutStoreIds('owner-a')).ids).toEqual(['hub-store-1', 'hub-store-0']);
    expect((await hubFanoutStoreIds('owner-nobody')).ids).toEqual([]);
  });

  it("hubFanout visits every store and each answer is that store's own data", async () => {
    const all = (await hubFanoutStoreIds()).ids;
    const visited: string[] = [];
    const parts = await hubFanout(all, async storeId => {
      visited.push(storeId);
      return e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).rowCounts();
    });
    expect(new Set(visited)).toEqual(new Set(ids));
    expect(visited.length).toBe(ids.length);
    expect(parts.map(p => p.storeId)).toEqual(all);
    for (const p of parts)
      expect(p.value.products, p.storeId).toBe(PER_STORE[ids.indexOf(p.storeId)]);
  });

  it('hubStorePage pages are complete and disjoint at every page size, with the filtered total', async () => {
    for (const take of [1, 2, 3, 4, 10]) {
      const seen: string[] = [];
      for (let skip = 0; skip < ids.length + take; skip += take) {
        const page = await hubStorePage({ skip, take });
        expect(page.total).toBe(ids.length);
        seen.push(...page.rows.map(s => s.id));
      }
      expect(seen, `take ${take}`).toEqual([...ids].reverse());
    }
    expect((await hubStorePage({ skip: 0, take: 10, ownerId: 'owner-b' })).total).toBe(2);
  });

  it('a failing store is skipped and reported, the others are still visited; the pool never exceeds its bound', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `s${i}`);
    let inFlight = 0;
    let peak = 0;
    const failed: string[] = [];
    const parts = await hubFanout(
      many,
      async id => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        if (id === 's7') throw new Error('store 7 is down');
        return id;
      },
      id => failed.push(id)
    );
    expect(failed).toEqual(['s7']);
    expect(parts.map(p => p.storeId)).toEqual(many.filter(i => i !== 's7'));
    expect(peak).toBeLessThanOrEqual(HUB_FANOUT_CONCURRENCY);
    // without an onError a failure is fatal: a caller that wants a partial answer must ask for it
    await expect(hubFanout(['x'], async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );
  });

  it('the cap is reported, never silent: more stores than the cap -> exactly CAP ids and truncated=true', async () => {
    const extra = HUB_FANOUT_CAP + 5;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < extra; i++)
      stmts.push(
        e.PLATFORM_DB.prepare(
          'INSERT INTO stores (id, name, slug, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)'
        ).bind(`cap-${i}`, `Cap ${i}`, `cap-${i}`, 'owner-cap', T0 + 100_000 + i)
      );
    for (let i = 0; i < stmts.length; i += 50) await e.PLATFORM_DB.batch(stmts.slice(i, i + 50));
    const r = await hubFanoutStoreIds();
    expect(r.ids.length).toBe(HUB_FANOUT_CAP);
    expect(r.truncated).toBe(true);
    // newest first: the cut drops the OLDEST stores, which here are the four DO stores
    expect(r.ids.includes('hub-store-0')).toBe(false);
    expect(r.ids[0]).toBe(`cap-${extra - 1}`);
    // a store admin's own scope is below the cap: complete, not truncated
    expect(await hubFanoutStoreIds('owner-a')).toEqual({
      ids: ['hub-store-1', 'hub-store-0'],
      truncated: false,
    });
    // an explicit `only` list is cut and reported the same way
    const only = Array.from({ length: HUB_FANOUT_CAP + 1 }, (_, i) => `o${i}`);
    expect(await hubFanoutStoreIds(undefined, only)).toMatchObject({ truncated: true });
    expect((await hubFanoutStoreIds(undefined, only)).ids.length).toBe(HUB_FANOUT_CAP);
    // and the paged directory still sees the total, so a caller can tell the view is partial
    expect((await hubStorePage({ skip: 0, take: 1 })).total).toBe(ids.length + extra);
  });
});
