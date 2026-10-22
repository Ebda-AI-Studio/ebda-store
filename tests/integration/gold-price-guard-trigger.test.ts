/**
 * Gold-rate pricing, Task 9 (Ruling B5-13): the BEFORE trigger `ebda_gold_price_guard` is what makes
 * "the repricer is the only writer of a gold row's price" true for every writer that exists
 * (ProductService, VariantService, CSV import, MCP admin tools, mass edit) and every future one.
 * A price / compare_at_price change, an INSERT, or a switch INTO gold on a gold row is refused with
 * GOLD_PRICE_MANAGED (SQLSTATE P0001) unless the transaction set `app.gold_reprice = 'on'` through
 * set_config(..., true). Every assertion runs as `ebda_app` with the tenant GUC set, on ONE pooled
 * connection (max 1), so the no-leak proof means something.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { hasDb } from '../helpers/bundle-fixtures';
import {
  appPool,
  createProduct,
  createStore,
  deleteStores,
  inStoreTx,
  ownerPool,
  sqlMessage,
  sqlState,
  tag,
  uid,
} from '../helpers/gold-sql';

const GOLD = {
  mode: 'gold_rate' as const,
  karat: 21,
  weightMg: 3250,
  makingType: 'per_gram' as const,
  makingValue: 15000,
};

describe.skipIf(!hasDb)('ebda_gold_price_guard (real Postgres, ebda_app)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const S = { storeId: '', userId: '' };
  const t = tag();

  const setPrice = (c: pg.PoolClient, id: string, price: number) =>
    c.query(`update products set price = $1 where id = $2 and store_id = $3`, [
      price,
      id,
      S.storeId,
    ]);
  const refused = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return { code: sqlState(e), message: sqlMessage(e) };
    }
    return null;
  };

  beforeAll(async () => {
    owner = ownerPool();
    app = appPool();
    Object.assign(S, await createStore(owner, `guard-${t}`));
  });
  afterAll(async () => {
    await deleteStores(owner, [S.storeId], [S.userId]);
    await app.end();
    await owner.end();
  });

  it('an UPDATE of price on a gold product without the GUC is refused: GOLD_PRICE_MANAGED / P0001', async () => {
    const id = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
    const r = await refused(() => inStoreTx(app, S.storeId, c => setPrice(c, id, 1)));
    expect(r?.code).toBe('P0001');
    expect(r?.message).toContain('GOLD_PRICE_MANAGED');
    expect(
      (await owner.query(`select price from products where id = $1`, [id])).rows[0].price
    ).toBe(1921800);
  });

  it('the same UPDATE inside set_config(app.gold_reprice, on, true) succeeds', async () => {
    const id = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
    await inStoreTx(app, S.storeId, c => setPrice(c, id, 1925000), { goldReprice: true });
    expect(
      (await owner.query(`select price from products where id = $1`, [id])).rows[0].price
    ).toBe(1925000);
  });

  it('the GUC does not leak: the next transaction on the SAME pooled connection is refused again', async () => {
    const id = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
    await inStoreTx(app, S.storeId, c => setPrice(c, id, 1926000), { goldReprice: true });
    // pool max is 1: this transaction reuses the connection that just carried the GUC
    const r = await refused(() => inStoreTx(app, S.storeId, c => setPrice(c, id, 2)));
    expect(r?.code).toBe('P0001');
  });

  it('a plain UPDATE that does not touch price, compare_at_price or the mode passes on a gold row', async () => {
    const id = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
    await inStoreTx(app, S.storeId, c =>
      c.query(
        `update products set name = 'Renamed', inventory = 3 where id = $1 and store_id = $2`,
        [id, S.storeId]
      )
    );
    expect((await owner.query(`select name from products where id = $1`, [id])).rows[0].name).toBe(
      'Renamed'
    );
  });

  it('an INSERT of a gold product without the GUC is refused; with it, it lands', async () => {
    const ins = (c: pg.PoolClient) =>
      c.query(
        `insert into products (id, store_id, name, slug, price, updated_at, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value)
         values ($1, $2, 'G', $3, 1000, now(), 'gold_rate', 21, 3000, 'fixed', 0)`,
        [uid(), S.storeId, `g-${uid().slice(0, 8)}`]
      );
    expect((await refused(() => inStoreTx(app, S.storeId, ins)))?.code).toBe('P0001');
    await inStoreTx(app, S.storeId, ins, { goldReprice: true });
  });

  it('switching a fixed product INTO gold without the GUC is refused (the price would stay unmanaged)', async () => {
    const id = await createProduct(owner, S.storeId, { price: 500000 });
    const toGold = (c: pg.PoolClient) =>
      c.query(
        `update products set pricing_mode = 'gold_rate', gold_karat = 21, gold_weight_mg = 3000, making_charge_type = 'fixed', making_charge_value = 0 where id = $1 and store_id = $2`,
        [id, S.storeId]
      );
    expect((await refused(() => inStoreTx(app, S.storeId, toGold)))?.code).toBe('P0001');
    await inStoreTx(app, S.storeId, toGold, { goldReprice: true });
  });

  it('switching gold -> fixed is not guarded (the service freezes the last price)', async () => {
    const id = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
    await inStoreTx(app, S.storeId, c =>
      c.query(`update products set pricing_mode = 'fixed' where id = $1 and store_id = $2`, [
        id,
        S.storeId,
      ])
    );
    expect(
      (await owner.query(`select pricing_mode, price from products where id = $1`, [id])).rows[0]
    ).toMatchObject({
      pricing_mode: 'fixed',
      price: 1921800,
    });
  });

  it("a fixed product's price UPDATE is unaffected", async () => {
    const id = await createProduct(owner, S.storeId, { price: 1000 });
    await inStoreTx(app, S.storeId, c => setPrice(c, id, 2000));
    expect(
      (await owner.query(`select price from products where id = $1`, [id])).rows[0].price
    ).toBe(2000);
  });

  it('a gold row cannot carry a compare-at price, even with the GUC (Ruling B5-19, CHECK)', async () => {
    const id = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
    const r = await refused(() =>
      inStoreTx(
        app,
        S.storeId,
        c =>
          c.query(
            `update products set compare_at_price = 2000000 where id = $1 and store_id = $2`,
            [id, S.storeId]
          ),
        { goldReprice: true }
      )
    );
    expect(r?.code).toBe('23514');
  });

  describe('variants: NULL pricing_mode inherits the product', () => {
    const makeVariant = async (
      productId: string,
      mode: string | null,
      price: number | null = 1000
    ) => {
      const id = uid();
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query(`select set_config('app.gold_reprice', 'on', true)`);
        await c.query(
          `insert into product_variants (id, product_id, title, price, updated_at, pricing_mode) values ($1, $2, 'V', $3, now(), $4)`,
          [id, productId, price, mode]
        );
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      return id;
    };
    const setVariantPrice = (id: string, price: number) => (c: pg.PoolClient) =>
      c.query(`update product_variants set price = $1 where id = $2`, [price, id]);

    it('a variant with mode NULL on a gold product is guarded', async () => {
      const p = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
      const v = await makeVariant(p, null);
      expect((await refused(() => inStoreTx(app, S.storeId, setVariantPrice(v, 5))))?.code).toBe(
        'P0001'
      );
      await inStoreTx(app, S.storeId, setVariantPrice(v, 6), { goldReprice: true });
    });

    it("a variant with mode 'fixed' on a gold product is NOT guarded", async () => {
      const p = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
      const v = await makeVariant(p, 'fixed');
      await inStoreTx(app, S.storeId, setVariantPrice(v, 7));
      expect(
        (await owner.query(`select price from product_variants where id = $1`, [v])).rows[0].price
      ).toBe(7);
    });

    it('a variant with mode NULL on a fixed product is NOT guarded; an explicit gold variant is', async () => {
      const p = await createProduct(owner, S.storeId, { price: 1000 });
      const free = await makeVariant(p, null);
      await inStoreTx(app, S.storeId, setVariantPrice(free, 9));
      const gold = await makeVariant(p, 'gold_rate');
      expect((await refused(() => inStoreTx(app, S.storeId, setVariantPrice(gold, 9))))?.code).toBe(
        'P0001'
      );
    });

    it('an INSERT of a variant under a gold product without the GUC is refused', async () => {
      const p = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
      const r = await refused(() =>
        inStoreTx(app, S.storeId, c =>
          c.query(
            `insert into product_variants (id, product_id, title, price, updated_at) values ($1, $2, 'V', 5, now())`,
            [uid(), p]
          )
        )
      );
      expect(r?.code).toBe('P0001');
    });
  });

  it('NEGATIVE CONTROL: with the trigger dropped the first assertion goes green, so the test can fail', async () => {
    const id = await createProduct(owner, S.storeId, { ...GOLD, price: 1921800 });
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`select set_config('app.current_store_id', $1, true)`, [S.storeId]);
      // with the trigger in place the superuser is refused too (triggers fire for every role)
      await c.query('SAVEPOINT guarded');
      let blocked = false;
      try {
        await c.query(`update products set price = 1 where id = $1`, [id]);
      } catch {
        blocked = true;
      }
      await c.query('ROLLBACK TO SAVEPOINT guarded');
      expect(blocked).toBe(true);
      await c.query('DROP TRIGGER ebda_gold_price_guard ON products');
      await c.query(`update products set price = 1 where id = $1`, [id]);
      expect((await c.query(`select price from products where id = $1`, [id])).rows[0].price).toBe(
        1
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    // the rollback restored the trigger: the guard is back
    const r = await refused(() => inStoreTx(app, S.storeId, cc => setPrice(cc, id, 3)));
    expect(r?.code).toBe('P0001');
  });
});
