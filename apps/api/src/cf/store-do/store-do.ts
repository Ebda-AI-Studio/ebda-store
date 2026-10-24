/**
 * StoreDO: ONE SQLite Durable Object per store (Ruling INFRA-CF-1, Phase 0 spike).
 *
 * Reachable ONLY for a store listed in STORE_DO_ENABLED_IDS (default empty = nobody) AND a request
 * carrying `x-ebda-backend: do` (lib/store-backend.ts). Production storefront traffic never touches it.
 * Data layer: Drizzle on DO SQLite (Ruling INFRA-CF-2). Every money/stock section is one synchronous
 * `transactionSync`: no `await` between the stock read and the write.
 */
import { DurableObject } from 'cloudflare:workers';
import * as schema from './schema';
import { makeDrizzle, listProducts, addCartItem, createOrder, StoreError, type Db } from './repo';
import { CORE_0001 } from './migrations';
import { statements } from './sql';

export const MIGRATIONS: { id: string; sql: string }[] = [{ id: '0001_core', sql: CORE_0001 }];

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; status: number };

function run<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, code: e.code, status: e.status };
    throw e;
  }
}

export const STORE_TABLES = [
  'stores',
  'products',
  'product_variants',
  'carts',
  'cart_items',
  'orders',
  'order_items',
] as const;

export class StoreDO extends DurableObject<Record<string, unknown>> {
  readonly db: Db;

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: Record<string, unknown>) {
    super(ctx, env);
    this.db = makeDrizzle(ctx.storage); // once per DO lifetime: no per-request client
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    const sqlx = this.ctx.storage.sql;
    sqlx.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
    );
    const done = new Set(
      sqlx
        .exec('SELECT id FROM _migrations')
        .toArray()
        .map(r => r.id as string)
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.ctx.storage.transactionSync(() => {
        for (const stmt of statements(m.sql)) sqlx.exec(stmt);
        sqlx.exec('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', m.id, Date.now());
      });
    }
  }

  seed(rows: {
    store: typeof schema.stores.$inferInsert;
    products: (typeof schema.products.$inferInsert)[];
    variants?: (typeof schema.productVariants.$inferInsert)[];
  }): Result<{ products: number; variants: number }> {
    return run(() =>
      this.ctx.storage.transactionSync(() => {
        this.db.insert(schema.stores).values(rows.store).onConflictDoNothing().run();
        for (const p of rows.products)
          this.db
            .insert(schema.products)
            .values(p)
            .onConflictDoUpdate({ target: schema.products.id, set: { ...p, id: undefined } })
            .run();
        for (const v of rows.variants ?? [])
          this.db
            .insert(schema.productVariants)
            .values(v)
            .onConflictDoUpdate({ target: schema.productVariants.id, set: { ...v, id: undefined } })
            .run();
        return { products: rows.products.length, variants: rows.variants?.length ?? 0 };
      })
    );
  }

  listProducts(storeId: string, limit: number) {
    return run(() => listProducts(this.db, storeId, limit));
  }

  addCartItem(
    storeId: string,
    sessionId: string,
    productId: string,
    qty: number,
    variantId?: string
  ) {
    return run(() => addCartItem(this.db, storeId, sessionId, productId, qty, variantId));
  }

  createOrder(storeId: string, sessionId: string) {
    return run(() => createOrder(this.db, storeId, sessionId));
  }

  rowCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of STORE_TABLES)
      out[t] = this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n as number;
    return out;
  }
}
