/**
 * Dual-write of the Store DIRECTORY columns to D1 (hotfix, security review 2026-11-02; plan N-22).
 *
 * Lookups (lookupStore, storeIdBySlug, storeIdByDomain, storeIdsClaimingDomain, publicStorePage) read D1 `stores` only since
 * f7737af85, but every Store write (create, status, soft delete, slug, domain claim / verify / release, plan, billing
 * suspension) still lands in Postgres. Without this module a suspended or deleted store stays resolvable (fail OPEN) and a
 * new store 404s. Postgres stays authoritative until N-18 (Store create on D1/DO); this mirrors the directory columns into D1
 * in the same path as every Postgres write:
 *   - `mirrorStoreDirectory(storeId, patch)`: the patch of an update (called by `copyStoreSettings`, the one chokepoint behind
 *     storeUpdate / storeUpdateMany / updateStoreThrough). One UPDATE; a store with no D1 row is a loud 503.
 *   - `syncStoreDirectoryFromPg(storeId)`: a full-row upsert read from Postgres AFTER the creating transaction committed.
 * Both throw on a D1 failure: the Postgres write already committed, the request fails, the idempotent retry converges
 * (failing closed beats leaving a suspension un-mirrored). D1 `storage_backend` is never written here (D1 owns it).
 * No-op when PLATFORM_DB is unbound (Node, unit tests, local dev).
 */
import { withStore } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { STORE_D1_ONLY_FIELDS, STORE_MIRROR_FIELDS, d1StorePatch } from './store-columns';

interface D1Stmt {
  bind(...v: unknown[]): { run(): Promise<{ meta?: { changes?: number } }> };
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

/** Mirror an update patch to D1. Only D1-owned fields are written; nothing to do when the patch has none. */
export async function mirrorStoreDirectory(
  storeId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const db = d1();
  if (!db) return;
  const d1Patch = d1StorePatch(patch);
  const names = Object.keys(d1Patch);
  if (names.length === 0) return;
  try {
    const cols = await columnOf();
    const set = names.map(n => `"${cols[n]}" = ?`).join(', ');
    const res = await db
      .prepare(`UPDATE "stores" SET ${set} WHERE "id" = ?`)
      .bind(...names.map(n => encode(n, d1Patch[n])), storeId)
      .run();
    if ((res.meta?.changes ?? 0) === 0)
      throw new AppError(503, 'STORE_DIRECTORY_MISSING', 'Store has no directory row');
  } catch (e) {
    throw unavailable(e);
  }
}

/** Full-row upsert of the directory columns from Postgres (the authoritative row), after the creating transaction committed. */
export async function syncStoreDirectoryFromPg(storeId: string): Promise<void> {
  const db = d1();
  if (!db) return;
  try {
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
