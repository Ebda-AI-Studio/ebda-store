import {
  applyPaymentEvent,
  beginRefund,
  completeRefund,
  createPayment,
  ensurePaymentSchema,
  releaseRefund,
  type PaymentWebhookInput,
} from '../../src/do/payments';
import { matchingCustomers } from '../../src/do/search-customers';
import {
  applyGoldRates,
  decidePendingGoldRate,
  updateGoldSettings,
  repriceGoldProduct,
} from '../../src/do/gold-rates';
import { DurableObject } from 'cloudflare:workers';
import store0001 from '../../../cf-schema/migrations/store/0001_init.sql';
import store0002 from '../../../cf-schema/migrations/store/0002_invariants.sql';
import meta from '../../../cf-schema/generated/prisma-meta.json';
import { createPrismaLite } from '../../src/prisma-lite/client';
import { doSqlRunner, doSyncSql } from '../../src/prisma-lite/do-runner';
import { placeOrder, type CheckoutInput } from '../../src/do/checkout';
import {
  ensureSearchIndex,
  reindexStore,
  searchProductIdSet,
  verifyProductIndex,
} from '../../src/do/search';
import { cancelOrder, refundOrder } from '../../src/do/refund';
import { MoneyError } from '../../src/do/sync-sql';
import { splitSql } from '../../src/prisma-lite/split-sql';
import type { Meta } from '../../src/prisma-lite/types';

