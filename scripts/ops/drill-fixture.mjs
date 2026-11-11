#!/usr/bin/env node
// Builds a LOCAL fixture "bucket" for the weekly restore drill (no Cloudflare account, no secrets): boots the cutover harness
// (real StoreDO schema on workerd), fills it with generic rows through the harness-only __sql door, runs the REAL backup pipeline
// (export over __export, gzip, age, tiers, read-back) into a directory, and writes the age identity next to it.
//   node scripts/ops/drill-fixture.mjs <outDir> [--port 8797]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runBackup, exportStoreOverHttp, digestSqlite } from './lib/cf-backup.mjs';
import { ageEncrypt, dirR2 } from './lib/cf-backup-io.mjs';
import { assertLoopback, replayOrder } from './lib/cf-drill.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2];
if (!out) throw new Error('usage: drill-fixture.mjs <outDir> [--port N]');
const port = process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : '8797';
const base = `http://127.0.0.1:${port}`;
assertLoopback(base);
mkdirSync(out, { recursive: true });
const secret = `fixture-${randomBytes(16).toString('hex')}`;
const storeId = '11111111-1111-4111-8111-111111111111';

const keygen = spawnSync('age-keygen', [], { encoding: 'utf8' });
if (keygen.status !== 0) throw new Error('age-keygen not found');
const identity = keygen.stdout;
const recipient = /public key: (age1\S+)/.exec(keygen.stderr + keygen.stdout)[1];
writeFileSync(path.join(out, 'identity.txt'), identity, { mode: 0o600 });

const state = mkdtempSync(path.join(tmpdir(), 'drill-fixture-'));
const child = spawn(
  'npx',
  [
    'wrangler',
    'dev',
    '--local',
    '--port',
    port,
    '--persist-to',
    state,
    '-c',
    'packages/cf-migrate/harness/.wrangler.smoke.jsonc',
    '--var',
    `CUTOVER_IMPORT_SECRET:${secret}`,
  ],
  { cwd: ROOT, detached: true, stdio: 'ignore' }
);
const stop = () => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
};
process.on('exit', stop);
const call = async (p, body) => {
  const res = await fetch(base + p, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${j.error ?? ''}`);
  return j;
};
for (let i = 0; ; i++) {
  try {
    await call(`/cutover/stores/${storeId}/__tables`);
    break;
  } catch (e) {
    if (i > 45) throw e;
    await new Promise(r => setTimeout(r, 2000));
  }
}
const sql = (s, params = []) => call(`/cutover/stores/${storeId}/__sql`, { sql: s, params });

// A stray table an older StoreDO still holds (the real onesignal_subscriptions case): the backup must leave it out and say so.
await sql('CREATE TABLE IF NOT EXISTS onesignal_subscriptions (id TEXT PRIMARY KEY)');
await sql("INSERT OR IGNORE INTO onesignal_subscriptions VALUES ('stale-1')");

// Generic rows for every application table, parents first, foreign-key columns pointing at a real parent row (so the restore has
// real child-after-parent data to order). A table whose constraints a blind row cannot satisfy is skipped (and named).
const { tables: allTables } = await call(`/cutover/stores/${storeId}/__tables`);
const { tables: fks } = await call(`/cutover/stores/${storeId}/__fks`);
const tables = replayOrder(
  allTables.filter(t => /^[a-z]/.test(t) && t !== 'onesignal_subscriptions'),
  fks
);
const seeded = [];
for (const t of tables) {
  const cols = (
    await sql(
      `SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${t}')`
    )
  ).rows;
  const fkc = (
    await sql(
      `SELECT "table" AS parent, "from" AS fcol, "to" AS tcol FROM pragma_foreign_key_list('${t}')`
    )
  ).rows;
  const ref = {};
  for (const f of fkc.filter(f => f.parent !== t)) {
    const r = (await sql(`SELECT "${f.tcol}" AS v FROM "${f.parent}" LIMIT 1`)).rows[0];
    if (r) ref[f.fcol] = r.v;
  }
  let ok = 0;
  for (let n = 1; n <= 3; n++) {
    const use = cols.filter(c => c.nn || c.pk || c.name in ref);
    const vals = use.map(c =>
      c.name in ref ? ref[c.name] : /INT|REAL|NUM/i.test(c.type) ? n : `fx-${t}-${c.name}-${n}`
    );
    try {
      await sql(
        `INSERT INTO "${t}" (${use.map(c => `"${c.name}"`).join(',')}) VALUES (${use.map(() => '?').join(',')})`,
        vals
      );
      ok++;
    } catch {}
  }
  if (ok) seeded.push(`${t}:${ok}`);
}
console.log(`fixture rows in ${seeded.length}/${tables.length} StoreDO tables`);
if (seeded.length < 3)
  throw new Error('fixture seeded fewer than 3 tables: the generic row generator needs work');

