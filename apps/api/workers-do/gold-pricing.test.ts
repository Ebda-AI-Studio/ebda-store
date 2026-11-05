import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 PR D2b-5 (Ruling CF-LAST-1): product pricing edits on real workerd. Postgres serialised these with
// `pg_advisory_xact_lock(gold-rate:<store>)`; here the single thread does. A concurrent rate change, spec edit, bulk switch and
// variant create can never leave a gold price that is not the one the CURRENT rate and the stored spec produce.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const val = (a: Answer) => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<any>(a.json);
};
const rows = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).toArray() as any[]);
const GOLD = {
  pricingMode: 'gold_rate',
  karat: 21,
  weightMg: 3250,
  makingChargeType: 'per_gram',
  makingChargeValue: 15_000,
  marginBps: 0,
};

async function seed(store: string, products: string[]) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  await runInDurableObject(stub, (_i, s) => {
    for (const id of products)
      s.storage.sql.exec(
        `INSERT INTO products (id, store_id, name, slug, price, status, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps)
         VALUES (?, ?, 'P', ?, 1000, 'active', 21, 3250, 'per_gram', 15000, 0)`,
        id,
        store,
        id
      );
  });
  val(
    await op(stub, store, 'goldApplyRates', {
      input: { rates: [{ karat: 21, ratePerGram: 576_000 }], confirm: true },
      userId: 'u1',
    })
  );
  return stub;
}
/** every variant-less gold product's price is what the current rate + its stored spec give: 3250 mg of 576000/g + 15000/g making */
async function assertNoTornPrice(stub: ReturnType<typeof stubFor>) {
  const bad = await rows(
    stub,
    `SELECT p.id, p.price, p.gold_rate_id, c.rate_id FROM products p, gold_rates_current c
      WHERE p.pricing_mode = 'gold_rate' AND c.karat = p.gold_karat AND (p.gold_rate_id IS NOT c.rate_id)
        AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)`
  );
  expect(bad).toEqual([]);
  const flag = await rows(stub, "SELECT value FROM do_flags WHERE name = 'gold_reprice'");
  expect(flag[0]?.value ?? 0).toBe(0);
}

describe('gold product pricing on the StoreDO', () => {
  it('30 concurrent edits (gold / fixed alternately) plus rate changes never leave a torn price', async () => {
    const store = 'gp-edit';
    const stub = await seed(store, ['a']);
    const jobs: Promise<Answer>[] = [];
    for (let i = 0; i < 30; i++) {
      jobs.push(
        op(stub, store, 'goldSetProductPricing', {
          productId: 'a',
          product: i % 2 ? { pricingMode: 'fixed' } : GOLD,
        })
      );
      if (i % 5 === 0)
        jobs.push(
          op(stub, store, 'goldApplyRates', {
            input: { rates: [{ karat: 21, ratePerGram: 576_000 + i * 1000 }], confirm: true },
            userId: 'u1',
          })
        );
    }
    const out = await Promise.all(jobs);
    expect(out.every(a => a.ok)).toBe(true);
    await assertNoTornPrice(stub);
  });

  it('20 concurrent bulk switches switch each product exactly once', async () => {
    const store = 'gp-bulk';
    const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
    const stub = await seed(store, ids);
    const out = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, store, 'goldBulkSwitchMode', { ids, mode: 'gold_rate' })
      )
    );
    const switched = out.flatMap(a => val(a).switched as string[]);
    expect(switched.sort()).toEqual([...ids].sort());
    expect(
      out
        .map(a => val(a).skipped.filter((s: any) => s.reason === 'ALREADY').length)
        .reduce((x, y) => x + y, 0)
    ).toBe(19 * 12);
    await assertNoTornPrice(stub);
  });

  it('20 concurrent variant creates on a gold product are all born priced; a rate change in between re-prices them', async () => {
    const store = 'gp-var';
    const stub = await seed(store, ['g']);
    val(await op(stub, store, 'goldSetProductPricing', { productId: 'g', product: GOLD }));
    const jobs: Promise<Answer>[] = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(
        op(stub, store, 'goldCreateVariant', {
          productId: 'g',
          variant: { title: `v${i}` },
          optionValueIds: [],
        })
      );
      if (i === 10)
        jobs.push(
          op(stub, store, 'goldApplyRates', {
            input: { rates: [{ karat: 21, ratePerGram: 580_000 }], confirm: true },
            userId: 'u1',
          })
        );
    }
    expect((await Promise.all(jobs)).every(a => a.ok)).toBe(true);
    const unpriced = await rows(
      stub,
      'SELECT id FROM product_variants WHERE price IS NULL OR gold_rate_id IS NULL'
    );
    expect(unpriced).toEqual([]);
    const stale = await rows(
      stub,
      'SELECT v.id FROM product_variants v, gold_rates_current c WHERE c.karat = 21 AND v.gold_rate_id IS NOT c.rate_id'
    );
    expect(stale).toEqual([]);
    await assertNoTornPrice(stub);
  });

  it('a variant create with the rate gone is refused and leaves nothing (30 concurrent)', async () => {
    const store = 'gp-norate';
    const stub = await seed(store, ['g']);
    val(await op(stub, store, 'goldSetProductPricing', { productId: 'g', product: GOLD }));
    await runInDurableObject(stub, (_i, s) => s.storage.sql.exec('DELETE FROM gold_rates_current'));
    const out = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        op(stub, store, 'goldCreateVariant', {
          productId: 'g',
          variant: { title: `v${i}` },
          optionValueIds: [],
        })
      )
    );
    expect(out.every(a => !a.ok && a.code === 'GOLD_RATE_MISSING')).toBe(true);
    expect(await rows(stub, 'SELECT id FROM product_variants')).toEqual([]);
  });
});
