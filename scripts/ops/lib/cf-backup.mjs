// Off-Cloudflare backup of production data (Ruling NZ-BACKUP-1): D1 `ebda-platform` + every StoreDO store ->
// gzip -9 -> age -> R2 bucket `ebda-db-backups`, prefix `cf/{daily,weekly,monthly}/<YYYY-MM-DD>/`.
//
// All side effects (wrangler, age, the store-admin HTTP surface, R2) go through the injected `io`, so the unit tests run the
// whole pipeline with fakes and the weekly drill runs it against a local directory standing in for R2.
//
// io = {
//   exportD1() -> { raw: Buffer, tables }          wrangler d1 export --remote + digestSqlite
//   listStoreIds() -> string[]
//   exportStore(id) -> { raw: Buffer, tables }     __tables + paged __export (see exportStoreOverHttp)
//   encrypt(buf) -> Buffer                          age -r <public key>
//   r2Put(key, buf), r2Get(key) -> Buffer | null
// }
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { TableDigest } from '../../../packages/cf-migrate/src/canon.mjs';

export const TIERS = {
  daily: { days: 7 },
  weekly: { days: 28 },
  monthly: { days: 93 },
};
/** An unchanged artifact is referenced (not re-uploaded) only while the object it points at has >= this many days of life left. */
export const REUSE_MAX_AGE_DAYS = 4;
export const DEFAULT_CAP_BYTES = 1024 ** 3;
/** Below this a run is never "growth" (a day where nothing changed uploads only manifests). */
export const GROWTH_FLOOR_BYTES = 1024 * 1024;
export const GROWTH_FACTOR = 2;
export const HISTORY_RUNS = 7;

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');
export const compress = buf => gzipSync(buf, { level: 9 });
export const decompress = buf => gunzipSync(buf);

const DAY_MS = 86_400_000;
export const dayOf = d => d.toISOString().slice(0, 10);
export const ageDays = (fromDay, toDay) =>
  Math.round((Date.parse(toDay) - Date.parse(fromDay)) / DAY_MS);

/** daily every night; weekly on Sunday (UTC); monthly on the 1st. */
export function tiersFor(date) {
  const t = ['daily'];
  if (date.getUTCDay() === 0) t.push('weekly');
  if (date.getUTCDate() === 1) t.push('monthly');
  return t;
}
export const objectKey = (tier, day, name) => `cf/${tier}/${day}/${name}`;
export const manifestKey = (tier, day) => objectKey(tier, day, 'manifest.json');
export const LEDGER_KEY = 'cf/ledger.json';
export const LATEST_KEY = 'cf/latest.json';

/**
 * macOS `security find-generic-password -w` returns a multi-line secret as HEX when it contains a newline. An age identity file is
 * multi-line, so a pure-hex output must be decoded (xxd -r -p) before age sees it. Anything not pure hex is returned unchanged.
 */
export function decodeKeychainSecret(out) {
  const t = String(out).trim();
  if (t.length >= 2 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t))
    return Buffer.from(t, 'hex').toString('utf8');
  return String(out);
}

export function median(nums) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Size guard. Pure: returns the list of problems (empty = fine). */
export function sizeProblems({ uploaded, history, total, cap }) {
  const problems = [];
  const med = median(history.slice(-HISTORY_RUNS));
  if (history.length >= 3 && uploaded > GROWTH_FLOOR_BYTES && uploaded > GROWTH_FACTOR * med)
    problems.push(
      `this run uploaded ${uploaded} bytes, more than ${GROWTH_FACTOR}x the median of the last ${Math.min(history.length, HISTORY_RUNS)} runs (${med})`
    );
  if (total > cap) problems.push(`cf/ holds an estimated ${total} bytes, over the cap of ${cap}`);
  return problems;
}

/** Digest every table of a node:sqlite database (same canonical form as the cutover __verify). BLOBs are digested as hex. */
export async function digestSqlite(db) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all()
    .map(r => r.name);
  const out = {};
  for (const t of names) {
    const info = db
      .prepare(`SELECT name, pk FROM pragma_table_info('${t.replace(/'/g, "''")}') ORDER BY cid`)
      .all();
    const columns = info.map(c => c.name);
    const pk = info
      .filter(c => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(c => c.name);
    const d = new TableDigest();
    for (const row of db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).all())
      await d.add(
        columns,
        columns.map(c => {
          const v = row[c];
          return v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v;
        }),
        pk.length ? pk : columns
      );
    out[t] = await d.finish();
  }
  return out;
}

