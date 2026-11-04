#!/usr/bin/env node
// NEON-ZERO-1 Ruling NZ-AN-1: copy the per-store analytics rows of every Durable Object store from Postgres into that
// store's own StoreDO, then flip the D1 marker `platform_cutover.analytics` that makes the API serve them from the DO.
//   node scripts/cf/copy-analytics-to-do.mjs --d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc \
//        --do-url https://api.ebda.app --pg-url "$CUTOVER_PG_URL" --allow-prod-read           # DRY RUN (default)
//   ... same flags + --commit                                                                 # freeze, copy, verify, flip
//   ... same flags + --status | --unfreeze | --delete-marker
// Env: CUTOVER_IMPORT_SECRET (bearer for <do-url>/cutover/stores/<id>/__analytics), CUTOVER_PG_URL.
//
// Tables (all analytics, one store each): search_query_daily, product_daily_views, qr_scan_daily, notification_logs,
// gsc_daily_metrics. Stores: every D1 `stores` row with storage_backend = 'do' (or --store <id>).
//
// Why this is exact: until the marker exists the API keeps writing these tables to POSTGRES for every store (analyticsOnDo),
// and a DO analytics table therefore only ever receives rows from this script. --commit FIRST freezes the family
// (system_settings platform_freeze.analytics: a DO store's analytics WRITE answers a retryable 503, which the fail-open
// counters swallow and the notification/GSC writers retry), waits --drain-ms so in-flight writes finish, only THEN opens the
// Postgres snapshot, copies in fixed-size id-ordered batches (batch id = store:table:n, so a re-run is a no-op for batches
// already applied: the DO ledger `_analytics_import`), and asks each DO to FINISH: the DO compares its own row counts and
// SUMs with what Postgres held and writes its done-marker only on an exact match (after which it refuses every batch).
// ONLY if every store finished does the script insert the D1 marker, wait --settle-ms, lift the freeze and re-count Postgres on
// a NEW connection: a difference means a write still reached Postgres (exit 2, the list is printed).
// It refuses when the marker already exists, and a DO that already holds analytics rows it did not import.
process.env.TZ = 'UTC';
import crypto from 'node:crypto';
import { cli, fmtMs } from './lib/cli.mjs';
import { connectReadOnly } from './lib/pg.mjs';
import { loadPlan } from './lib/plan.mjs';
import { bindPlan, sourcePages } from './lib/source.mjs';
import { d1Query, d1Statements, lit } from './lib/d1.mjs';

export const TABLES = [
  'search_query_daily',
  'product_daily_views',
  'qr_scan_daily',
  'notification_logs',
  'gsc_daily_metrics',
];
/** the columns whose SUM the DO verifies (keep in step with packages/repo/src/do/analytics-ops.ts ANALYTICS_TABLES) */
export const SUMS = {
  search_query_daily: ['searches', 'zero_results', 'last_result_count'],
  product_daily_views: ['count'],
  qr_scan_daily: ['count'],
  notification_logs: ['created_at'],
  gsc_daily_metrics: ['impressions', 'clicks'],
};
const BATCH = 400;
const MARKER = 'platform_cutover.analytics';
const FREEZE = 'platform_freeze.analytics';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let args;

async function call(storeId, op, a) {
  const url = `${args.doUrl}/cutover/stores/${storeId}/__analytics`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${args.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ op, args: a }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) return JSON.parse(j.json);
      if (res.status < 500 || attempt >= 3)
        throw new Error(`${op} ${storeId}: HTTP ${res.status} ${j.code ?? ''} ${j.message ?? ''}`);
    } catch (e) {
      if (attempt >= 3 || /HTTP 4\d\d/.test(String(e.message))) throw e;
    }
    await sleep(250 * attempt); // the same batch again is safe: the ledger makes it a no-op
  }
}

