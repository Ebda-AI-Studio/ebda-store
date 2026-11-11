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
  fields: Record<string, unknown>,
  /** `true` when the caller already holds the DO's synchronous transaction (`patchStoreSettings`): do not open another. */
  opts: { inTransaction?: boolean } = {}
): { profile: string[]; config: string[]; directoryOnly: string[] } {
  const store = meta.models.Store;
  if (!store) throw new Error('Store is not in the model metadata');
  const cols = (t: string) =>
    new Set((sql.all(`PRAGMA table_info("${t}")`, []) as Array<{ name: string }>).map(r => r.name));
  const profileCols = cols('store_profile');
  const configCols = cols('store_config');
  const out = { profile: [] as string[], config: [] as string[], directoryOnly: [] as string[] };
  // Ordering (N-19): a copy that carries `updatedAt` (the whole RETURNING value of a raw settings write) is applied only if it is
  // not OLDER than what the DO already holds, so two copies landing out of order cannot leave the DO on the older value.
  const stamp = fields.updatedAt;
  if (stamp instanceof Date && profileCols.has('updated_at')) {
    const cur = sql.all('SELECT "updated_at" AS t FROM "store_profile" WHERE "store_id" = ?', [
      storeId,
    ])[0];
    if (cur && typeof cur.t === 'number' && cur.t > stamp.getTime()) return out;
  }
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
  if (sql.transactionSync && !opts.inTransaction) sql.transactionSync(run);
  else run();
  return out;
}

/** The JSON columns `patchStoreSettings` merges key by key (Prisma `Store` field names). */
export const PATCHABLE_JSON_FIELDS = ['settings', 'theme', 'socialLinks'] as const;
export type JsonKeyPatch = { set?: Record<string, unknown>; remove?: string[] };

/**
 * BE:F-2 / BE:F-3: the DO's atomic settings PATCH. The service used to read `settings` (or `theme`,
 * `socialLinks`), merge in its own memory and write the whole value back, so two quick saves of different keys could overwrite each
 * other. Here the merge runs INSIDE the DO's synchronous transaction against the value the DO holds right now: only the top-level
 * keys in `set` are written (`remove` deletes keys), every other key is untouched, and `fields` (plain column values: branding,
 * contact, ...) are written in the SAME transaction, so a refusal anywhere (an unknown field, a missing profile row) rolls back
 * the whole patch. Reserved/server-owned key stripping is the caller's job (it differs by writer).
 */
export function patchStoreSettings(
  sql: SqlRunner,
  meta: Meta,
  storeId: string,
  input: { fields?: Record<string, unknown>; json?: Record<string, JsonKeyPatch> }
): { profile: string[]; config: string[]; directoryOnly: string[] } {
  const jsonNames = Object.keys(input.json ?? {});
  for (const n of jsonNames)
    if (!(PATCHABLE_JSON_FIELDS as readonly string[]).includes(n))
      throw Object.assign(new Error(`Store.${n} is not a patchable JSON field`), {
        code: 'PATCH_FIELD_REFUSED',
      });
  const run = () => {
    const fields: Record<string, unknown> = { ...(input.fields ?? {}) };
    if (jsonNames.length) {
      const rec = readStoreRecord(sql, meta, storeId, jsonNames);
      if (!rec)
        throw Object.assign(new Error('store_profile row is missing (import it first)'), {
          code: 'STORE_PROFILE_MISSING',
        });
      for (const n of jsonNames) {
        const patch = (input.json as Record<string, JsonKeyPatch>)[n];
        const cur = rec.record[n];
        const next: Record<string, unknown> = {
          ...(cur && typeof cur === 'object' && !Array.isArray(cur)
            ? (cur as Record<string, unknown>)
            : {}),
          ...(patch.set ?? {}),
        };
        for (const k of patch.remove ?? []) delete next[k];
        fields[n] = next;
      }
    }
    return applyStoreSettings(sql, meta, storeId, fields, { inTransaction: true });
  };
  return sql.transactionSync ? sql.transactionSync(run) : run();
}