/** A StoreDO stand-in: the real schema, the real runner, prisma-lite on top. */
export class LiteDO extends DurableObject {
  lite: any;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        for (const stmt of [...splitSql(store0001), ...splitSql(store0002)])
          ctx.storage.sql.exec(stmt);
      });
    });
    // the StoreDO bootstrap: the search index schema + dirty-marking triggers (idempotent; backfills an existing store)
    ctx.blockConcurrencyWhile(async () => {
      ensureSearchIndex(doSyncSql(ctx.storage));
      ensurePaymentSchema(doSyncSql(ctx.storage));
    });
    this.lite = createPrismaLite(meta as unknown as Meta, doSqlRunner(ctx.storage), 'store-do', {
      storeId: 's1',
    });
  }

  /** Money fixtures: one SKU with `stock` units, a coupon with `couponUses` uses, a wallet with `wallet` piastres. */
  seedMoney(stock: number, couponUses: number, wallet: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'widget', 1500, ?, 'active')`,
      stock
    );
    sql.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, scope_product_ids, scope_category_ids) VALUES ('c', 's1', 'SALE', 'sale', 'fixed', 100, ?, '[]', '[]')`,
      couponUses
    );
    sql.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('cust', 's1', 'A', 'B')`
    );
    sql.exec(
      `INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w', 's1', 'cust', ?)`,
      wallet
    );
  }
  /** Insert one option value with this swatch colour on the real schema; returns 'ok' or the SQLite error text. */
  insertSwatch(hex: string | null): string {
    const sql = this.ctx.storage.sql;
    try {
      sql.exec(
        `INSERT OR IGNORE INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('swp', 's1', 'Shirt', 'shirt', 100, 1, 'active')`
      );
      sql.exec(
        `INSERT OR IGNORE INTO product_options (id, product_id, name, position) VALUES ('swo', 'swp', 'Colour', 0)`
      );
      sql.exec(`DELETE FROM product_option_values WHERE option_id = 'swo'`);
      sql.exec(
        `INSERT INTO product_option_values (id, option_id, value, swatch_hex) VALUES ('swv', 'swo', 'x', ?)`,
        hex
      );
      return 'ok';
    } catch (e) {
      return String((e as Error).message);
    }
  }
  seedPerUserCoupon(): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit_per_user, scope_product_ids, scope_category_ids) VALUES ('pu', 's1', 'ONCE', 'once', 'fixed', 100, 1, '[]', '[]')`
    );
  }
  /** A DO store always has its profile row; an order's sale document reads the seller from it (Ruling CF-R2-1). */
  private profile(): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO store_profile (store_id, name, slug, owner_id) VALUES ('s1', 'Shop', 's1', 'owner')`
    );
  }
  checkout(input: CheckoutInput): { ok: true; orderId: string } | { ok: false; code: string } {
    this.profile();
    try {
      return {
        ok: true,
        orderId: placeOrder(doSyncSql(this.ctx.storage), { ...input, storeId: 's1' }).orderId,
      };
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, code: e.code };
      throw e;
    }
  }
  snapshot(): Record<string, number> {
    const one = (q: string) => this.ctx.storage.sql.exec(q).one().n as number;
    return {
      stock: one(`SELECT inventory AS n FROM products WHERE id = 'sku'`),
      orders: one('SELECT count(*) AS n FROM orders'),
      items: one(`SELECT coalesce(sum(quantity), 0) AS n FROM order_items`),
      sold: one(
        `SELECT coalesce(-sum(quantity), 0) AS n FROM inventory_history WHERE type = 'sale'` // a sale row is negative (CF-ORDERS-1 fixed the sign)
      ),
      couponUsed: one(`SELECT usage_count AS n FROM coupons WHERE id = 'c'`),
      couponOrders: one(`SELECT count(*) AS n FROM orders WHERE coupon_code = 'SALE'`),
      wallet: one(`SELECT balance AS n FROM customer_wallets WHERE id = 'w'`),
      walletSpent: one(`SELECT coalesce(-sum(amount), 0) AS n FROM wallet_transactions`),
      orderNumbers: one('SELECT count(DISTINCT order_number) AS n FROM orders'),
    };
  }

  /** Gold fixtures: one gold-priced piece (21k, 10 g, fixed making 50,000, 500 bps margin) with `stock` units, rate 300,000 */
  seedGold(stock: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1) ON CONFLICT (name) DO UPDATE SET value = 1`
    );
    sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps) VALUES ('ring', 's1', 'Ring', 'ring', 1, ?, 'active', 'gold_rate', 21, 10000, 'fixed', 50000, 500)`,
      stock
    );
    sql.exec(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`);
    sql.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('cust', 's1', 'A', 'B')`
    );
    this.applyRate(300_000);
  }
  applyRate(ratePerGram: number): { ok: true; repriced: number } | { ok: false; code: string } {
    try {
      const out = applyGoldRates(
        doSyncSql(this.ctx.storage),
        's1',
        { rates: [{ karat: 21, ratePerGram }], confirm: true },
        { userId: 'u' }
      );
      return { ok: true, repriced: out.repriced };
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, code: e.code };
      throw e;
    }
  }
  /** Every order of the gold piece: commit order (rowid), unit price, the rate stamped in its snapshot. */
  goldOrders(): Array<{ price: number; rate: number; rateId: string }> {
    return this.ctx.storage.sql
      .exec(
        `SELECT oi.price AS price, oi.gold_snapshot AS snap FROM order_items oi JOIN orders o ON o.id = oi.order_id ORDER BY o.rowid`
      )
      .toArray()
      .map(r => {
        const sn = JSON.parse(r.snap as string);
        return { price: r.price as number, rate: sn.ratePerGram, rateId: sn.rateId };
      });
  }
  goldState(): { stock: number; price: number; rate: number } {
    const one = (q: string) => this.ctx.storage.sql.exec(q).one().n as number;
    return {
      stock: one(`SELECT inventory AS n FROM products WHERE id = 'ring'`),
      price: one(`SELECT price AS n FROM products WHERE id = 'ring'`),
      rate: one(`SELECT rate_per_gram AS n FROM gold_rates_current WHERE karat = 21`),
    };
  }

  /** Search fixtures: the catalogue is [id, name, nameAr]; builds the FTS5 index on the real DO SQLite. */
  searchSeed(rows: Array<[string, string, string]>): number {
    const db = doSyncSql(this.ctx.storage);
    ensureSearchIndex(db);
    for (const [id, name, nameAr] of rows)
      this.ctx.storage.sql.exec(
        `INSERT INTO products (id, store_id, name, name_ar, slug, price, status) VALUES (?, 's1', ?, ?, ?, 100, 'active')`,
        id,
        name,
        nameAr,
        id
      );
    return reindexStore(db, 's1');
  }
  search(q: string, scope: 'storefront' | 'admin' = 'storefront'): string[] {
    return searchProductIdSet(doSyncSql(this.ctx.storage), 's1', q, { scope, limit: 10_000 }).ids;
  }
  searchDrift(): { missing: string[]; orphaned: string[]; stale: string[] } {
    return verifyProductIndex(doSyncSql(this.ctx.storage), 's1');
  }

  /** Generic fixtures/probes for the concurrency tests (the DO is the system under test, SQL is only setup + reading). */
  sqlRun(q: string, ...p: unknown[]): void {
    this.ctx.storage.sql.exec(q, ...p);
  }
  sqlOne(q: string, ...p: unknown[]): Record<string, number> {
    return this.ctx.storage.sql.exec(q, ...p).one() as Record<string, number>;
  }
  placeRaw(input: CheckoutInput): string {
    this.profile();
    return placeOrder(doSyncSql(this.ctx.storage), { ...input, storeId: 's1' }).orderId;
  }
  cancel(orderId: string): { ok: true; replayed: boolean } | { ok: false; code: string } {
    try {
      return {
        ok: true,
        replayed: cancelOrder(doSyncSql(this.ctx.storage), { storeId: 's1', orderId }).replayed,
      };
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, code: e.code };
      throw e;
    }
  }
  refund(a: {
    orderId: string;
    amount?: number;
    lines?: Array<{ orderItemId: string; quantity: number }>;
    refundKey?: string;
  }): { ok: true; replayed: boolean } | { ok: false; code: string } {
    try {
      return {
        ok: true,
        replayed: refundOrder(doSyncSql(this.ctx.storage), { storeId: 's1', ...a }).replayed,
      };
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, code: e.code };
      throw e;
    }
  }

  customerSearch(q: string): { userIds: string[]; guestOrderIds: string[] } {
    const m = matchingCustomers(doSyncSql(this.ctx.storage), 's1', q);
    return { userIds: m.userIds, guestOrderIds: m.guestOrderIds };
  }
  goldDecide(rateId: string, decision: 'confirm' | 'reject') {
    return decidePendingGoldRate(doSyncSql(this.ctx.storage), 's1', rateId, decision, {
      userId: 'owner',
    });
  }
  goldApplyFeed(ratePerGram: number): { pending: Array<{ id: string }> } {
    return applyGoldRates(
      doSyncSql(this.ctx.storage),
      's1',
      { rates: [{ karat: 21, ratePerGram }] },
      { feed: { src: 'test' } }
    );
  }
  goldSettings(roundingStep: 1 | 100 | 500 | 1000): { repriced: number } {
    return updateGoldSettings(
      doSyncSql(this.ctx.storage),
      's1',
      {
        enabled: true,
        feedEnabled: false,
        feedPremiumBps: 0,
        maxAgeMinutes: 1560,
        jumpConfirmBps: 500,
        roundingStep,
        showBreakdown: false,
      },
      { userId: 'owner' }
    );
  }
  goldRepriceProduct(productId: string): number {
    return repriceGoldProduct(doSyncSql(this.ctx.storage), 's1', productId);
  }

  // ---- payments (Phase 3.3) ----------------------------------------------------------------------------------------
  payCreate(a: { orderId: string; provider: string; transactionId?: string }): string {
    const total = this.ctx.storage.sql
      .exec('SELECT total FROM orders WHERE id = ?', a.orderId)
      .one().total as number;
    return createPayment(doSyncSql(this.ctx.storage), { storeId: 's1', amount: total, ...a })
      .paymentId;
  }
  async payEvent(
    input: Omit<PaymentWebhookInput, 'storeId'>,
    confirm?: {
      delayMs: number;
      kind: 'payment' | 'refund' | 'authorize';
      status: 'SUCCESS' | 'FAILURE' | 'PENDING';
    }
  ): Promise<{ ok: true; outcome: string } | { ok: false; code: string }> {
    try {
      const r = await applyPaymentEvent(
        doSyncSql(this.ctx.storage),
        { ...input, storeId: 's1' },
        confirm
          ? {
              confirm: async () => {
                await new Promise(r => setTimeout(r, confirm.delayMs)); // real I/O: other requests run meanwhile
                return { kind: confirm.kind, status: confirm.status };
              },
            }
          : {}
      );
      return { ok: true, outcome: r.outcome };
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, code: e.code };
      throw e;
    }
  }
  payBegin(a: {
    paymentId: string;
    amount?: number;
    refundKey?: string;
    now?: number;
  }): { ok: true; claimId: string } | { ok: false; code: string } {
    try {
      return {
        ok: true,
        claimId: beginRefund(doSyncSql(this.ctx.storage), { storeId: 's1', ...a }).claimId,
      };
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, code: e.code };
      throw e;
    }
  }
  payComplete(a: { claimId: string; refundId: string; now?: number }): {
    ok: boolean;
    code?: string;
  } {
    try {
      completeRefund(doSyncSql(this.ctx.storage), { storeId: 's1', ...a });
      return { ok: true };
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, code: e.code };
      throw e;
    }
  }
  payRelease(a: { claimId: string }): { released: boolean; review: boolean } {
    return releaseRefund(doSyncSql(this.ctx.storage), {
      storeId: 's1',
      reason: 'provider_rejected',
      ...a,
    });
  }

  async seed(): Promise<void> {
    for (const [id, slug] of [
      ['p1', 'alpha'],
      ['p2', 'beta'],
    ])
      await this.lite.product.create({ data: { id, name: slug, slug, price: 100, inventory: 5 } });
  }
  async names(): Promise<Record<string, string>> {
    return Object.fromEntries(
      (await this.lite.product.findMany({ orderBy: { id: 'asc' } })).map((p: any) => [p.id, p.name])
    );
  }
  async inventory(id: string): Promise<number> {
    return (await this.lite.product.findUnique({ where: { id } })).inventory;
  }
  /** Scenario A: an interactive transaction that updates, waits on a TIMER (real I/O: other requests may run), then throws. */
  async txThatFailsAfterTimer(): Promise<string> {
    try {
      await this.lite.$transaction(async (tx: any) => {
        await tx.product.update({ where: { id: 'p1' }, data: { name: 'IN-TX' } });
        await new Promise(r => setTimeout(r, 50));
        throw new Error('A fails');
      });
      return 'committed';
    } catch (e) {
      return (e as Error).message;
    }
  }
  /** Scenario B: an unrelated write issued by another request while A is open. */
  async unrelatedWrite(): Promise<string> {
    await this.lite.product.update({ where: { id: 'p2' }, data: { name: 'OUTSIDE' } });
    return 'ok';
  }
  async nestedAtomicity(): Promise<string> {
    try {
      await this.lite.product.create({
        data: {
          id: 'half',
          name: 'n',
          slug: 'half',
          price: 1,
          images: {
            create: [
              { id: 'd', url: 'a' },
              { id: 'd', url: 'b' },
            ],
          },
        },
      });
      return 'created';
    } catch (e) {
      return `${(e as any).code}|${JSON.stringify((e as any).meta?.target)}`;
    }
  }
  async exists(id: string): Promise<boolean> {
    return (await this.lite.product.findUnique({ where: { id } })) !== null;
  }
  async caughtInsideTx(): Promise<number> {
    await this.lite.$transaction(async (tx: any) => {
      try {
        await tx.product.create({
          data: {
            id: 'half2',
            name: 'n',
            slug: 'half2',
            price: 1,
            images: {
              create: [
                { id: 'd2', url: 'a' },
                { id: 'd2', url: 'b' },
              ],
            },
          },
        });
      } catch {
        /* swallowed */
      }
      await tx.product.create({ data: { id: 'after', name: 'n', slug: 'after', price: 1 } });
    });
    return this.ctx.storage.sql
      .exec(`SELECT count(*) AS n FROM product_images WHERE id = 'd2'`)
      .one().n as number;
  }
  async foreignStoreWrite(): Promise<string> {
    try {
      await this.lite.product.create({
        data: { id: 'x', storeId: 'OTHER', name: 'n', slug: 'x', price: 1 },
      });
      return 'allowed';
    } catch (e) {
      return (e as Error).message;
    }
  }
}

export default { fetch: () => new Response('prisma-lite do test') };
