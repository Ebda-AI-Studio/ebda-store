/**
 * Gold-rate pricing, Task 11: the two cron-facing SECURITY DEFINER functions. The crons have no
 * tenant scope and an idle tick must cost one Inngest execution, so they ask these first. Run as a
 * real `ebda_app` login with NO tenant context (exactly how a cron calls them).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { hasDb } from '../helpers/bundle-fixtures';
import {
  appPool,
  createProduct,
  createStore,
  deleteStores,
  ownerPool,
  tag,
  uid,
} from '../helpers/gold-sql';

const GOLD = {
  mode: 'gold_rate' as const,
  karat: 21,
  weightMg: 3000,
  makingType: 'fixed' as const,
  makingValue: 0,
};

describe.skipIf(!hasDb)('ebda_gold_feed_stores / ebda_gold_rate_watch', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const t = tag();
  const mk = {} as Record<string, { storeId: string; userId: string }>;

  const seedRate = async (storeId: string, karat: number, ageMinutes: number) => {
    const id = uid();
    await owner.query(
      `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status, applied_at) values ($1, $2, $3, 576323, 'manual', 'applied', now() - make_interval(mins => $4))`,
      [id, storeId, karat, ageMinutes]
    );
    await owner.query(
      `insert into gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) values ($1, $2, $3, 576323, now() - make_interval(mins => $4))`,
      [storeId, karat, id, ageMinutes]
    );
    return id;
  };
  const settings = (
    storeId: string,
    o: { enabled?: boolean; feed?: boolean; maxAge?: number; premium?: number }
  ) =>
    owner.query(
      `insert into gold_rate_settings (store_id, enabled, feed_enabled, max_age_minutes, feed_premium_bps) values ($1, $2, $3, $4, $5)`,
      [storeId, o.enabled ?? true, o.feed ?? false, o.maxAge ?? 1560, o.premium ?? 0]
    );
  const feedStores = async () =>
    (await app.query(`select store_id, feed_premium_bps from ebda_gold_feed_stores()`))
      .rows as Array<{ store_id: string; feed_premium_bps: number }>;
  const watch = async () =>
    (
      await app.query(
        `select store_id, karat, rate_id, max_age_minutes from ebda_gold_rate_watch()`
      )
    ).rows as Array<{ store_id: string; karat: number; rate_id: string }>;
  const mine = <T extends { store_id: string }>(rows: T[]) =>
    rows.filter(r => Object.values(mk).some(s => s.storeId === r.store_id));

  beforeAll(async () => {
    owner = ownerPool();
    app = appPool();
    for (const k of [
      'feedOn',
      'feedOff',
      'inactive',
      'fresh',
      'warn',
      'blocked',
      'noGold',
      'notEnabled',
      'variantKarat',
    ])
      mk[k] = await createStore(owner, `cron-${k}-${t}`);
    // feed
    await settings(mk.feedOn.storeId, { feed: true, premium: 150 });
    await settings(mk.feedOff.storeId, { feed: false });
    await settings(mk.inactive.storeId, { feed: true });
    await owner.query(`update stores set status = 'suspended' where id = $1`, [
      mk.inactive.storeId,
    ]);
    // watch (max age 26 h = 1560 min; warn window starts at 1320 min)
    for (const [k, age] of [
      ['fresh', 600],
      ['warn', 1330],
      ['blocked', 1600],
      ['noGold', 1600],
      ['notEnabled', 1600],
    ] as const) {
      await settings(mk[k].storeId, { enabled: k !== 'notEnabled' });
      await seedRate(mk[k].storeId, 21, age);
      if (k !== 'noGold') await createProduct(owner, mk[k].storeId, { ...GOLD });
    }
    // a store whose only gold use is a VARIANT override at 18k
    await settings(mk.variantKarat.storeId, {});
    await seedRate(mk.variantKarat.storeId, 18, 1600);
    const pid = await createProduct(owner, mk.variantKarat.storeId, { ...GOLD, karat: 24 });
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`select set_config('app.gold_reprice','on',true)`);
      await c.query(
        `insert into product_variants (id, product_id, title, price, updated_at, pricing_mode, gold_karat) values ($1, $2, 'V', 1, now(), 'gold_rate', 18)`,
        [uid(), pid]
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await deleteStores(
      owner,
      Object.values(mk).map(s => s.storeId),
      Object.values(mk).map(s => s.userId)
    );
    await app.end();
    await owner.end();
  });

  it('feed stores: only those that turned the automatic rate on and are active; the premium comes through', async () => {
    const rows = mine(await feedStores());
    expect(rows).toEqual([{ store_id: mk.feedOn.storeId, feed_premium_bps: 150 }]);
  });

  it('watch: a fresh rate is silent; inside the warning window or past the max age it is returned', async () => {
    const ids = new Set(mine(await watch()).map(r => r.store_id));
    expect(ids.has(mk.fresh.storeId)).toBe(false);
    expect(ids.has(mk.warn.storeId)).toBe(true);
    expect(ids.has(mk.blocked.storeId)).toBe(true);
  });

  it('watch: a store with the feature on but ZERO gold products is skipped; so is a store that did not opt in', async () => {
    const ids = new Set(mine(await watch()).map(r => r.store_id));
    expect(ids.has(mk.noGold.storeId)).toBe(false);
    expect(ids.has(mk.notEnabled.storeId)).toBe(false);
  });

  it('watch: a karat used only by a VARIANT override counts', async () => {
    const r = mine(await watch()).filter(x => x.store_id === mk.variantKarat.storeId);
    expect(r.map(x => x.karat)).toEqual([18]);
  });

  it('both are SECURITY DEFINER with a pinned search_path and EXECUTE for ebda_app only', async () => {
    const r = await owner.query(
      `select p.proname, p.prosecdef, p.proconfig, p.proacl::text as acl, has_function_privilege('ebda_app', p.oid, 'EXECUTE') as app_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ebda_gold_feed_stores', 'ebda_gold_rate_watch')`
    );
    expect(r.rows).toHaveLength(2);
    for (const f of r.rows) {
      expect(f.prosecdef, f.proname).toBe(true);
      expect(
        (f.proconfig as string[]).some(c => /^search_path=pg_catalog, public, pg_temp$/.test(c)),
        f.proname
      ).toBe(true);
      expect(f.app_exec, f.proname).toBe(true);
      expect(/(^|,)=X\//.test(f.acl ?? ''), `${f.proname} PUBLIC`).toBe(false);
    }
  });

  it('they return routing facts and numbers only: no price, no person, no rate history', async () => {
    const cols = await owner.query(
      `select p.proname, pg_get_function_result(p.oid) as result from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ebda_gold_feed_stores', 'ebda_gold_rate_watch')`
    );
    const all = cols.rows.map(r => r.result).join(' ');
    expect(all).not.toMatch(/price|email|rate_per_gram|name/i);
  });
});