const blankVal = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);
const sameStored = (a: unknown, b: unknown): boolean =>
  (blankVal(a) && blankVal(b)) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Compare-and-set of Store fields (issue #620, Ruling NEVER-OVERWRITE-1): inside ONE synchronous DO transaction, read the
 * record as it is NOW and write each `set` field only if it still equals `expect[field]` (null, '', whitespace and `{}` all
 * count as blank, the same equivalence as the API's `isBlankVal`). A field whose current value differs (the merchant edited it
 * since the job read) is reported in `stale` and left alone; a D1-only field is not served here and is reported in `directoryOnly`.
 */
export function casStoreFields(
  sql: SqlRunner,
  meta: Meta,
  storeId: string,
  input: { expect: Record<string, unknown>; set: Record<string, unknown> }
): { written: string[]; stale: string[]; directoryOnly: string[] } {
  const names = Object.keys(input.set);
  const run = () => {
    const rec = readStoreRecord(sql, meta, storeId, names);
    if (!rec)
      throw Object.assign(new Error('store_profile row is missing (import it first)'), {
        code: 'STORE_PROFILE_MISSING',
      });
    const write: Record<string, unknown> = {};
    const stale: string[] = [];
    for (const n of names) {
      if (rec.missing.includes(n)) continue;
      if (sameStored(rec.record[n], input.expect[n])) write[n] = input.set[n];
      else stale.push(n);
    }
    if (Object.keys(write).length)
      applyStoreSettings(sql, meta, storeId, write, { inTransaction: true });
    return { written: Object.keys(write), stale, directoryOnly: rec.missing };
  };
  return sql.transactionSync ? sql.transactionSync(run) : run();
}

/**
 * First-time bootstrap of a store created on its Durable Object (NEON-ZERO-1 N-18, Ruling NZ-D11): the `store_profile` row (its NOT
 * NULL identity columns), then every other field through `applyStoreSettings` (`store_config` is an upsert), then the default VAT
 * rate. IDEMPOTENT end to end (INSERT OR IGNORE; a second call re-applies the same fields and adds no second rate), so a retry
 * after a partial failure converges. `vat.rate` is the stored shape of `tax_rates.rate` (hundredths of a percent: 14% is 1400).
 */
export function bootstrapStoreRows(
  sql: SqlRunner,
  meta: Meta,
  storeId: string,
  input: {
    identity: { name: string; slug: string; ownerId: string };
    fields: Record<string, unknown>;
    vat?: { id: string; name: string; nameAr: string; rate: number };
    /** Cash on delivery, enabled (provisioning's default payment method). */
    cod?: { id: string; name: string; nameAr: string; currency: string };
  }
): { profile: string[]; config: string[]; directoryOnly: string[] } {
  const { identity } = input;
  sql.run(
    'INSERT OR IGNORE INTO "store_profile" ("store_id", "name", "slug", "owner_id") VALUES (?, ?, ?, ?)',
    [storeId, identity.name, identity.slug, identity.ownerId]
  );
  const out = applyStoreSettings(sql, meta, storeId, input.fields);
  if (input.vat) {
    sql.run(
      `INSERT INTO "tax_rates" ("id", "store_id", "name", "name_ar", "rate", "is_active")
       SELECT ?, ?, ?, ?, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM "tax_rates" WHERE "store_id" = ? AND "name" = ?)`,
      [
        input.vat.id,
        storeId,
        input.vat.name,
        input.vat.nameAr,
        input.vat.rate,
        storeId,
        input.vat.name,
      ]
    );
  }
  if (input.cod) {
    sql.run(
      `INSERT INTO "payment_configs" ("id", "store_id", "provider", "is_enabled", "display_name", "display_name_ar", "test_mode", "supported_methods", "supported_currencies", "fixed_fee", "percentage_fee")
       SELECT ?, ?, 'cod', 1, ?, ?, 0, '["cod"]', ?, 0, 0
       WHERE NOT EXISTS (SELECT 1 FROM "payment_configs" WHERE "store_id" = ? AND "provider" = 'cod')`,
      [
        input.cod.id,
        storeId,
        input.cod.name,
        input.cod.nameAr,
        JSON.stringify([input.cod.currency]),
        storeId,
      ]
    );
  }
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
