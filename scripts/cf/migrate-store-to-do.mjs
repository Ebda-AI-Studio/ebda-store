#!/usr/bin/env node
// Phase 4.1: copy one store (or all) from Postgres into its StoreDO.
//   node scripts/cf/migrate-store-to-do.mjs --store <id|slug> --do-url <base> [--dry-run]
//   node scripts/cf/migrate-store-to-do.mjs --all --do-url <base>
// Source: strictly READ ONLY (see lib/pg.mjs), one REPEATABLE READ snapshot per store, id-ordered
// server-side cursor, 1,000 rows per page. Sink: NDJSON pages POSTed to <do-url>/cutover/stores/<id>/__import,
// bearer CUTOVER_IMPORT_SECRET. Idempotent: pages are keyed (batch, table, page) and rows are upserted.
// Run scripts/cf/verify-store.mjs afterwards; this script never declares success by itself.
import fs from 'node:fs';
import { cli, fmtMs } from './lib/cli.mjs';
import { connectReadOnly, resolveStore } from './lib/pg.mjs';
import { loadPlan } from './lib/plan.mjs';
import { bindPlan, droppedColumnLoss, sourcePages } from './lib/source.mjs';
import { TableDigest } from '../../packages/cf-migrate/src/canon.mjs';

const { args } = cli({
  'dry-run': { type: 'boolean', default: false },
  'accept-dropped': { type: 'boolean', default: false },
});

async function post(storeId, head, rows) {
  const body = [JSON.stringify(head), ...rows.map(r => JSON.stringify(r))].join('\n') + '\n';
  const url = `${args.doUrl}/cutover/stores/${storeId}/__import`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${args.secret}`, 'content-type': 'application/x-ndjson' },
        body,
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) return j;
      if (res.status < 500 || attempt >= 3)
        throw new Error(`${head.table}#${head.page}: HTTP ${res.status} ${j.error ?? ''}`);
    } catch (e) {
      if (attempt >= 3 || /HTTP 4\d\d/.test(String(e.message))) throw e;
    }
    await new Promise(r => setTimeout(r, 250 * attempt)); // the same page again is safe: it is idempotent
  }
}

async function migrateStore(client, bound, plan, store) {
  const t0 = performance.now();
  const report = { store: store.slug, id: store.id, tables: [], dropped: [], unplaced: [] };

  const seen = new Set();
  for (const bt of bound.store.tables)
    for (const d of await droppedColumnLoss(client, bt, plan.store, 'store', store.id))
      if (!seen.has(`${d.table}.${d.column}`)) {
        seen.add(`${d.table}.${d.column}`);
        report.dropped.push(d);
      }
  const loss = report.dropped.filter(d => !d.ruled);
  if (loss.length && !args['accept-dropped'])
    throw new Error(
      `Postgres holds data in columns the Cloudflare schema drops: ${JSON.stringify(loss)}. Fix the schema or pass --accept-dropped after a ruling.`
    );

  for (const bt of [...bound.store.tables, ...bound.extra]) {
    const t1 = performance.now();
    const names = bt.columns.map(c => c.col);
    const digest = new TableDigest();
    let page = 0;
    let pages = 0;
    let skipped = 0;
    for await (const rows of sourcePages(
      client,
      bt,
      plan.store,
      'store',
      store.id,
      args.pageSize
    )) {
      for (const r of rows) await digest.add(names, r, bt.pk);
      if (!args['dry-run']) {
        const head = { batch: args.batch, table: bt.name, page, columns: names, pk: bt.pk };
        const res = await post(store.id, head, rows);
        if (res.skipped) skipped++;
      }
      page++;
      pages++;
    }
    const { count } = await digest.finish();
    const ms = performance.now() - t1;
    report.tables.push({ table: bt.name, rows: count, pages, skipped, ms: Math.round(ms) });
    if (count > 0)
      console.log(
        `  ${bt.name.padEnd(34)} ${String(count).padStart(7)} rows ${String(pages).padStart(3)} pages ${fmtMs(ms).padStart(8)}`
      );
  }
  report.ms = Math.round(performance.now() - t0);
  report.rows = report.tables.reduce((a, t) => a + t.rows, 0);
  report.pages = report.tables.reduce((a, t) => a + t.pages, 0);
  report.skippedPages = report.tables.reduce((a, t) => a + t.skipped, 0);
  report.cfOnlyTables = bound.store.cfOnly;
  return report;
}

async function main() {
  if (!args.all && !args.store) throw new Error('pass --store <id|slug> or --all');
  if (!args['dry-run']) {
    if (!args.doUrl) throw new Error('pass --do-url (or CUTOVER_DO_URL)');
    if (!args.secret || args.secret.length < 24)
      throw new Error('set CUTOVER_IMPORT_SECRET (>= 24 chars)');
  }
  args.batch ??= `cut-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
  const plan = loadPlan();
  const client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
  const bound = await bindPlan(client, plan);
  const stores = args.all
    ? (await client.query('SELECT id, slug FROM stores ORDER BY slug')).rows
    : [await resolveStore(client, args.store)];
  console.log(
    `batch ${args.batch}${args['dry-run'] ? ' (dry run: nothing is sent)' : ''}; ${stores.length} store(s); ${bound.store.tables.length} tables per store`
  );

  const reports = [];
  for (const s of stores) {
    console.log(`store ${s.slug} (${s.id})`);
    reports.push(await migrateStore(client, bound, plan, s));
    console.log(
      `  -> ${reports.at(-1).rows} rows, ${reports.at(-1).pages} pages (${reports.at(-1).skippedPages} already applied) in ${fmtMs(reports.at(-1).ms)}`
    );
  }
  await client.query('ROLLBACK');
  await client.end();
  const out = {
    batch: args.batch,
    dryRun: args['dry-run'],
    at: new Date().toISOString(),
    stores: reports,
  };
  if (args.report) fs.writeFileSync(args.report, JSON.stringify(out, null, 2));
  console.log(
    `done: ${reports.reduce((a, r) => a + r.rows, 0)} rows, ${fmtMs(reports.reduce((a, r) => a + r.ms, 0))}. Now run verify-store.mjs.`
  );
}

main().catch(e => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