async function main() {
  ({ args } = cli({
    d1: { type: 'string' },
    'd1-target': { type: 'string', default: 'local' },
    'd1-config': { type: 'string' },
    'persist-to': { type: 'string' },
    commit: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    unfreeze: { type: 'boolean', default: false },
    'delete-marker': { type: 'boolean', default: false },
    'drain-ms': { type: 'string', default: '45000' },
    'settle-ms': { type: 'string', default: '12000' },
  }));
  if (!args.d1) throw new Error('pass --d1 <database name>');
  const d = {
    db: args.d1,
    target: args['d1-target'],
    config: args['d1-config'],
    persistTo: args['persist-to'],
  };
  const marker = async () =>
    (await d1Query(d, `SELECT created_at FROM system_settings WHERE key = ${lit(MARKER)}`))[0];
  const setFreeze = () =>
    d1Statements(d, [
      `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(FREEZE)}, '{}', 'cutover', 0) ON CONFLICT (key) DO NOTHING;`,
    ]);
  const liftFreeze = () =>
    d1Statements(d, [`DELETE FROM system_settings WHERE key = ${lit(FREEZE)};`]);

  if (args.unfreeze) {
    await liftFreeze();
    return console.log(`freeze ${FREEZE} lifted.`);
  }
  if (args['delete-marker']) {
    await d1Statements(d, [`DELETE FROM system_settings WHERE key = ${lit(MARKER)};`]);
    return console.log(
      `marker ${MARKER} deleted. Isolates that saw it keep serving the DO until they recycle: use this only before traffic.`
    );
  }

  const storeRows = await d1Query(
    d,
    `SELECT id, slug FROM stores WHERE storage_backend = 'do' AND deleted_at IS NULL ORDER BY id`
  );
  const stores = args.store
    ? storeRows.filter(s => s.id === args.store || s.slug === args.store)
    : storeRows;
  if (args.store && stores.length !== 1)
    throw new Error(`--store ${args.store} is not a live DO store`);
  const have = await marker();
  if (args.status) {
    console.log(`marker: ${have ? `PRESENT (${have.created_at})` : 'absent'}`);
    for (const s of stores) {
      const st = await call(s.id, 'analyticsImportStatus', {});
      console.log(
        `  ${s.slug.padEnd(28)} done=${st.done} batches=${st.batches} ${TABLES.map(t => `${t}=${st.tables[t].rows}`).join(' ')}`
      );
    }
    return;
  }
  if (args.commit && have)
    throw new Error(
      `marker ${MARKER} already exists: the DO is the source of truth; refusing to copy over it`
    );
  if (!args.doUrl || !args.secret) throw new Error('set --do-url and CUTOVER_IMPORT_SECRET');

  const t0 = performance.now();
  const plan = loadPlan();
  const open = async () => {
    const client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    const bound = await bindPlan(client, plan);
    const bts = TABLES.map(t => {
      const bt = bound.store.tables.find(x => x.name === t);
      if (!bt) throw new Error(`plan has no table ${t} (regenerate cf-schema)`);
      return bt;
    });
    return { client, bts };
  };

  // Postgres expectations for one store, read through the SAME transform the rows are sent with
  const readStore = async (client, bts, storeId, send) => {
    const exp = {};
    for (const bt of bts) {
      const names = bt.columns.map(c => c.col);
      const e = (exp[bt.name] = {
        rows: 0,
        sums: Object.fromEntries(SUMS[bt.name].map(c => [c, 0])),
      });
      let n = 0;
      let pending = [];
      const flush = async () => {
        if (!pending.length) return;
        if (send) await send(bt.name, n++, pending);
        pending = [];
      };
      for await (const page of sourcePages(client, bt, plan.store, 'store', storeId, 2000))
        for (const row of page) {
          const obj = Object.fromEntries(names.map((c, i) => [c, row[i]]));
          if ('date' in obj && obj.date % 86_400_000 !== 0)
            throw new Error(`${bt.name} ${obj.id}: date ${obj.date} is not a UTC midnight (TZ?)`);
          e.rows += 1;
          for (const c of SUMS[bt.name]) e.sums[c] += Number(obj[c] ?? 0);
          pending.push(obj);
          if (pending.length >= BATCH) await flush();
        }
      await flush();
    }
    return exp;
  };

  // 1. dry run (also the first half of --commit; closed before the freeze)
  console.log(`${stores.length} Durable Object store(s); marker ${have ? 'PRESENT' : 'absent'}`);
  {
    const { client, bts } = await open();
    try {
      for (const s of stores) {
        const exp = await readStore(client, bts, s.id, null);
        const st = await call(s.id, 'analyticsImportStatus', {});
        const native = TABLES.filter(t => st.tables[t].rows > 0 && st.batches === 0);
        console.log(
          `  ${s.slug.padEnd(28)} PG ${TABLES.map(t => `${t}=${exp[t].rows}`).join(' ')} | DO done=${st.done}${native.length ? ` NATIVE ROWS in ${native.join(',')} (would refuse)` : ''}`
        );
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }
  if (!args.commit)
    return console.log(`dry run only (${fmtMs(performance.now() - t0)}); pass --commit to copy`);

  // 2. freeze, drain, copy, finish
  await setFreeze();
  console.log(`froze ${FREEZE}; draining ${args['drain-ms']} ms`);
  await sleep(Number(args['drain-ms']));
  const expectations = new Map();
  try {
    const { client, bts } = await open();
    try {
      for (const s of stores) {
        const st = await call(s.id, 'analyticsImportStatus', {});
        const exp = await readStore(client, bts, s.id, async (table, n, rows) => {
          if (!st.done)
            await call(s.id, 'analyticsImport', { batchId: `${s.id}:${table}:${n}`, table, rows });
        });
        expectations.set(s.id, exp);
        if (!st.done) await call(s.id, 'analyticsImportFinish', { expect: exp });
        console.log(
          `  ${s.slug}: finished ${TABLES.map(t => `${t}=${exp[t].rows}`).join(' ')}${st.done ? ' (was already done)' : ''}`
        );
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  } catch (e) {
    console.error(
      `copy failed: ${e.message}\nThe marker is NOT set; the freeze is lifted. Re-run to resume (applied batches are skipped).`
    );
    await liftFreeze();
    process.exit(1);
  }

  // 3. flip, settle, thaw
  await d1Statements(d, [
    `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(MARKER)}, '{}', 'cutover', 0) ON CONFLICT (key) DO NOTHING;`,
  ]);
  console.log(`marker ${MARKER} set; settling ${args['settle-ms']} ms`);
  await sleep(Number(args['settle-ms']));
  await liftFreeze();

  // 4. NEW connection: Postgres must not have changed for any copied store
  const { client, bts } = await open();
  const drift = [];
  try {
    for (const s of stores) {
      const now = await readStore(client, bts, s.id, null);
      for (const t of TABLES) {
        const a = expectations.get(s.id)[t];
        if (a.rows !== now[t].rows || JSON.stringify(a.sums) !== JSON.stringify(now[t].sums))
          drift.push(`${s.slug}.${t}: copied ${a.rows} rows, Postgres now ${now[t].rows}`);
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
  if (drift.length) {
    console.error(
      `WRITES REACHED POSTGRES AFTER THE SNAPSHOT:\n- ${drift.join('\n- ')}\nRe-apply those rows in the DO by hand.`
    );
    process.exit(2);
  }
  console.log(
    `done in ${fmtMs(performance.now() - t0)}: ${stores.length} store(s), marker set, Postgres unchanged.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch(e => (console.error(e.message), process.exit(1)));