/**
 * Guard on the D1 export (a backup of nothing is not a backup): it must hold tables, and `stores`, the directory every store hangs off.
 * Throws loudly instead of uploading an empty or wrong database.
 */
export function assertPlatformTables(tables) {
  const names = Object.keys(tables ?? {});
  if (names.length === 0)
    throw new Error('D1 export has ZERO tables: refusing to back up an empty database');
  if (!tables.stores)
    throw new Error(
      `D1 export has no \`stores\` table (found: ${names.slice(0, 8).join(', ')}): wrong or empty database`
    );
  return tables;
}

export const EXPORT_PAGE_ROWS = 500;
/**
 * Tables an older StoreDO still holds that the current store schema no longer has (a fresh DO rejects them: "unknown table").
 * onesignal_subscriptions moved to D1 (platform migration 0006, Ruling NZ-C-11). They are NOT dumped, but each is listed in the manifest
 * with its row count (`skippedTables`) so nothing disappears silently.
 */
export const DO_MOVED_TABLES = new Set(['onesignal_subscriptions']);
export const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 3;

const TRANSIENT_CODES =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|UND_ERR|TimeoutError|AbortError|socket hang up/i;
/** A network reset/timeout (fetch wraps it as "fetch failed" with a cause), a 429, or a 5xx is worth another try; a 4xx is not. */
export function isTransient(err) {
  if (typeof err?.status === 'number') return err.status === 429 || err.status >= 500;
  const text = `${err?.name ?? ''} ${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`;
  return err?.message === 'fetch failed' || TRANSIENT_CODES.test(text);
}

/** fn(attempt) with up to MAX_ATTEMPTS tries and exponential backoff on transient errors; the final error names `label`. */
export async function withRetry(
  label,
  fn,
  {
    tries = MAX_ATTEMPTS,
    baseMs = 1000,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    log = () => {},
  } = {}
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const why = `${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ''}`;
      if (!isTransient(e) || attempt >= tries)
        throw new Error(`${label}: failed after ${attempt} attempt(s): ${why}`, { cause: e });
      log(`retry ${attempt}/${tries - 1} ${label}: ${why}`);
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

/** The authenticated call into /cutover/...: per-request timeout, retry with backoff, errors that name the target. */
export function makeApiCall({
  apiUrl,
  secret,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  sleep,
  baseMs,
  log = () => {},
}) {
  return (p, body) =>
    withRetry(
      `${body?.table ? `${p} [${body.table}@${body.offset ?? 0}]` : p}`,
      async () => {
        const res = await fetchImpl(apiUrl + p, {
          method: body ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) {
          const e = new Error(`HTTP ${res.status} ${j.error ?? ''}`.trim());
          e.status = res.status;
          throw e;
        }
        return j;
      },
      { sleep, baseMs, log }
    );
}

/**
 * Export one StoreDO through the bearer-checked, read-only `__tables` + `__export` actions. `call(path, body?)` returns parsed JSON
 * or throws. Output: an NDJSON text (one header object per table, then its rows as arrays, in `__import` shape) plus the per-table
 * count + digest the restore must reproduce. Nothing is written back to the DO.
 */
export async function exportStoreOverHttp(
  call,
  storeId,
  { log = () => {}, pageRows = EXPORT_PAGE_ROWS } = {}
) {
  const t0 = Date.now();
  const base = `/cutover/stores/${storeId}`;
  const { tables: names } = await call(`${base}/__tables`);
  const lines = [];
  const tables = {};
  const skipped = {};
  for (const t of names.filter(n => DO_MOVED_TABLES.has(n))) {
    const probe = await call(`${base}/__export`, { table: t, offset: 0, limit: 0 });
    skipped[t] = probe.total;
    log(
      `store ${storeId} ${t}: SKIPPED (moved out of the StoreDO schema), ${probe.total} stale row(s) left out`
    );
  }
  // `__miniflare_*` exists only on local workerd; __export refuses any name that is not [a-z][a-z0-9_]* (never a production table).
  for (const table of names.filter(n => /^[a-z]/.test(n) && !DO_MOVED_TABLES.has(n))) {
    let offset = 0;
    let total = Infinity;
    const d = new TableDigest();
    let head = null;
    const rows = [];
    while (offset < total) {
      const page = await call(`${base}/__export`, { table, offset, limit: pageRows });
      if (!head) head = { table, columns: page.columns, pk: page.pk };
      total = page.total;
      if (page.rows.length === 0) break;
      for (const r of page.rows) {
        await d.add(page.columns, r, page.pk);
        rows.push(JSON.stringify(r));
      }
      offset += page.rows.length;
    }
    if (rows.length !== total)
      throw new Error(`${storeId}.${table}: exported ${rows.length} rows, the table said ${total}`);
    log(`store ${storeId} ${table}: ${rows.length} rows`);
    lines.push(JSON.stringify({ ...head, total }), ...rows);
    tables[table] = await d.finish();
  }
  const raw = Buffer.from(lines.join('\n') + '\n');
  log(
    `store ${storeId} export done: ${Object.keys(tables).length} tables, ${raw.length} bytes, ${Date.now() - t0} ms`
  );
  return { raw, tables, ...(Object.keys(skipped).length ? { skipped } : {}) };
}

/** Parse the NDJSON written by exportStoreOverHttp back into [{table, columns, pk, total, rows}]. */
export function parseStoreDump(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('{')) out.push({ ...JSON.parse(line), rows: [] });
    else out[out.length - 1].rows.push(JSON.parse(line));
  }
  return out;
}

