// Real + local implementations of the `io` the backup/drill libraries take (see cf-backup.mjs).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertIdentityTables,
  assertPlatformTables,
  digestSqlite,
  exportStoreOverHttp,
  makeApiCall,
  decodeKeychainSecret,
} from './cf-backup.mjs';

export const BUCKET = 'ebda-db-backups';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: opts.binary ? 'buffer' : 'utf8',
    maxBuffer: 1 << 30,
    ...opts,
  });
  if (r.error) throw r.error;
  return r;
}

export function ageEncrypt(recipient) {
  return buf => {
    const r = run('age', ['-r', recipient], { input: buf, binary: true });
    if (r.status !== 0) throw new Error(`age encrypt failed: ${r.stderr}`);
    return r.stdout;
  };
}
/** identityText = the age secret key file contents (already hex-decoded if it came from the macOS Keychain). */
export function ageDecrypt(identityText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'age-id-'));
  const file = path.join(dir, 'identity.txt');
  writeFileSync(file, identityText, { mode: 0o600 });
  return buf => {
    const r = run('age', ['-d', '-i', file], { input: buf, binary: true });
    if (r.status !== 0) throw new Error(`age decrypt failed: ${r.stderr}`);
    return r.stdout;
  };
}
export const identityFromKeychain = service => {
  const r = run('security', ['find-generic-password', '-s', service, '-w']);
  if (r.status !== 0) throw new Error(`keychain item ${service} not found`);
  return decodeKeychainSecret(r.stdout);
};

/** R2 through wrangler (account token in the env). READ-ONLY variant has no put. */
export function wranglerR2({
  bucket = BUCKET,
  readOnly = false,
  wrangler = ['npx', 'wrangler'],
} = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'r2-'));
  const w = (args, o) => run(wrangler[0], [...wrangler.slice(1), ...args], o);
  return {
    async r2Get(key) {
      const f = path.join(tmp, 'get.bin');
      rmSync(f, { force: true });
      const r = w(['r2', 'object', 'get', `${bucket}/${key}`, '--file', f, '--remote']);
      if (r.status === 0) return readFileSync(f);
      if (/not exist|NoSuchKey|404/i.test(`${r.stderr}${r.stdout}`)) return null;
      throw new Error(`r2 get ${key} failed: ${r.stderr || r.stdout}`);
    },
    async r2Put(key, buf) {
      if (readOnly) throw new Error('read-only R2: refusing to write');
      const f = path.join(tmp, 'put.bin');
      writeFileSync(f, buf);
      const r = w(['r2', 'object', 'put', `${bucket}/${key}`, '--file', f, '--remote']);
      if (r.status !== 0) throw new Error(`r2 put ${key} failed: ${r.stderr || r.stdout}`);
    },
  };
}

/**
 * R2 over the Cloudflare REST API (api.cloudflare.com), used for the media copy: wrangler has no object listing and spawning it per
 * object would not fit the job timeout. Rate limit (measured 2026-11-10, response headers): `ratelimit-policy: "rtwo_gw_apigw";
 * q=1200;w=300`, a quota SHARED with the wrangler R2 calls of the same job. Every request is followed by a sleep that keeps this
 * client at <= rps (default 2 = 600 per 5 min, half the quota) - a measured throttle, not retry-on-429. A 429 still happens when
 * something else drained the quota (seen live: r=0, retry-after 300), so a 429/5xx is retried at most 3 times, waiting the
 * server's Retry-After (capped at 300 s), then fails the run.
 */
