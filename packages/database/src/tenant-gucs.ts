/**
 * The Postgres settings (GUCs) that RLS policies read, and the statement that
 * sets them for one transaction.
 *
 * Shared by `runInTenantContext`, the proxy's `$transaction` inheritance and
 * `withMoneyTx` so all three set the SAME settings the SAME way.
 *
 * TRANSACTION-LOCAL ONLY (R-EBDA-001, docs/ebda/design/cloudflare-backend.md §3).
 * Every setting goes through `set_config(name, value, true)`: `true` is
 * `is_local`, so the value reverts at COMMIT/ROLLBACK and a transaction-mode
 * pooler (Hyperdrive, pgbouncer, Neon) that hands this server connection to the
 * next tenant can never leak it. The spike's negative control — a session-level
 * `set_config(..., false)` — leaked into a later, different client 13-20 times
 * out of 20. A session-level SET is banned repo-wide by
 * `tests/unit/no-session-level-gucs.test.ts`.
 */

export interface TenantGucs {
  storeId?: string;
  userId?: string;
}

export const GUC_STORE = 'app.current_store_id';
export const GUC_USER = 'app.current_user_id';

/**
 * Every tenant transaction also pins the SESSION TIME ZONE to UTC (transaction-local, the same statement,
 * no extra round trip). The schema stores instants in `timestamp(3)` WITHOUT time zone: Prisma writes UTC
 * wall time, but a SQL `now()` / `CURRENT_TIMESTAMP` default or `now() - interval` comparison yields the
 * wall time of the session's zone. Production happens to run UTC; a server or pooler on any other zone
 * (a developer's Postgres on a non-UTC zone did) silently shifted every DB-side default by hours, so rows
 * written by `now()` looked hours old or hours in the future next to rows Prisma wrote (Ruling ITEST-12).
 */
export const TENANT_TIME_ZONE = 'UTC';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The statements that set the given settings, in a fixed order — at most ONE:
 * both GUCs go in a single `SELECT set_config(...), set_config(...)`, because on
 * a Worker every round trip to the database is a network hop. Values are bound
 * parameters, never interpolated, so there is no quoting to get wrong.
 */
export function gucStatements(gucs: TenantGucs): Array<{ sql: string; params: string[] }> {
  const calls: string[] = [];
  const params: string[] = [];
  if (gucs.storeId) {
    params.push(gucs.storeId);
    calls.push(`set_config('${GUC_STORE}', $${params.length}, true)`);
  }
  if (gucs.userId) {
    params.push(gucs.userId);
    calls.push(`set_config('${GUC_USER}', $${params.length}, true)`);
  }
  if (calls.length) calls.push(`set_config('TimeZone', '${TENANT_TIME_ZONE}', true)`);
  return calls.length ? [{ sql: `SELECT ${calls.join(', ')}`, params }] : [];
}

type RawQuerier = {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => unknown;
};

/** Run the `set_config`s on an open interactive transaction. */
export async function applyGucs(tx: RawQuerier, gucs: TenantGucs): Promise<void> {
  for (const { sql, params } of gucStatements(gucs)) await tx.$queryRawUnsafe(sql, ...params);
}

/**
 * Set the RLS settings on a transaction the caller opened itself
 * (`withMoneyTx`, `prisma.$transaction`) when there is no ambient context for
 * it to inherit — e.g. the public checkout. Validates like
 * `runInTenantContext`.
 */
export async function setTenantGucs(tx: RawQuerier, gucs: TenantGucs): Promise<void> {
  if (gucs.storeId !== undefined && !UUID_RE.test(gucs.storeId)) {
    throw new Error('Invalid store ID format');
  }
  if (gucs.userId !== undefined && !UUID_RE.test(gucs.userId)) {
    throw new Error('Invalid user ID format');
  }
  await applyGucs(tx, gucs);
}
