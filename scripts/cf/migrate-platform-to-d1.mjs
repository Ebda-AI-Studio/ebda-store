#!/usr/bin/env node
// Phase 4.2: copy the platform tables (the D1 ebda-platform database) from Postgres.
//   node scripts/cf/migrate-platform-to-d1.mjs --d1 ebda-platform --d1-target local|remote [--d1-config <wrangler.jsonc>] [--persist-to <dir>] [--dry-run]
// Identity (users, sessions, passkeys) already lives in D1 ebda-identity behind accounts.ebda.app and is NOT
// copied. Hashed secrets and tokens are copied byte for byte. entity_index (kind, id, store_id) is derived
// from the store tables. Analytics tables are not importable anywhere (Analytics Engine has no backfill):
// pass --archive-dir to keep them as NDJSON for the record. Upserts are idempotent, so a re-run is safe;
// the D1 schema must already be applied (wrangler d1 migrations apply).
import fs from 'node:fs';
import path from 'node:path';
import { cli, fmtMs } from './lib/cli.mjs';
import { connectReadOnly } from './lib/pg.mjs';
import {
  ENTITY_KIND_TABLES,
  USER_SCOPED,
  entityIndexQuery,
  loadPlan,
  userScopeWhere,
} from './lib/plan.mjs';
import { bindPlan, droppedColumnLoss, sourcePages } from './lib/source.mjs';
import { d1Query, d1Statements, lit } from './lib/d1.mjs';

