#!/usr/bin/env node
// Phase 4.1/4.2 verification: per table, row count + digest of every migrated column on BOTH sides.
//   node scripts/cf/verify-store.mjs --store <id|slug> --do-url <base>
//   node scripts/cf/verify-store.mjs --all --do-url <base> [--d1 ebda-platform --d1-target local|remote ...]
// Prints "N/N tables equal" per store, a grand total, and exits 0 only when every table is equal and the
// DO reports zero foreign-key violations. The Postgres side is recomputed here, independent of the
// migrate scripts' own bookkeeping.
import fs from 'node:fs';
import { cli, fmtMs } from './lib/cli.mjs';
import { connectReadOnly, resolveStore } from './lib/pg.mjs';
import { loadPlan, entityIndexQuery, ENTITY_KIND_TABLES } from './lib/plan.mjs';
import { bindPlan, sourceAggs, sourceDigest, unmigratedTables } from './lib/source.mjs';
import { d1QueryMany } from './lib/d1.mjs';
import { TableDigest } from '../../packages/cf-migrate/src/canon.mjs';
import { RULED_UNMIGRATED_TABLES } from './lib/plan.mjs';
import {
  CF_ONLY_TABLES,
  acceptableDigests,
  knownDoTable,
} from '../../packages/cf-migrate/src/coverage.mjs';

/** the target's digest for a Cloudflare-only table must equal one of its acceptable row sets (Ruling CUTOVER-5) */
async function cfOnlyExpect(db, t, got) {
  const ok = await acceptableDigests(t, CF_ONLY_TABLES[`${db}:${t.name}`]);
  return ok.find(a => got && a.count === got.count && a.digest === got.digest) ?? ok[0];
}

const { args } = cli({
  d1: { type: 'string' },
  'd1-target': { type: 'string', default: 'local' },
  'd1-config': { type: 'string' },
  'persist-to': { type: 'string' },
  'skip-platform': { type: 'boolean', default: false },
  'platform-only': { type: 'boolean', default: false },
});