const emptyLedger = () => ({ objects: {}, runs: [], last: {} });

async function r2Json(io, key) {
  const b = await io.r2Get(key);
  return b ? JSON.parse(b.toString('utf8')) : null;
}

async function putVerified(io, key, buf, log = () => {}) {
  log(`R2 put ${key} (${buf.length} bytes)`);
  await io.r2Put(key, buf);
  log(`R2 read-back ${key}`);
  const back = await io.r2Get(key);
  if (!back || sha256(back) !== sha256(buf)) throw new Error(`read-back sha256 differs for ${key}`);
}

/**
 * The nightly run. Returns the report; throws if anything could not be stored and read back. A size-guard breach does NOT throw
 * (the data is safe): it sets report.ok = false and lists `problems`, and the CLI turns that into a failing workflow.
 */
export async function runBackup({ io, now = new Date(), cap = DEFAULT_CAP_BYTES, log = () => {} }) {
  const day = dayOf(now);
  const tiers = tiersFor(now);
  const ledger = (await r2Json(io, LEDGER_KEY)) ?? emptyLedger();

  const artifacts = [];
  log('D1 export start');
  const d1 = await io.exportD1();
  log(`D1 export done: ${Object.keys(d1.tables).length} tables, ${d1.raw.length} bytes`);
  artifacts.push({ name: 'd1-ebda-platform', ext: 'sql', ...d1 });
  const ids = await io.listStoreIds();
  log(`${ids.length} StoreDO store(s) to export`);
  for (const id of ids) {
    log(`store ${id} export start`);
    artifacts.push({ name: `do-${id}`, ext: 'ndjson', ...(await io.exportStore(id)) });
  }

  let uploaded = 0;
  let rawTotal = 0;
  let gzTotal = 0;
  const manifests = Object.fromEntries(tiers.map(t => [t, { artifacts: {} }]));
  for (const a of artifacts) {
    const rawSha256 = sha256(a.raw);
    const gz = compress(a.raw);
    log(`${a.name}: compress ${a.raw.length} -> ${gz.length} bytes`);
    rawTotal += a.raw.length;
    gzTotal += gz.length;
    let enc = null;
    const base = {
      rawBytes: a.raw.length,
      gzBytes: gz.length,
      rawSha256,
      tables: a.tables,
      ext: a.ext,
      ...(a.skipped ? { skippedTables: a.skipped } : {}),
    };
    for (const tier of tiers) {
      const prev = tier === 'daily' ? ledger.last[a.name] : null;
      if (
        prev &&
        prev.rawSha256 === rawSha256 &&
        ledger.objects[prev.key] &&
        ageDays(prev.day, day) <= REUSE_MAX_AGE_DAYS
      ) {
        manifests.daily.artifacts[a.name] = {
          ...base,
          key: prev.key,
          reused: true,
          encBytes: prev.encBytes,
          encSha256: prev.encSha256,
        };
        continue;
      }
      if (!enc) {
        enc = await io.encrypt(gz);
        log(`${a.name}: encrypt ${gz.length} -> ${enc.length} bytes`);
      }
      const key = objectKey(tier, day, `${a.name}.${a.ext}.gz.age`);
      await putVerified(io, key, enc, log);
      ledger.objects[key] = { bytes: enc.length, tier, day };
      uploaded += enc.length;
      const entry = { ...base, key, reused: false, encBytes: enc.length, encSha256: sha256(enc) };
      manifests[tier].artifacts[a.name] = entry;
      if (tier === 'daily')
        ledger.last[a.name] = {
          rawSha256,
          key,
          day,
          encBytes: enc.length,
          encSha256: entry.encSha256,
        };
    }
  }

  for (const tier of tiers) {
    const body = Buffer.from(
      JSON.stringify(
        { version: 1, tier, day, takenAt: now.toISOString(), artifacts: manifests[tier].artifacts },
        null,
        2
      )
    );
    const key = manifestKey(tier, day);
    await putVerified(io, key, body, log);
    ledger.objects[key] = { bytes: body.length, tier, day };
    uploaded += body.length;
  }

  // Ledger: forget what the bucket lifecycle has expired, record this run, compute the footprint estimate.
  for (const [k, o] of Object.entries(ledger.objects))
    if (ageDays(o.day, day) > TIERS[o.tier].days) delete ledger.objects[k];
  for (const [n, l] of Object.entries(ledger.last))
    if (!ledger.objects[l.key]) delete ledger.last[n];
  const history = ledger.runs.map(r => r.uploaded);
  const total = Object.values(ledger.objects).reduce((a, o) => a + o.bytes, 0);
  ledger.runs = [...ledger.runs.filter(r => r.day !== day), { day, uploaded }].slice(-30);
  await io.r2Put(LEDGER_KEY, Buffer.from(JSON.stringify(ledger)));
  await io.r2Put(
    LATEST_KEY,
    Buffer.from(JSON.stringify({ day, tiers, takenAt: now.toISOString() }))
  );

  const problems = sizeProblems({ uploaded, history, total, cap });
  return {
    ok: problems.length === 0,
    day,
    tiers,
    artifacts: artifacts.length,
    stores: artifacts.length - 1,
    rawBytes: rawTotal,
    gzBytes: gzTotal,
    uploadedBytes: uploaded,
    reused: Object.values(manifests.daily.artifacts).filter(e => e.reused).length,
    estimatedCfTotalBytes: total,
    capBytes: cap,
    problems,
  };
}

