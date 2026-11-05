// Real + local implementations of the `io` the backup/drill libraries take (see cf-backup.mjs).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
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
  r2,
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
  return {
    ...r2,
    encrypt: ageEncrypt(recipient),
    async exportD1() {
      const out = path.join(tmp, 'd1.sql');
      const r = wr(['d1', 'export', d1Name, '--remote', '--output', out]);
      if (r.status !== 0) throw new Error(`d1 export failed: ${r.stderr || r.stdout}`);
      const exported = readFileSync(out);
      log(`D1 ${d1Name} exported: ${exported.length} bytes`);
      const tables = assertPlatformTables(await d1Digests(exported.toString('utf8')));
      const raw = Buffer.from(normalizeD1Sql(exported.toString('utf8')));
      log(`D1 export normalized (parents before children, schema first): ${raw.length} bytes`);
      return { raw, tables };
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
