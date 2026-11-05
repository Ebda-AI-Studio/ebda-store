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

export const EXPORT_PAGE_ROWS = 2000;

/**
 * Export one StoreDO through the bearer-checked, read-only `__tables` + `__export` actions. `call(path, body?)` returns parsed JSON
 * or throws. Output: an NDJSON text (one header object per table, then its rows as arrays, in `__import` shape) plus the per-table
 * count + digest the restore must reproduce. Nothing is written back to the DO.
 */
export async function exportStoreOverHttp(call, storeId) {
  const base = `/cutover/stores/${storeId}`;
  const { tables: names } = await call(`${base}/__tables`);
  const lines = [];
  const tables = {};
  // `__miniflare_*` exists only on local workerd; __export refuses any name that is not [a-z][a-z0-9_]* (never a production table).
  for (const table of names.filter(n => /^[a-z]/.test(n))) {
    let offset = 0;
    let total = Infinity;
    const d = new TableDigest();
    let head = null;
    const rows = [];
    while (offset < total) {
      const page = await call(`${base}/__export`, { table, offset, limit: EXPORT_PAGE_ROWS });
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
    lines.push(JSON.stringify({ ...head, total }), ...rows);
    tables[table] = await d.finish();
  }
  return { raw: Buffer.from(lines.join('\n') + '\n'), tables };
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

async function putVerified(io, key, buf) {
  await io.r2Put(key, buf);
  const back = await io.r2Get(key);
  if (!back || sha256(back) !== sha256(buf)) throw new Error(`read-back sha256 differs for ${key}`);
}

/**
 * The nightly run. Returns the report; throws if anything could not be stored and read back. A size-guard breach does NOT throw
 * (the data is safe): it sets report.ok = false and lists `problems`, and the CLI turns that into a failing workflow.
 */
export async function runBackup({ io, now = new Date(), cap = DEFAULT_CAP_BYTES }) {
  const day = dayOf(now);
  const tiers = tiersFor(now);
  const ledger = (await r2Json(io, LEDGER_KEY)) ?? emptyLedger();

  const artifacts = [];
  const d1 = await io.exportD1();
  artifacts.push({ name: 'd1-ebda-platform', ext: 'sql', ...d1 });
  for (const id of await io.listStoreIds())
    artifacts.push({ name: `do-${id}`, ext: 'ndjson', ...(await io.exportStore(id)) });

  let uploaded = 0;
  let rawTotal = 0;
  let gzTotal = 0;
  const manifests = Object.fromEntries(tiers.map(t => [t, { artifacts: {} }]));
  for (const a of artifacts) {
    const rawSha256 = sha256(a.raw);
    const gz = compress(a.raw);
    rawTotal += a.raw.length;
    gzTotal += gz.length;
    let enc = null;
    const base = {
      rawBytes: a.raw.length,
      gzBytes: gz.length,
      rawSha256,
      tables: a.tables,
      ext: a.ext,
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
      enc ??= await io.encrypt(gz);
      const key = objectKey(tier, day, `${a.name}.${a.ext}.gz.age`);
      await putVerified(io, key, enc);
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
    await putVerified(io, key, body);
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
