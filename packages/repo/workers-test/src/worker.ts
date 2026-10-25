import { DurableObject } from 'cloudflare:workers';
import store0001 from '../../../cf-schema/migrations/store/0001_init.sql';
import store0002 from '../../../cf-schema/migrations/store/0002_invariants.sql';
import meta from '../../../cf-schema/generated/prisma-meta.json';
import { createPrismaLite } from '../../src/prisma-lite/client';
import { doSqlRunner, doSyncSql } from '../../src/prisma-lite/do-runner';
import { placeOrder, type CheckoutInput } from '../../src/do/checkout';
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
  checkout(input: CheckoutInput): { ok: true; orderId: string } | { ok: false; code: string } {
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
        `SELECT coalesce(sum(quantity), 0) AS n FROM inventory_history WHERE type = 'sale'`
      ),
      couponUsed: one(`SELECT usage_count AS n FROM coupons WHERE id = 'c'`),
      couponOrders: one(`SELECT count(*) AS n FROM orders WHERE coupon_code = 'SALE'`),
      wallet: one(`SELECT balance AS n FROM customer_wallets WHERE id = 'w'`),
      walletSpent: one(`SELECT coalesce(-sum(amount), 0) AS n FROM wallet_transactions`),
      orderNumbers: one('SELECT count(DISTINCT order_number) AS n FROM orders'),
    };
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
