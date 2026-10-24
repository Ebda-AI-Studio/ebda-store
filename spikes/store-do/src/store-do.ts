import { DurableObject } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { makeDrizzle, listProducts, addCartItem, createOrder, StoreError, type Db } from './repo';
import * as schema from './schema';
import core from '../migrations/0001_core.sql';
import { statements } from './sql';

export interface Env {
  STORE_DO: DurableObjectNamespace<StoreDO>;
  /** Comma list of store ids served by the DO backend. Default empty = nobody (flag OFF). */
  STORE_DO_ENABLED_IDS: string;
  SPIKE_BACKUPS?: R2Bucket;
  /** Secret (wrangler secret put SEED_TOKEN): authorises the operator-only __seed route. */
  SEED_TOKEN?: string;
}

/** Versioned migrations, applied in order inside ONE transactionSync; `_migrations` records them. */
export const MIGRATIONS: { id: string; sql: string }[] = [{ id: '0001_core', sql: core }];

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; status: number };

function run<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, code: e.code, status: e.status };
    throw e;
  }
}

/** One instance per store (idFromName(storeId)). Requests to one store are serialised by the runtime. */
export class StoreDO extends DurableObject<Env> {
  readonly db: Db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = makeDrizzle(ctx.storage); // built once per DO lifetime: no per-request client
    ctx.blockConcurrencyWhile(async () => this.migrate());
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

  // ---- seed (spike only: idempotent upsert, used by the demo-store loader) ----
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

  // ---- catalog ----
  listProducts(storeId: string, limit: number) {
    return run(() => listProducts(this.db, storeId, limit));
  }

  // ---- cart ----
  addCartItem(
    storeId: string,
    sessionId: string,
    productId: string,
    qty: number,
    variantId?: string
  ) {
    return run(() => addCartItem(this.db, storeId, sessionId, productId, qty, variantId));
  }

  // ---- orders: ONE synchronous transaction, no await between the stock read and the write ----
  createOrder(storeId: string, sessionId: string) {
    return run(() => createOrder(this.db, storeId, sessionId));
  }

  // ---- introspection (tests, /health, backup manifest) ----
  rowCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of [
      'stores',
      'products',
      'product_variants',
      'carts',
      'cart_items',
      'orders',
      'order_items',
    ])
      out[t] = (this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n as number) ?? 0;
    return out;
  }

  stock(productId: string): number {
    return this.db
      .select({ n: schema.products.inventory })
      .from(schema.products)
      .where(sql`${schema.products.id} = ${productId}`)
      .get()!.n;
  }
}