const { args } = cli({
  d1: { type: 'string' },
  'd1-target': { type: 'string', default: 'local' },
  'd1-config': { type: 'string' },
  'persist-to': { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'archive-dir': { type: 'string' },
});
const d = {
  db: args.d1,
  target: args['d1-target'],
  config: args['d1-config'],
  persistTo: args['persist-to'],
};
const MAX_FILE_BYTES = 800_000;
const q = s => `"${s}"`;

const upsert = (table, columns, pk, row) => {
  const nonPk = columns.filter(c => !pk.includes(c));
  const conflict = nonPk.length
    ? `DO UPDATE SET ${nonPk.map(c => `${q(c)} = excluded.${q(c)}`).join(', ')}`
    : 'DO NOTHING';
  return `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${row.map(lit).join(', ')}) ON CONFLICT (${pk.map(q).join(', ')}) ${conflict};`;
};

async function flush(stmts) {
  if (!stmts.length || args['dry-run']) return;
  await d1Statements(d, stmts);
}

async function main() {
  if (!args.d1) throw new Error('pass --d1 <database name>');
  const t0 = performance.now();
  const plan = loadPlan();
  const client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
  const bound = await bindPlan(client, plan);

  if (!args['dry-run']) {
    const have = new Set(
      (await d1Query(d, `SELECT name FROM sqlite_master WHERE type = 'table'`)).map(r => r.name)
    );
    const missing = plan.platform.filter(t => !have.has(t.name)).map(t => t.name);
    if (missing.length)
      throw new Error(
        `D1 schema is not applied (missing ${missing.join(', ')}); run wrangler d1 migrations apply first`
      );
  }

  const report = { tables: [], dropped: [], unplaced: [], archived: [] };
  for (const bt of bound.platform.tables)
    for (const x of await droppedColumnLoss(client, bt, plan.platform, 'all'))
      report.dropped.push(x);
  const loss = report.dropped.filter(x => !x.ruled);
  if (loss.length)
    throw new Error(
      `Postgres holds data in columns the platform schema drops: ${JSON.stringify(loss)}`
    );

  let stmts = [];
  let bytes = 0;
  const push = async s => {
    stmts.push(s);
    bytes += s.length;
    if (bytes >= MAX_FILE_BYTES) {
      await flush(stmts);
      stmts = [];
      bytes = 0;
    }
  };
  for (const bt of bound.platform.tables) {
    const t1 = performance.now();
    const names = bt.columns.map(c => c.col);
    let rows = 0;
    for await (const page of sourcePages(client, bt, plan.platform, 'all', null, args.pageSize))
      for (const r of page) {
        await push(upsert(bt.name, names, bt.pk, r));
        rows++;
      }
    report.tables.push({ table: bt.name, rows, ms: Math.round(performance.now() - t1) });
    if (rows)
      console.log(
        `  ${bt.name.padEnd(34)} ${String(rows).padStart(7)} rows ${fmtMs(performance.now() - t1).padStart(8)}`
      );
  }

  // entity_index: derived from the store tables
  const t2 = performance.now();
  let ei = 0;
  for (const [kind, table] of Object.entries(ENTITY_KIND_TABLES)) {
    const r = await client.query(entityIndexQuery(kind, table, plan.store));
    for (const x of r.rows) {
      if (!x.store_id) throw new Error(`entity_index: ${kind} ${x.id} has no store`);
      await push(
        upsert(
          'entity_index',
          ['kind', 'id', 'store_id'],
          ['kind', 'id'],
          [x.kind, x.id, x.store_id]
        )
      );
      ei++;
    }
  }
  // InstaPay reference claims (Ruling INSTAPAY-DO-1): every receipt that holds a reference seeds its D1 claim, bound to the
  // receipt, so a store flipped to the Durable Object cannot file a reference a Postgres receipt already holds.
  {
    const r = await client.query(
      `SELECT reference_key AS id, store_id, id AS claim_ref FROM instapay_receipts WHERE reference_key IS NOT NULL`
    );
    for (const x of r.rows) {
      await push(
        upsert(
          'entity_index',
          ['kind', 'id', 'store_id', 'claim_ref'],
          ['kind', 'id'],
          ['instapay_ref', x.id, x.store_id, x.claim_ref]
        )
      );
      ei++;
    }
  }
  await flush(stmts); // one wrangler call for everything below the size cap (a call costs ~1 s)
  report.tables.push({ table: 'entity_index', rows: ei, ms: Math.round(performance.now() - t2) });
  console.log(
    `  ${'entity_index'.padEnd(34)} ${String(ei).padStart(7)} rows ${fmtMs(performance.now() - t2).padStart(8)}`
  );

  // user-owned rows that no store claims cannot be placed in any StoreDO: list them for the controller
  for (const [table, col] of Object.entries(USER_SCOPED)) {
    const r = await client.query(
      `SELECT count(*) AS n FROM "${table}" t WHERE NOT EXISTS (SELECT 1 FROM stores s WHERE ${userScopeWhere('t', col).replaceAll('$1', 's.id')})`
    );
    const n = Number(r.rows[0].n);
    if (n) report.unplaced.push({ table, rows: n });
  }
  if (report.unplaced.length)
    console.log(
      `UNPLACED (user matches no store as customer, staff or owner; not migrated): ${JSON.stringify(report.unplaced)}`
    );

  if (args['archive-dir']) {
    fs.mkdirSync(args['archive-dir'], { recursive: true });
    for (const [table, target] of plan.elsewhere) {
      if (target !== 'analytics') continue;
      const r = await client.query(`SELECT row_to_json(t)::text AS j FROM "${table}" t`);
      if (!r.rows.length) continue;
      fs.writeFileSync(
        path.join(args['archive-dir'], `${table}.ndjson`),
        r.rows.map(x => x.j).join('\n') + '\n'
      );
      report.archived.push({ table, rows: r.rows.length });
    }
    console.log(`archived analytics tables: ${JSON.stringify(report.archived)}`);
  }
  await client.query('ROLLBACK');
  await client.end();
  report.ms = Math.round(performance.now() - t0);
  if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
  console.log(
    `done: ${report.tables.reduce((a, t) => a + t.rows, 0)} rows in ${fmtMs(report.ms)}${args['dry-run'] ? ' (dry run: nothing written)' : ''}. Now run verify-store.mjs --d1 ${args.d1}.`
  );
}

main().catch(e => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
