// P2-3 (2026-11-12 data-jobs audit): StoreDO.restoreFrom must restore a gold-rate store. The ebda_gold_price_guard_* triggers abort a
// gold-rate product / variant insert unless do_flags.gold_reprice = 1, which rolled back the whole restore before loadBackup raised it.
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';

const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stub = (n: string) => e.STORE_DO.get(e.STORE_DO.idFromName(n));
const day = () => new Date().toISOString().slice(0, 10);

describe('restoreFrom with gold-rate products', () => {
  it('restores a gold product and its variants, row-for-row, and leaves gold_reprice cleared', async () => {
    const S = 'rg-src';
    const src = stub(S);
    await runInDurableObject(src, (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1) ON CONFLICT (name) DO UPDATE SET value = 1`
      );
      s.storage.sql.exec(
        `INSERT INTO products (id, store_id, name, slug, price, status, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps)
         VALUES ('gp1', ?, 'Ring', 'ring', 1000, 'active', 'gold_rate', 21, 3250, 'per_gram', 15000, 0)`,
        S
      );
      s.storage.sql.exec(
        `INSERT INTO product_variants (id, product_id, title, sku, price, pricing_mode) VALUES ('gv1', 'gp1', 'V', 'R-1', 1200, 'gold_rate')`
      );
      s.storage.sql.exec(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`);
    });
    await runInDurableObject(src, (d: StoreDO) => d.backupNow(S));

    const T = 'rg-target';
    const res = await stub(T).restoreFrom(S, day());
    expect(JSON.stringify(res)).toContain('"ok":true');
    if (res.ok) for (const t of Object.values(res.data)) expect(t.ok).toBe(true);
    const got = await runInDurableObject(stub(T), (_i, s) => ({
      p: s.storage.sql.exec(`SELECT id, price FROM products WHERE id = 'gp1'`).toArray(),
      v: s.storage.sql.exec(`SELECT id, price FROM product_variants WHERE id = 'gv1'`).toArray(),
      f: s.storage.sql.exec(`SELECT value FROM do_flags WHERE name = 'gold_reprice'`).toArray(),
    }));
    expect(got.p).toEqual([{ id: 'gp1', price: 1000 }]);
    expect(got.v).toEqual([{ id: 'gv1', price: 1200 }]);
    expect(got.f.every(r => r.value === 0)).toBe(true);
  });

  it('a non-gold store restores with every table ok and no gold_reprice row left behind', async () => {
    const S = 'rg-plain-src';
    const src = stub(S);
    await runInDurableObject(src, (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO products (id, store_id, name, slug, price, status) VALUES ('pp1', ?, 'Mug', 'mug', 500, 'active')`,
        S
      );
    });
    await runInDurableObject(src, (d: StoreDO) => d.backupNow(S));
    const T = 'rg-plain-target';
    const res = await stub(T).restoreFrom(S, day());
    expect(res.ok).toBe(true);
    if (res.ok) for (const [t, v] of Object.entries(res.data)) expect([t, v.ok]).toEqual([t, true]);
    const f = await runInDurableObject(stub(T), (_i, s) =>
      s.storage.sql.exec(`SELECT value FROM do_flags WHERE name = 'gold_reprice'`).toArray()
    );
    expect(f).toEqual([]);
  });
});