async function verifyDoStore(client, bound, plan, store) {
  const tables = bound.store.tables;
  const src = {};
  const aggSrc = {};
  for (const bt of tables) {
    src[bt.name] = await sourceDigest(client, bt, plan.store, 'store', store.id);
    aggSrc[bt.name] = await sourceAggs(client, bt, plan.store, 'store', store.id);
  }
  // Cloudflare-only tables (no Postgres twin): checked against their ruled row sets, same count + checksum path
  const cfOnly = plan.store.filter(t => !t.inPg && CF_ONLY_TABLES[`store-do:${t.name}`]);
  const res = await fetch(`${args.doUrl}/cutover/stores/${store.id}/__verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${args.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fk: true,
      tables: [
        ...tables.map(bt => ({
          table: bt.name,
          columns: bt.columns.map(c => c.col),
          pk: bt.pk,
          aggs: aggSrc[bt.name].specs.map(({ col, op }) => ({ col, op })),
        })),
        ...cfOnly.map(t => ({ table: t.name, columns: t.columns.map(c => c.col), pk: t.pk })),
      ],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`__verify HTTP ${res.status}: ${j.error}`);
  // fold the semantic aggregates into the per-table digest so a mismatch fails the table
  let aggCols = 0;
  for (const bt of tables) {
    const want = aggSrc[bt.name].values;
    const got = j.tables[bt.name]?.aggs ?? {};
    for (const col of Object.keys(want)) {
      aggCols++;
      if ((want[col] ?? null) !== (got[col] ?? null)) {
        console.log(`  SEMANTIC ${bt.name}.${col}: Postgres ${want[col]} vs target ${got[col]}`);
        j.tables[bt.name].digest = `semantic-mismatch:${col}`;
      }
    }
  }
  if (aggCols)
    console.log(
      `  semantic aggregates (decimal, date, bool, list sums, recomputed in Postgres with different expressions): ${aggCols} columns checked`
    );
  for (const t of cfOnly) src[t.name] = await cfOnlyExpect('store-do', t, j.tables[t.name]);
  // the DO must hold no table the cutover did not look at
  const tj = await fetch(`${args.doUrl}/cutover/stores/${store.id}/__tables`, {
    headers: { authorization: `Bearer ${args.secret}` },
  }).then(r => r.json());
  if (!tj.ok) throw new Error(`__tables: ${tj.error}`);
  const planNames = new Set(plan.store.map(t => t.name));
  const unknown = tj.tables.filter(n => !knownDoTable(n, planNames));
  for (const n of unknown)
    console.log(
      `  UNMAPPED DO table ${n}: not in the plan, a CF-only rule or the runtime registry`
    );
  const r = compare(
    `store ${store.slug}`,
    [...tables.map(t => t.name), ...cfOnly.map(t => t.name)],
    src,
    j.tables,
    j.fk
  );
  r.aggCols = aggCols;
  r.cfOnly = cfOnly.length;
  r.total += unknown.length; // an unmapped table is a table that was not equal
  return r;
}

function compare(label, names, src, dst, fk) {
  let equal = 0;
  const bad = [];
  for (const n of names) {
    const a = src[n];
    const b = dst[n];
    if (a && b && a.count === b.count && a.digest === b.digest) equal++;
    else bad.push({ table: n, src: a, dst: b });
  }
  const fkBad = fk && fk.violations > 0;
  console.log(
    `${label}: ${equal}/${names.length} tables equal${fk ? `; foreign-key violations ${fk.violations}` : ''}`
  );
  for (const b of bad)
    console.log(
      `  MISMATCH ${b.table}: source ${b.src?.count} rows ${b.src?.digest?.slice(0, 12)} vs target ${b.dst?.count} rows ${b.dst?.digest?.slice(0, 12)}`
    );
  if (fkBad) console.log(`  FK sample ${JSON.stringify(fk.sample)}`);
  return { label, equal, total: names.length, bad, fk };
}

async function verifyPlatform(client, bound, plan) {
  const d = {
    db: args.d1,
    target: args['d1-target'],
    config: args['d1-config'],
    persistTo: args['persist-to'],
  };
  const src = {};
  const dst = {};
  const names = [];
  const tables = bound.platform.tables;
  // one wrangler call for every table, entity_index and the foreign-key check
  const results = await d1QueryMany(d, [
    ...tables.map(
      bt =>
        `SELECT ${bt.columns.map(c => `"${c.col}"`).join(', ')} FROM "${bt.name}" ORDER BY ${bt.pk.map(k => `"${k}"`).join(', ')}`
    ),
    'SELECT kind, id, store_id FROM entity_index ORDER BY kind, id',
    'PRAGMA foreign_key_check',
  ]);
  for (const [i, bt] of tables.entries()) {
    names.push(bt.name);
    src[bt.name] = await sourceDigest(client, bt, plan.platform, 'all');
    const dg = new TableDigest();
    const cn = bt.columns.map(c => c.col);
    for (const r of results[i])
      await dg.add(
        cn,
        cn.map(c => r[c]),
        bt.pk
      );
    dst[bt.name] = await dg.finish();
  }
  // entity_index is derived from the store tables (kind, id, store_id)
  names.push('entity_index');
  const sd = new TableDigest();
  for (const [kind, table] of Object.entries(ENTITY_KIND_TABLES)) {
    const r = await client.query(entityIndexQuery(kind, table, plan.store));
    for (const x of r.rows)
      await sd.add(['kind', 'id', 'store_id'], [x.kind, x.id, x.store_id], ['kind', 'id']);
  }
  src.entity_index = await sd.finish();
  const dd = new TableDigest();
  for (const x of results[tables.length])
    await dd.add(['kind', 'id', 'store_id'], [x.kind, x.id, x.store_id], ['kind', 'id']);
  dst.entity_index = await dd.finish();
  const fkRows = results[tables.length + 1];
  // Cloudflare-only D1 tables: one more query each, checked against their ruled row sets
  for (const t of plan.platform.filter(
    x => !x.inPg && CF_ONLY_TABLES[`d1:${x.name}`] && x.name !== 'entity_index'
  )) {
    const cn = t.columns.map(c => c.col);
    const [rows] = await d1QueryMany(d, [
      `SELECT ${cn.map(c => `"${c}"`).join(', ')} FROM "${t.name}" ORDER BY ${t.pk.map(k => `"${k}"`).join(', ')}`,
    ]);
    const dg = new TableDigest();
    for (const r of rows)
      await dg.add(
        cn,
        cn.map(c => r[c]),
        t.pk
      );
    names.push(t.name);
    dst[t.name] = await dg.finish();
    src[t.name] = await cfOnlyExpect('d1', t, dst[t.name]);
  }
  return compare('platform D1', names, src, dst, {
    violations: fkRows.length,
    sample: fkRows.slice(0, 5),
  });
}

async function main() {
  if (!args.all && !args.store && !args['platform-only'])
    throw new Error('pass --store <id|slug> or --all');
  if (!args['platform-only'] && !args.doUrl) throw new Error('pass --do-url (or CUTOVER_DO_URL)');
  if (!args['platform-only'] && !args.secret) throw new Error('set CUTOVER_IMPORT_SECRET');
  const t0 = performance.now();
  const plan = loadPlan();
  const client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
  const bound = await bindPlan(client, plan);
  const stores = args['platform-only']
    ? []
    : args.all
      ? (await client.query('SELECT id, slug FROM stores ORDER BY slug')).rows
      : [await resolveStore(client, args.store)];
  const results = [];
  for (const s of stores) results.push(await verifyDoStore(client, bound, plan, s));
  if (args.d1 && !args['skip-platform']) results.push(await verifyPlatform(client, bound, plan));
  else console.log('platform D1: not checked (pass --d1 <name>)');

  // tables in Postgres that no plan table reads must be empty or ruled
  const orphans = [];
  for (const n of await unmigratedTables(client, plan)) {
    const c = Number((await client.query(`SELECT count(*) AS n FROM "${n}"`)).rows[0].n);
    if (c > 0 && !RULED_UNMIGRATED_TABLES.has(n) && !plan.elsewhere.has(n))
      orphans.push({ table: n, rows: c });
  }
  if (orphans.length)
    console.log(`UNMIGRATED non-empty Postgres tables: ${JSON.stringify(orphans)}`);
  await client.query('ROLLBACK');
  await client.end();

  const equal = results.reduce((a, r) => a + r.equal, 0);
  const total = results.reduce((a, r) => a + r.total, 0);
  const ok =
    equal === total && results.every(r => !r.fk || r.fk.violations === 0) && orphans.length === 0;
  console.log(
    `${equal}/${total} tables equal across ${results.length} target(s) in ${fmtMs(performance.now() - t0)}: ${ok ? 'PASS' : 'FAIL'}`
  );
  if (args.report)
    fs.writeFileSync(
      args.report,
      JSON.stringify({ ok, at: new Date().toISOString(), equal, total, results }, null, 2)
    );
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error(`FAILED: ${e.message}`);
  process.exit(2);
});
