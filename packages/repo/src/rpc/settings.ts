import { decode, encode } from '../prisma-lite/codec';
import type { Meta, ScalarField, SqlRunner } from '../prisma-lite/types';

/**
 * The StoreDO's settings copy (Ruling CF-WRITES-2). `Store` is split: D1 (or Postgres until cutover) keeps the directory row
 * and stays AUTHORITATIVE for it; the DO carries `store_profile` (branding, content, SEO, theme, mirror columns) and
 * `store_config` (commerce, flags, integrations) which the storefront reads. A settings change writes the authoritative
 * `Store` row first and then this write-through, synchronously and in the same request, so there is no cache and no
 * stale window: a failed copy fails the request and the idempotent update is simply repeated.
 *
 * `fields` are Prisma `Store` field names. A field with no column in either DO table (the D1-only directory columns:
 * domain verification, email domain, billing suspension, deletedAt) is not part of the copy and is reported back.
 * A relation write (agent credentials) is directory-only too. An unknown field name is refused. `store_profile` is UPDATE-only (its NOT NULL identity columns come from the import);
 * `store_config` is an upsert (every other column has a default).
 */
export function applyStoreSettings(
  sql: SqlRunner,
  meta: Meta,
  storeId: string,
  fields: Record<string, unknown>
): { profile: string[]; config: string[]; directoryOnly: string[] } {
  const store = meta.models.Store;
  if (!store) throw new Error('Store is not in the model metadata');
  const cols = (t: string) =>
    new Set((sql.all(`PRAGMA table_info("${t}")`, []) as Array<{ name: string }>).map(r => r.name));
  const profileCols = cols('store_profile');
  const configCols = cols('store_config');
  const out = { profile: [] as string[], config: [] as string[], directoryOnly: [] as string[] };
  const sets: Record<'store_profile' | 'store_config', Array<[string, unknown]>> = {
    store_profile: [],
    store_config: [],
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const f = Object.prototype.hasOwnProperty.call(store.fields, name)
      ? store.fields[name]
      : undefined;
    if (!f) throw new Error(`unknown Store field: ${name}`);
    if (name === 'id') continue;
    // a relation write (`credentials: { upsert }`) targets a platform model that lives in D1, never in the DO
    if (f.kind === 'relation') {
      out.directoryOnly.push(name);
      continue;
    }
    const sf = f as ScalarField;
    // the profile copy wins for a mirror column; config is the default home of every other DO-owned column
    if (profileCols.has(sf.column)) {
      sets.store_profile.push([sf.column, encode(sf, value)]);
      out.profile.push(name);
    } else if (configCols.has(sf.column)) {
      sets.store_config.push([sf.column, encode(sf, value)]);
      out.config.push(name);
    } else out.directoryOnly.push(name);
  }
  const run = () => {
    if (sets.store_profile.length) {
      const r = sql.run(
        `UPDATE "store_profile" SET ${sets.store_profile.map(([c]) => `"${c}" = ?`).join(', ')} WHERE "store_id" = ?`,
        [...sets.store_profile.map(([, v]) => v), storeId]
      );
      if (r.changes === 0)
        throw Object.assign(new Error('store_profile row is missing (import it first)'), {
          code: 'STORE_PROFILE_MISSING',
        });
    }
    if (sets.store_config.length)
      sql.run(
        `INSERT INTO "store_config" ("store_id", ${sets.store_config.map(([c]) => `"${c}"`).join(', ')}) VALUES (?, ${sets.store_config.map(() => '?').join(', ')}) ON CONFLICT ("store_id") DO UPDATE SET ${sets.store_config.map(([c]) => `"${c}" = excluded."${c}"`).join(', ')}`,
        [storeId, ...sets.store_config.map(([, v]) => v)]
      );
  };
  if (sql.transactionSync) sql.transactionSync(run);
  else run();
  return out;
}

/**
 * The StoreDO's read of the Store record (NEON-ZERO-1): `store_profile` (mirror + profile columns) joined with
 * `store_config` (config columns), as Prisma `Store` field values. ONE statement-pair, no D1 and no Postgres. `fields`
 * limits the result to those Prisma field names (default: every scalar the two tables carry). A name with no column in
 * either table (the D1-only directory columns) is returned in `missing` for the caller to read from D1; an unknown name
 * throws. Returns `null` when the store has no profile row.
 */
export function readStoreRecord(
  sql: SqlRunner,
  meta: Meta,
  storeId: string,
  fields?: string[]
): { record: Record<string, unknown>; missing: string[] } | null {
  const store = meta.models.Store;
  if (!store) throw new Error('Store is not in the model metadata');
  const profile = sql.all('SELECT * FROM "store_profile" WHERE "store_id" = ?', [storeId])[0];
  if (!profile) return null;
  // A store that never had a config write has no config row: materialise the all-defaults row (what the first config write
  // would create anyway) so every config column reads its schema default, never a missing key.
  let config = sql.all('SELECT * FROM "store_config" WHERE "store_id" = ?', [storeId])[0];
  if (!config) {
    sql.run('INSERT OR IGNORE INTO "store_config" ("store_id") VALUES (?)', [storeId]);
    config = sql.all('SELECT * FROM "store_config" WHERE "store_id" = ?', [storeId])[0] ?? {};
  }
  const names = fields ?? Object.keys(store.fields);
  const record: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const name of names) {
    const f = Object.prototype.hasOwnProperty.call(store.fields, name)
      ? store.fields[name]
      : undefined;
    if (!f) throw new Error(`unknown Store field: ${name}`);
    if (f.kind === 'relation') {
      if (fields) throw new Error(`Store.${name} is a relation: not served by the DO record`);
      continue;
    }
    const sf = f as ScalarField;
    if (name === 'id') record.id = storeId;
    else if (Object.prototype.hasOwnProperty.call(profile, sf.column))
      record[name] = decode(sf, profile[sf.column]);
    else if (Object.prototype.hasOwnProperty.call(config, sf.column))
      record[name] = decode(sf, config[sf.column]);
    else if (!fields) continue;
    else missing.push(name);
  }
  return { record, missing };
}
