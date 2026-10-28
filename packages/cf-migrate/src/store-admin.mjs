// The cutover admin surface of ONE StoreDO: POST /__import, POST /__verify, POST /__seal, GET /__status.
// Mounted by the real StoreDO (and by harness/worker.mjs for the rehearsal); the caller authenticates the
// request with authorizeCutover() BEFORE it reaches the DO, so this module trusts its input's origin but
// not its shape: table and column names are validated against the DO's own schema (PRAGMA table_info),
// never interpolated unchecked.
//
// __import  NDJSON: line 1 = {batch, table, page, columns, pk}, then one JSON array per row (aligned
//           with columns). Idempotent upsert on the primary key, one transaction per page, recorded in
//           cf_import_ledger (batch, table, page). Replaying a page with the same body is a no-op; the same
//           (batch, table, page) with a different body is a 409. After __seal every import is a 423, so a
//           re-run can never overwrite writes the DO accepted after the flag flip.
// __verify  {tables:[{table, columns, pk}], fk?:true} -> per table {count, digest} (canon.mjs) and, with
//           fk, the PRAGMA foreign_key_check violations.
// __seal    marks the store as live on the DO and records a per-row baseline of every table.
// __diff    rows added / changed / deleted since the seal (the data a rollback would otherwise lose).
// __rebase  baseline := current state, after a verified rollback replay.
// __unseal  {confirm:'wipe-and-unseal'}: wipes the DO so a retried cutover can re-import.
import { PK_SEP, TableDigest, canonRow, canonValue, sha256Hex } from './canon.mjs';