// A gold-rate product + variant (P2-3 of the 2026-11-12 data-jobs audit): the ebda_gold_price_guard_* triggers abort writing one unless
// do_flags.gold_reprice = 1, so a restore path that does not raise the flag fails the drill (digest mismatch or import error).
// The fixture raises it itself for the seed and clears it again; a failure here means the seed, not the restore, is broken.
await sql(
  "INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1) ON CONFLICT (name) DO UPDATE SET value = 1"
);
await sql(
  "INSERT INTO products (id, store_id, name, slug, price, status, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps) VALUES ('fx-gold-1', ?, 'Gold ring', 'fx-gold-ring', 1000, 'active', 'gold_rate', 21, 3250, 'per_gram', 15000, 0)",
  [storeId]
);
await sql(
  "INSERT INTO product_variants (id, product_id, title, sku, price, pricing_mode) VALUES ('fx-gold-v1', 'fx-gold-1', 'Size 7', 'FX-GOLD-1', 1200, 'gold_rate')"
);
await sql("UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'");
const goldRows = (await sql("SELECT count(*) AS n FROM products WHERE pricing_mode = 'gold_rate'"))
  .rows[0].n;
if (goldRows !== 1) throw new Error('fixture: gold-rate product missing');
console.log('fixture gold-rate product + variant seeded');

// D1 stand-in: the REAL platform schema (all migrations) plus one store row that points at the DO backend.
const d1 = new DatabaseSync(':memory:');
const migDir = path.join(ROOT, 'packages/cf-schema/migrations/platform');
for (const f of readdirSync(migDir)
  .filter(n => n.endsWith('.sql'))
  .sort())
  d1.exec(readFileSync(path.join(migDir, f), 'utf8'));
const ownerId = '99999999-9999-4999-8999-999999999999';
d1.exec(
  `INSERT INTO stores (id, name, slug, owner_id, storage_backend) VALUES ('${storeId}', 'Fixture', 'fixture', '${ownerId}', 'do')`
);
const q = v =>
  v === null
    ? 'NULL'
    : typeof v === 'number' || typeof v === 'bigint'
      ? String(v)
      : v instanceof Uint8Array
        ? `X'${Buffer.from(v).toString('hex')}'`
        : `'${String(v).replace(/'/g, "''")}'`;
const dumpOf = db => {
  const objs = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
    )
    .all();
  return (
    [
      ...objs.filter(o => o.type === 'table').map(o => o.sql + ';'),
      ...objs
        .filter(o => o.type === 'table')
        .flatMap(o =>
          db
            .prepare(`SELECT * FROM "${o.name}"`)
            .all()
            .map(
              r =>
                `INSERT INTO "${o.name}" (${Object.keys(r)
                  .map(k => `"${k}"`)
                  .join(',')}) VALUES (${Object.values(r).map(q).join(',')});`
            )
        ),
      ...objs.filter(o => o.type !== 'table').map(o => o.sql + ';'),
    ].join('\n') + '\n'
  );
};
const dump = dumpOf(d1);

// Identity D1 stand-in (Ruling ICEBERG-BK-1): the REAL ebda-identity schema (apps/accounts/migrations) plus one merchant user.
const idDb = new DatabaseSync(':memory:');
const idMig = path.join(ROOT, 'apps/accounts/migrations');
for (const f of readdirSync(idMig)
  .filter(n => n.endsWith('.sql'))
  .sort())
  idDb.exec(readFileSync(path.join(idMig, f), 'utf8'));
idDb.exec(
  `INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, created_at, updated_at) VALUES ('${ownerId}', 'owner@fixture.invalid', 'x', 'Fixture', 'Owner', 'store_admin', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
);
const idDump = dumpOf(idDb);

const io = {
  ...dirR2(out),
  encrypt: ageEncrypt(recipient),
  exportD1: async () => ({ raw: Buffer.from(dump), tables: await digestSqlite(d1) }),
  exportIdentity: async () => ({ raw: Buffer.from(idDump), tables: await digestSqlite(idDb) }),
  listStoreIds: async () => [storeId],
  exportStore: id => exportStoreOverHttp(call, id),
};
const report = await runBackup({ io });
console.log(JSON.stringify(report));
stop();
process.exit(report.ok ? 0 : 1);