export function restR2({ accountId, token, rps = 2, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
  const gap = Math.ceil(1000 / rps);
  let last = 0;
  const enc = key => key.split('/').map(encodeURIComponent).join('/');
  const call = async (method, url, body) => {
    for (let attempt = 1; ; attempt++) {
      const wait = last + gap - Date.now();
      if (wait > 0) await sleep(wait);
      const res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(120_000),
      });
      last = Date.now();
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : 2000 * attempt);
        continue;
      }
      return res;
    }
  };
  return bucket => ({
    async list() {
      const out = [];
      let cursor = '';
      for (;;) {
        const res = await call('GET', `${base}/${bucket}/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.success) throw new Error(`r2 list ${bucket} failed: HTTP ${res.status} ${JSON.stringify(j?.errors ?? '')}`);
        for (const o of j.result ?? []) out.push({ key: o.key, etag: o.etag, size: Number(o.size) });
        cursor = j.result_info?.is_truncated ? j.result_info.cursor : '';
        if (!cursor) return out;
      }
    },
    async get(key) {
      const res = await call('GET', `${base}/${bucket}/objects/${enc(key)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`r2 get ${bucket}/${key} failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async put(key, buf) {
      const res = await call('PUT', `${base}/${bucket}/objects/${enc(key)}`, buf);
      if (!res.ok) throw new Error(`r2 put ${bucket}/${key} failed: HTTP ${res.status}`);
    },
  });
}

/** io.media for backupMedia(): source = ebda-media, destination = the backup bucket, both over REST. */
export function restMediaIo({ accountId, token, source = 'ebda-media', dest = BUCKET, rps }) {
  const r = restR2({ accountId, token, rps });
  const src = r(source);
  const dst = r(dest);
  return { list: src.list, getSource: src.get, put: dst.put, get: dst.get };
}

/** A directory standing in for the bucket (the weekly fixture drill and the tests). */
export function dirR2(root) {
  return {
    async r2Get(key) {
      const f = path.join(root, key);
      return existsSync(f) ? readFileSync(f) : null;
    },
    async r2Put(key, buf) {
      const f = path.join(root, key);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, buf);
    },
  };
}

export async function d1Digests(sqlText) {
  const db = new DatabaseSync(':memory:');
  try {
    // `wrangler d1 export` writes tables alphabetically with their rows interleaved, so a child's INSERT can precede its parent's
    // CREATE TABLE. D1 itself defers foreign keys while importing; node:sqlite enforces them by default and fails with
    // "no such table: main.stores" (the first real nightly run, 2026-11-05). Constraints are a property of the source, not of this read.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(sqlText);
    return await digestSqlite(db);
  } finally {
    db.close();
  }
}

const qi = n => `"${String(n).replace(/"/g, '""')}"`;

/**
 * Make a D1 SQL export restorable with a plain `wrangler d1 execute --file` (first real drill: "no such table: main.stores").
 * `wrangler d1 export` lists tables alphabetically with their rows interleaved, so a child's INSERT can precede its parent's
 * CREATE TABLE; neither a local D1 nor a new remote one accepts that. The artifact is rewritten as: defer_foreign_keys, every
 * CREATE TABLE (parents before children, ties by name), every row (tables in the same order, rows by primary key / rowid, values
 * as SQLite's own quote() literals so BLOBs and floats are exact), then indexes, triggers and views. Idempotent (a normalized dump
 * normalizes to itself) and deterministic, so skip-if-unchanged still works. Old artifacts are normalized on restore.
 */
export function normalizeD1Sql(sqlText) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(sqlText);
    const objs = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name"
      )
      .all();
    const tables = objs.filter(o => o.type === 'table').map(o => o.name);
    const deps = new Map(
      tables.map(t => [
        t,
        new Set(
          db
            .prepare(
              `SELECT "table" AS parent FROM pragma_foreign_key_list(${JSON.stringify(t).replace(/"/g, "'")})`
            )
            .all()
            .map(r => r.parent)
            .filter(p => p !== t && tables.includes(p))
        ),
      ])
    );
    const order = [];
    const done = new Set();
    while (order.length < tables.length) {
      const ready = tables.filter(t => !done.has(t) && [...deps.get(t)].every(d => done.has(d)));
      const next = ready.length ? ready : tables.filter(t => !done.has(t)).slice(0, 1); // a cycle: break it deterministically
      for (const t of next) (done.add(t), order.push(t));
    }
    const out = ['PRAGMA defer_foreign_keys=TRUE;'];
    for (const t of order) out.push(objs.find(o => o.name === t && o.type === 'table').sql + ';');
    // A foreign key may target a column that is unique only through a SEPARATE `CREATE UNIQUE INDEX` (store_subscriptions.plan_code ->
    // plans.code). Without that index SQLite reports "foreign key mismatch" on the child's first row, so every UNIQUE index is created
    // right after the tables, before any row. Plain indexes, triggers and views stay last (faster load, no trigger firing on restore).
    const isUniqueIndex = o => o.type === 'index' && /^\s*CREATE\s+UNIQUE\s+INDEX/i.test(o.sql);
    for (const o of objs.filter(isUniqueIndex)) out.push(o.sql + ';');
    const rest = objs.filter(o => o.type !== 'table' && !isUniqueIndex(o));
    for (const t of order) {
      const info = db
        .prepare(
          `SELECT name, pk FROM pragma_table_info(${JSON.stringify(t).replace(/"/g, "'")}) ORDER BY cid`
        )
        .all();
      const cols = info.map(c => c.name);
      const pk = info
        .filter(c => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map(c => qi(c.name));
      const rows = db
        .prepare(
          `SELECT ${cols.map(c => `quote(${qi(c)}) AS ${qi(c)}`).join(', ')} FROM ${qi(t)} ORDER BY ${pk.length ? pk.join(', ') : 'rowid'}`
        )
        .all();
      for (const r of rows)
        out.push(
          `INSERT INTO ${qi(t)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(c => r[c]).join(', ')});`
        );
    }
    for (const o of rest) out.push(o.sql + ';');
    return out.join('\n') + '\n';
  } finally {
    db.close();
  }
}

export function realBackupIo({
  recipient,
  apiUrl,
  secret,
  d1Name = 'ebda-platform',
  identityD1Name = 'ebda-identity',
  r2,
  media,
  log = () => {},
}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cfbk-'));
  // wrangler can fail on a network blip too: up to 3 tries, every attempt logged (never the arguments after --command).
  const wr = args => {
    let r;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = Date.now();
      r = run('npx', ['wrangler', ...args]);
      log(
        `wrangler ${args.slice(0, 2).join(' ')} attempt ${attempt}: exit ${r.status} in ${Date.now() - t0} ms`
      );
      if (r.status === 0) break;
    }
    return r;
  };
  const exportD1Db = async (name, assertTables, file) => {
    const out = path.join(tmp, file);
    const r = wr(['d1', 'export', name, '--remote', '--output', out]);
    if (r.status !== 0) throw new Error(`d1 export ${name} failed: ${r.stderr || r.stdout}`);
    const exported = readFileSync(out);
    log(`D1 ${name} exported: ${exported.length} bytes`);
    const tables = assertTables(await d1Digests(exported.toString('utf8')));
    const raw = Buffer.from(normalizeD1Sql(exported.toString('utf8')));
    log(`D1 ${name} export normalized (parents before children, schema first): ${raw.length} bytes`);
    return { raw, tables };
  };
  return {
    ...r2,
    ...(media ? { media } : {}),
    encrypt: ageEncrypt(recipient),
    async exportD1() {
      return exportD1Db(d1Name, assertPlatformTables, 'd1.sql');
    },
    async exportIdentity() {
      return exportD1Db(identityD1Name, assertIdentityTables, 'identity.sql');
    },
    async listStoreIds() {
      const r = wr([
        'd1',
        'execute',
        d1Name,
        '--remote',
        '--json',
        '--command',
        "SELECT id FROM stores WHERE storage_backend = 'do' ORDER BY id",
      ]);
      if (r.status !== 0) throw new Error(`store list failed: ${r.stderr || r.stdout}`);
      const j = JSON.parse(r.stdout);
      return (j[0]?.results ?? []).map(x => x.id);
    },
    async exportStore(id) {
      return exportStoreOverHttp(makeApiCall({ apiUrl, secret, log }), id, { log });
    },
  };
}