export const MAX_PAGE_ROWS = 2000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Triggers that guard these tables (Ruling B5-13) only let the repricer write a gold-rate price. The import
// restores rows verbatim from the former source of truth, so inside its own transaction it raises the same
// do_flags.gold_reprice flag the repricer raises, and clears it before the transaction ends.
const GOLD_GUARDED = new Set(['products', 'product_variants']);
const IDENT = /^[a-z][a-z0-9_]*$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Constant-time bearer check. `secret` must be a non-empty string or every request is refused. */
export function authorizeCutover(request, secret) {
  if (typeof secret !== 'string' || secret.length < 24) return false;
  const h = request.headers.get('authorization') ?? '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

function ensureLedger(sql) {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS cf_import_ledger (
       batch TEXT NOT NULL, tbl TEXT NOT NULL, page INTEGER NOT NULL, rows INTEGER NOT NULL,
       body_sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL,
       PRIMARY KEY (batch, tbl, page))`
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS cf_import_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
}

const isSealed = sql =>
  sql.exec(`SELECT v FROM cf_import_state WHERE k = 'sealed'`).toArray().length > 0;

/** column/pk metadata of a real table, or an HttpError */
function tableInfo(sql, table) {
  if (!IDENT.test(table) || table.startsWith('cf_') || table.startsWith('sqlite_'))
    throw new HttpError(400, `table name not allowed: ${table}`);
  const rows = sql.exec(`SELECT name, pk FROM pragma_table_info(?)`, table).toArray();
  if (rows.length === 0) throw new HttpError(400, `unknown table: ${table}`);
  return {
    columns: new Set(rows.map(r => r.name)),
    pk: rows
      .filter(r => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(r => r.name),
  };
}

function checkShape(sql, table, columns, pk) {
  const info = tableInfo(sql, table);
  if (!Array.isArray(columns) || columns.length === 0) throw new HttpError(400, 'columns required');
  for (const c of columns)
    if (typeof c !== 'string' || !IDENT.test(c) || !info.columns.has(c))
      throw new HttpError(400, `unknown column ${table}.${c}`);
  if (new Set(columns).size !== columns.length) throw new HttpError(400, 'duplicate column');
  const want = [...info.pk].sort().join(',');
  const got = Array.isArray(pk) ? [...pk].sort().join(',') : '';
  if (want !== got)
    throw new HttpError(400, `pk mismatch for ${table}: DO has [${want}], request [${got}]`);
  for (const c of info.pk)
    if (!columns.includes(c))
      throw new HttpError(400, `pk column ${table}.${c} missing from columns`);
  return info;
}

const q = id => `"${id}"`;

async function doImport(request, { sql, transactionSync }) {
  const lenHeader = Number(request.headers.get('content-length') ?? 0);
  if (lenHeader > MAX_BODY_BYTES) throw new HttpError(413, 'page too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'page too large');
  const lines = text.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) throw new HttpError(400, 'empty body');
  let head;
  try {
    head = JSON.parse(lines[0]);
  } catch {
    throw new HttpError(400, 'header line is not JSON');
  }
  const { batch, table, page, columns, pk } = head;
  if (typeof batch !== 'string' || !/^[A-Za-z0-9._:-]{4,80}$/.test(batch))
    throw new HttpError(400, 'import_batch id required (4-80 chars of [A-Za-z0-9._:-])');
  if (!Number.isInteger(page) || page < 0) throw new HttpError(400, 'page must be an integer >= 0');
  const rowLines = lines.slice(1);
  if (rowLines.length > MAX_PAGE_ROWS) throw new HttpError(413, `more than ${MAX_PAGE_ROWS} rows`);

  ensureLedger(sql);
  if (isSealed(sql))
    throw new HttpError(423, 'store is sealed: the DO is live, imports are closed');
  const info = checkShape(sql, table, columns, pk);

  const rows = rowLines.map((l, i) => {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      throw new HttpError(400, `row ${i} is not JSON`);
    }
    if (!Array.isArray(r) || r.length !== columns.length)
      throw new HttpError(400, `row ${i}: expected ${columns.length} values`);
    for (const v of r)
      if (!(v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))))
        throw new HttpError(
          400,
          `row ${i}: only null, string and finite number values are allowed`
        );
    return r;
  });

  const bodySha = await sha256Hex(text);
  const prior = sql
    .exec(
      `SELECT body_sha256 FROM cf_import_ledger WHERE batch = ? AND tbl = ? AND page = ?`,
      batch,
      table,
      page
    )
    .toArray();
  if (prior.length) {
    if (prior[0].body_sha256 === bodySha)
      return json({ ok: true, table, page, rows: rows.length, skipped: true });
    throw new HttpError(
      409,
      `page ${table}#${page} of batch ${batch} was already applied with different content`
    );
  }

  const nonPk = columns.filter(c => !info.pk.includes(c));
  const stmt =
    `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ` +
    (nonPk.length
      ? `ON CONFLICT (${info.pk.map(q).join(', ')}) DO UPDATE SET ${nonPk.map(c => `${q(c)} = excluded.${q(c)}`).join(', ')}`
      : `ON CONFLICT (${info.pk.map(q).join(', ')}) DO NOTHING`);

  // Foreign keys are checked once at the end (__verify fk:true): categories/parent_id and friends are
  // cyclic, and a page boundary would otherwise reject a child that precedes its parent.
  sql.exec('PRAGMA foreign_keys = OFF');
  try {
    const gold =
      GOLD_GUARDED.has(table) &&
      sql.exec(`SELECT 1 FROM pragma_table_info('do_flags')`).toArray().length > 0;
    transactionSync(() => {
      if (gold)
        sql.exec(
          `INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1) ON CONFLICT (name) DO UPDATE SET value = 1`
        );
      for (const r of rows) sql.exec(stmt, ...r);
      if (gold) sql.exec(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`);
      sql.exec(
        `INSERT INTO cf_import_ledger (batch, tbl, page, rows, body_sha256, applied_at) VALUES (?, ?, ?, ?, ?, ?)`,
        batch,
        table,
        page,
        rows.length,
        bodySha,
        Date.now()
      );
    });
  } finally {
    sql.exec('PRAGMA foreign_keys = ON');
  }
  return json({ ok: true, table, page, rows: rows.length, skipped: false });
}

async function doVerify(request, { sql }) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.tables)) throw new HttpError(400, 'tables[] required');
  const tables = {};
  for (const t of body.tables) {
    checkShape(sql, t.table, t.columns, t.pk);
    const digest = new TableDigest();
    const order = t.pk.map(q).join(', ');
    const cur = sql.exec(
      `SELECT ${t.columns.map(q).join(', ')} FROM ${q(t.table)} ORDER BY ${order}`
    );
    for (const row of cur)
      await digest.add(
        t.columns,
        t.columns.map(c => row[c]),
        t.pk
      );
    tables[t.table] = await digest.finish();
    // Independent semantic aggregates (SUM of the stored integers / JSON array lengths): the digest proves
    // both sides hold the same bytes, these prove the bytes MEAN the same thing in Postgres terms.
    if (Array.isArray(t.aggs) && t.aggs.length) {
      const exprs = t.aggs.map((a, i) => {
        if (!t.columns.includes(a.col))
          throw new HttpError(400, `agg column ${a.col} is not migrated`);
        if (a.op !== 'sum' && a.op !== 'sum_json_len') throw new HttpError(400, `agg op ${a.op}`);
        return a.op === 'sum'
          ? `CAST(SUM(${q(a.col)}) AS TEXT) AS a${i}`
          : `CAST(SUM(json_array_length(${q(a.col)})) AS TEXT) AS a${i}`;
      });
      const r = sql.exec(`SELECT ${exprs.join(', ')} FROM ${q(t.table)}`).toArray()[0];
      tables[t.table].aggs = Object.fromEntries(t.aggs.map((a, i) => [a.col, r[`a${i}`]]));
    }
  }
  let fk;
  if (body.fk) {
    const v = sql.exec('PRAGMA foreign_key_check').toArray();
    fk = { violations: v.length, sample: v.slice(0, 5) };
  }
  return json({ ok: true, tables, fk });
}

// DO-side bookkeeping and DERIVED state (the full cf-schema StoreDO carries these next to the data tables): they hold
// blobs and are rebuilt from the rows, so neither a seal baseline nor a verify digest covers them. Mirrors
// apps/api/src/cf/store-do/tables.ts.
const NOT_DATA =
  /^(sqlite_|_cf_|cf_|_migrations$|_identity$|search_dirty$|product_vector_state$|product_search_fts|customer_search_fts)/;

/** every application table of this DO (not sqlite_*, not the cf_* / _cf_* bookkeeping, not derived search state), with all its columns and pk */
function appTables(sql) {
  const names = sql
    .exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .toArray()
    .map(r => r.name)
    .filter(n => !NOT_DATA.test(n));
  return names.map(name => {
    const info = sql.exec(`SELECT name, pk FROM pragma_table_info(?) ORDER BY cid`, name).toArray();
    return {
      table: name,
      columns: info.map(c => c.name),
      pk: info
        .filter(c => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map(c => c.name),
    };
  });
}

async function rowKeyAndHash(t, row) {
  const values = t.columns.map(c => row[c]);
  const key = t.pk.map(c => canonValue(row[c])).join(PK_SEP);
  return { key, hash: await sha256Hex(canonRow(t.columns, values)), values };
}

// SEAL closes imports for good AND records a per-row baseline (pk -> sha256 of every column) of the whole
// DO, so a rollback can later tell exactly which rows the live DO changed (Audit DB-1).
async function recordBaseline(sql, transactionSync, seal) {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS cf_seal_baseline (tbl TEXT NOT NULL, pk TEXT NOT NULL, rowhash TEXT NOT NULL, PRIMARY KEY (tbl, pk))`
  );
  const rows = [];
  for (const t of appTables(sql)) {
    for (const r of sql.exec(`SELECT ${t.columns.map(q).join(', ')} FROM ${q(t.table)}`)) {
      const { key, hash } = await rowKeyAndHash(t, r);
      rows.push([t.table, key, hash]);
    }
  }
  transactionSync(() => {
    sql.exec('DELETE FROM cf_seal_baseline');
    for (const r of rows)
      sql.exec(`INSERT INTO cf_seal_baseline (tbl, pk, rowhash) VALUES (?, ?, ?)`, ...r);
    if (seal)
      sql.exec(
        `INSERT INTO cf_import_state (k, v) VALUES ('sealed', ?) ON CONFLICT (k) DO NOTHING`,
        String(Date.now())
      );
  });
  return rows.length;
}

async function doSeal({ sql, transactionSync }) {
  ensureLedger(sql);
  if (isSealed(sql)) return json({ ok: true, sealed: true, already: true });
  return json({
    ok: true,
    sealed: true,
    baselineRows: await recordBaseline(sql, transactionSync, true),
  });
}

// REBASE moves the baseline to the current state. Called only after a rollback replay COMMITTED and verified,
// so the replayed rows are no longer "changes" (a second rollback run is then a no-op, not a failed replay).
async function doRebase({ sql, transactionSync }) {
  ensureLedger(sql);
  if (!isSealed(sql)) throw new HttpError(409, 'not sealed: nothing to rebase');
  return json({ ok: true, baselineRows: await recordBaseline(sql, transactionSync, false) });
}

export const MAX_DIFF_ROWS = 50000;

// DIFF: rows added, changed or deleted since the seal. Full rows for added/changed (so they can be replayed
// elsewhere), primary-key values for deleted ones.
async function doDiff({ sql }) {
  ensureLedger(sql);
  if (!isSealed(sql)) throw new HttpError(409, 'not sealed: there is no baseline to diff against');
  const have = sql
    .exec(`SELECT 1 FROM sqlite_master WHERE name = 'cf_seal_baseline'`)
    .toArray().length;
  if (!have)
    throw new HttpError(
      409,
      'sealed without a baseline (sealed by an older tool): the changes cannot be enumerated'
    );
  const out = {};
  let total = 0;
  for (const t of appTables(sql)) {
    const base = new Map(
      sql
        .exec(`SELECT pk, rowhash FROM cf_seal_baseline WHERE tbl = ?`, t.table)
        .toArray()
        .map(r => [r.pk, r.rowhash])
    );
    const added = [];
    const changed = [];
    const seen = new Set();
    for (const r of sql.exec(`SELECT ${t.columns.map(q).join(', ')} FROM ${q(t.table)}`)) {
      const { key, hash, values } = await rowKeyAndHash(t, r);
      seen.add(key);
      const b = base.get(key);
      if (b === undefined) added.push(values);
      else if (b !== hash) changed.push(values);
    }
    const deleted = [...base.keys()].filter(k => !seen.has(k)).map(k => k.split(PK_SEP));
    const n = added.length + changed.length + deleted.length;
    if (n === 0) continue;
    total += n;
    if (total > MAX_DIFF_ROWS)
      throw new HttpError(413, `more than ${MAX_DIFF_ROWS} changed rows: replay by hand`);
    out[t.table] = { columns: t.columns, pk: t.pk, added, changed, deleted };
  }
  return json({ ok: true, total, tables: out });
}

// UNSEAL wipes every application row and all bookkeeping so the store can be imported afresh. Only for a
// retry AFTER a verified rollback; refuses without the exact confirmation string.
function doUnseal(request, { sql, transactionSync }, body) {
  ensureLedger(sql);
  if (body?.confirm !== 'wipe-and-unseal')
    throw new HttpError(400, 'confirm must be "wipe-and-unseal"');
  sql.exec('PRAGMA foreign_keys = OFF');
  try {
    transactionSync(() => {
      // rows reference each other (and cycle): check the foreign keys once, at commit, when every table is empty
      sql.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of appTables(sql)) sql.exec(`DELETE FROM ${q(t.table)}`);
      sql.exec('DELETE FROM cf_import_ledger');
      sql.exec('DELETE FROM cf_import_state');
      sql.exec('DROP TABLE IF EXISTS cf_seal_baseline');
    });
  } finally {
    sql.exec('PRAGMA foreign_keys = ON');
  }
  return json({ ok: true, sealed: false, wiped: true });
}

function doStatus({ sql }) {
  ensureLedger(sql);
  const ledger = sql
    .exec(
      `SELECT batch, tbl, COUNT(*) AS pages, SUM(rows) AS rows FROM cf_import_ledger GROUP BY batch, tbl ORDER BY batch, tbl`
    )
    .toArray();
  return json({ ok: true, sealed: isSealed(sql), ledger });
}

/** @param {Request} request @param {{sql: any, transactionSync: (fn: () => void) => void}} ctx */
export async function handleStoreAdmin(request, ctx) {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === 'POST' && path.endsWith('/__import'))
      return await doImport(request, ctx);
    if (request.method === 'POST' && path.endsWith('/__verify'))
      return await doVerify(request, ctx);
    if (request.method === 'POST' && path.endsWith('/__seal')) return await doSeal(ctx);
    if (request.method === 'POST' && path.endsWith('/__rebase')) return await doRebase(ctx);
    if (request.method === 'POST' && path.endsWith('/__diff')) return await doDiff(ctx);
    if (request.method === 'POST' && path.endsWith('/__unseal'))
      return doUnseal(request, ctx, await request.json().catch(() => null));
    if (request.method === 'GET' && path.endsWith('/__status')) return doStatus(ctx);
    return json({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.message, ...e.extra }, e.status);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
