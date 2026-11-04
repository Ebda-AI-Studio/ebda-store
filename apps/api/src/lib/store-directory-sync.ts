/**
 * Dual-write of the Store DIRECTORY columns to D1 (hotfix, security review 2026-11-02; plan N-22).
 *
 * Lookups (lookupStore, storeIdBySlug, storeIdByDomain, storeIdsClaimingDomain, publicStorePage) read D1 `stores` only since
 * f7737af85, but every Store write (create, status, soft delete, slug, domain claim / verify / release, plan, billing
 * suspension) still lands in Postgres. Without this module a suspended or deleted store stays resolvable (fail OPEN) and a
 * new store 404s. Postgres stays authoritative until N-18 (Store create on D1/DO); this mirrors the directory columns into D1
 * in the same path as every Postgres write:
 *   - `syncStoreDirectoryFromPg(storeId)`: a full-row upsert READ BACK FROM THE COMMITTED Postgres row. Never the caller's
 *     patch, never before commit: a transaction that rolls back leaves D1 untouched (security review of #384).
 *   - `scheduleStoreDirectorySync(storeId)`: called by `copyStoreSettings` (the one chokepoint behind storeUpdate /
 *     storeUpdateMany / updateStoreThrough). Inside a request it is DEFERRED until the tenant transaction commits and DROPPED on
 *     rollback (`deferAfterTenantCommit`); the creating paths call `syncStoreDirectoryFromPg` after their own commit.
 *   - `reconcileStoreDirectory()` (lib/store-directory-reconcile.ts, hourly cron) repairs any drift fail-closed.
 * A failed post-commit sync is an error log plus an alert (deferred work is loud) and is repaired by the next reconcile.
 * D1 `storage_backend` is never written here (D1 owns it).
 * No-op when PLATFORM_DB is unbound (Node, unit tests, local dev).
 */
import { withStore } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { STORE_D1_ONLY_FIELDS, STORE_MIRROR_FIELDS, d1StorePatch } from './store-columns';

interface D1Stmt {
  bind(...v: unknown[]): {
    run(): Promise<{ meta?: { changes?: number } }>;
    first<T>(): Promise<T | null>;
  };
}
interface D1Like {
  prepare(sql: string): D1Stmt;
}
const d1 = (): D1 | undefined =>
  (cfBindings() as { PLATFORM_DB?: D1Like } | undefined)?.PLATFORM_DB;
type D1 = D1Like;

const ALL_FIELDS = [...STORE_MIRROR_FIELDS, ...STORE_D1_ONLY_FIELDS] as const;

/** Prisma field name -> D1 column, from the generated model metadata (one source). */
async function columnOf(): Promise<Record<string, string>> {
  const meta = (await import('@ebda-src/prisma-meta')).default as unknown as {
    models: { Store: { fields: Record<string, { column?: string; kind: string }> } };
  };
  const out: Record<string, string> = {};
  for (const n of ALL_FIELDS) {
    const c = meta.models.Store.fields[n]?.column;
    if (!c) throw new Error(`store-directory-sync: Store.${n} has no column in the model metadata`);
    out[n] = c;
  }
  return out;
}

function encode(name: string, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number') return v;
  // a Prisma update operator or any structured value on a directory column: never guess
  throw new AppError(
    500,
    'STORE_DIRECTORY_SYNC_UNSUPPORTED',
    `Store.${name}: not a plain value; cannot mirror to D1`
  );
}

const unavailable = (e: unknown) => {
  if (e instanceof AppError) return e;
  return new AppError(503, 'STORE_DIRECTORY_UNAVAILABLE', 'Store directory write failed');
};

/**
 * Mirror this store's directory row to D1 once the surrounding tenant transaction has committed (dropped if it rolls back).
 * Only a patch that touches a D1-owned column triggers it. Outside a request scope it runs inline (callers that wrap
 * `storeUpdate` in their own still-open transaction are repaired by the reconciler).
 */
export async function scheduleStoreDirectorySync(
  storeId: string,
  patch: Record<string, unknown>
): Promise<void> {
  if (!d1()) return;
  if (Object.keys(d1StorePatch(patch)).length === 0) return;
  // Lazy: after-tenant-commit pulls the logger / config / alerts graph, which repo-factory's other importers must not load eagerly.
  const { deferAfterTenantCommit } = await import('./after-tenant-commit.js');
  await deferAfterTenantCommit('store.directory.sync', () => syncStoreDirectoryFromPg(storeId));
}

/** Full-row upsert of the directory columns from Postgres (the authoritative row), after the creating transaction committed. */
export async function syncStoreDirectoryFromPg(storeId: string): Promise<void> {
  const db = d1();
  if (!db) return;
  try {
    // D1 + the DO own a `do` store (plan N-22): never overwrite it from the stale Postgres row.
    const current = await db
      .prepare('SELECT "storage_backend" AS b FROM "stores" WHERE "id" = ?')
      .bind(storeId)
      .first<{ b: string }>();
    if (current?.b === 'do') return;
    const select = Object.fromEntries(ALL_FIELDS.map(n => [n, true]));
    const row = (await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select })
    )) as Record<string, unknown> | null;
    if (!row) {
      // gone from Postgres: it must not stay resolvable
      await db.prepare('DELETE FROM "stores" WHERE "id" = ?').bind(storeId).run();
      return;
    }
    const cols = await columnOf();
    const names = ALL_FIELDS.filter(n => n !== 'id');
    const colList = ['id', ...names.map(n => cols[n])].map(c => `"${c}"`).join(', ');
    const marks = ['id', ...names].map(() => '?').join(', ');
    const update = names.map(n => `"${cols[n]}" = excluded."${cols[n]}"`).join(', ');
    await db
      .prepare(
        `INSERT INTO "stores" (${colList}) VALUES (${marks}) ON CONFLICT ("id") DO UPDATE SET ${update}`
      )
      .bind(storeId, ...names.map(n => encode(n, row[n])))
      .run();
  } catch (e) {
    throw unavailable(e);
  }
}

/**
 * Take a deleted store out of the D1 directory (Ruling NZ-D14 / NZ-D15). Lookups read D1, so a deleted store whose row survives
 * stays resolvable.
 *   - `soft: true` (a DO store): the row is MARKED deleted (status inactive + deleted_at), never removed. Its data is retained and
 *     its slug stays reserved; lookups exclude it at once.
 *   - `soft: false` (a Postgres store, already hard-deleted there): the row is removed; D1 FKs cascade the platform rows.
 * No-op when unbound.
 */
export async function retireStoreDirectoryRow(
  storeId: string,
  opts: { soft: boolean }
): Promise<void> {
  const db = d1();
  if (!db) return;
  try {
    if (opts.soft)
      await db
        .prepare(
          'UPDATE "stores" SET "status" = \'inactive\', "deleted_at" = COALESCE("deleted_at", ?) WHERE "id" = ?'
        )
        .bind(Date.now(), storeId)
        .run();
    else await db.prepare('DELETE FROM "stores" WHERE "id" = ?').bind(storeId).run();
  } catch (e) {
    throw unavailable(e);
  }
}