/** Fetch + decrypt + decompress + checksum every artifact of one manifest. decrypt(buf) -> Buffer (age -d). */
export async function fetchBackupSet({ io, tier = 'daily', day, decrypt }) {
  if (!day) {
    const latest = await r2Json(io, LATEST_KEY);
    if (!latest) throw new Error('cf/latest.json missing: no backup has completed');
    day = latest.day;
  }
  const manifest = await r2Json(io, manifestKey(tier, day));
  if (!manifest) throw new Error(`no manifest at ${manifestKey(tier, day)}`);
  const files = {};
  for (const [name, e] of Object.entries(manifest.artifacts)) {
    const enc = await io.r2Get(e.key);
    if (!enc) throw new Error(`${name}: object ${e.key} missing`);
    if (sha256(enc) !== e.encSha256)
      throw new Error(`${name}: encrypted object checksum differs from the manifest`);
    const raw = decompress(await decrypt(enc));
    if (raw.length !== e.rawBytes || sha256(raw) !== e.rawSha256)
      throw new Error(`${name}: decrypted content differs from the manifest`);
    files[name] = raw;
  }
  return { manifest, files };
}

/** Compare per-table count + digest maps. Returns [{table, ok, want, got}] with a row for every table on either side. */
export function compareTables(want, got) {
  const names = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
  return names.map(table => {
    const w = want[table];
    const g = got[table];
    return {
      table,
      ok: !!w && !!g && w.count === g.count && w.digest === g.digest,
      want: w?.count ?? null,
      got: g?.count ?? null,
    };
  });
}
