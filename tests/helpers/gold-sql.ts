/**
 * Raw-SQL fixtures for the gold-rate pricing integration tests (Phase B5). The superuser URL builds
 * fixtures; every ASSERTION about isolation or the price guard runs on a real `ebda_app` login with
 * the tenant GUC set transaction-locally, exactly as the API sets it. Every id is per-call unique
 * (retry-safe: a retry re-runs the body against the same database).
 */
import crypto from 'node:crypto';
import pg from 'pg';

export const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';

export function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}

export const ownerPool = () => new pg.Pool({ connectionString: OWNER_URL, max: 2 });
/** max: 1 so two transactions in a row reuse ONE connection (the GUC-leak proof depends on it). */
export const appPool = () => new pg.Pool({ connectionString: appUrl(), max: 1 });

export const uid = () => crypto.randomUUID();
export const tag = () => crypto.randomUUID().slice(0, 8);

export type Q = { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> };

/** One ebda_app transaction scoped to a store (and optionally a user), the way the API scopes it. */
export async function inStoreTx<T>(
  pool: pg.Pool,
  storeId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
  opts: { goldReprice?: boolean; commit?: boolean } = {}
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (storeId) await c.query(`select set_config('app.current_store_id', $1, true)`, [storeId]);
    if (opts.goldReprice) await c.query(`select set_config('app.gold_reprice', 'on', true)`);
    const out = await fn(c);
    await c.query(opts.commit === false ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function createStore(owner: Q, t: string) {
  const userId = uid();
  const storeId = uid();
  await owner.query(
    `insert into users (id, email, password_hash, first_name, last_name, role, email_verified, updated_at)
     values ($1, $2, 'x', 'Gold', $3, 'store_admin', true, now())`,
    [userId, `gold-${t}-${userId.slice(0, 6)}@test.local`, t]
  );
  await owner.query(
    `insert into stores (id, name, slug, owner_id, currency, status, updated_at)
     values ($1, $2, $3, $4, 'EGP', 'active', now())`,
    [storeId, `gold-${t}`, `gold-${t}-${storeId.slice(0, 6)}`, userId]
  );
  return { userId, storeId };
}

/** Inserts a product as the superuser; a gold row needs the reprice GUC, so it is set for the insert. */
export async function createProduct(
  owner: pg.Pool,
  storeId: string,
  o: {
    price?: number;
    mode?: 'fixed' | 'gold_rate';
    karat?: number;
    weightMg?: number;
    makingType?: 'fixed' | 'per_gram';
    makingValue?: number;
    marginBps?: number;
    slug?: string;
  } = {}
): Promise<string> {
  const id = uid();
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query(`select set_config('app.gold_reprice', 'on', true)`);
    await c.query(
      `insert into products (id, store_id, name, slug, price, status, inventory, updated_at,
                             pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps)
       values ($1, $2, 'Piece', $3, $4, 'active', 5, now(), $5, $6, $7, $8, $9, $10)`,
      [
        id,
        storeId,
        o.slug ?? `p-${id.slice(0, 8)}`,
        o.price ?? 1000,
        o.mode ?? 'fixed',
        o.karat ?? null,
        o.weightMg ?? null,
        o.makingType ?? null,
        o.makingValue ?? null,
        o.marginBps ?? 0,
      ]
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return id;
}

export async function deleteStores(owner: Q, storeIds: string[], userIds: string[]) {
  if (storeIds.length)
    await owner.query(`delete from stores where id = any($1::text[])`, [storeIds]);
  if (userIds.length) await owner.query(`delete from users where id = any($1::text[])`, [userIds]);
}

export const sqlState = (e: unknown): string | undefined => (e as { code?: string }).code;
export const sqlMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
