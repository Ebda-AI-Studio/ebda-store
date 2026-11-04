#!/usr/bin/env node
// NEON-ZERO-1 N-10: move one platform table FAMILY from Postgres to D1 and flip its cutover switch.
//   node scripts/cf/cutover-platform-family.mjs --family billing --d1 ebda-platform --d1-target remote \
//        --d1-config apps/api/wrangler.jsonc --pg-url "$CUTOVER_PG_URL" [--allow-prod-read]            # DRY RUN (default)
//   ... same flags + --commit                                                                         # copy, verify, flip
//   ... same flags + --status                                                                         # marker + counts, no PG
//   ... same flags + --delete-marker                                                                  # un-flip (before traffic)
//
// What it does (ONLY the controller runs it; this repo never holds prod credentials):
//   1. dry run: per table, Postgres rows vs D1 rows, the foreign-key pre-check (every store a family row names exists in
//      D1 `stores`), and whether the marker exists. Writes nothing.
//   2. --commit: refuses when the marker already exists (after the flip D1 is the truth; a re-copy would overwrite it).
//      Upserts every family table in foreign-key order (idempotent, so an interrupted run is simply re-run), then
//      verifies row count + a digest of every migrated column on BOTH sides (the same TableDigest the store cutover uses)
//      and `PRAGMA foreign_key_check`. ONLY if every table is equal does it insert `system_settings.platform_cutover.<family>`.
//      The API reads that row (apps/api/src/services/platform/cutover.ts): before it, Postgres; after it, D1 only.
//   3. after the flip it re-digests Postgres: a difference means a Postgres write landed between verify and flip (the window
//      is the isolate cache, 10 s); the script prints the tables and exits 2 so the row can be re-applied by hand.
// Postgres is opened READ ONLY (lib/pg.mjs refuses a prod URL without --allow-prod-read) and rolled back.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cli, fmtMs } from './lib/cli.mjs';
import { connectReadOnly } from './lib/pg.mjs';
import { loadPlan } from './lib/plan.mjs';
import { bindPlan, droppedColumnLoss, sourceDigest, sourcePages } from './lib/source.mjs';
import { d1Query, d1QueryMany, d1Statements, lit } from './lib/d1.mjs';
import { TableDigest } from '../../packages/cf-migrate/src/canon.mjs';

/** family -> D1 table names. Keep in step with apps/api/src/services/platform/cutover.ts FAMILY_MODELS. */
export const FAMILIES = {
  billing: [
    'plans',
    'store_subscriptions',
    'billing_events',
    'billing_grants',
    'billing_referrals',
    'billing_reminders',
    'billing_webhook_events',
    'store_lifecycle_emails',
  ],
  // N-6/N-7: store membership (the access gate, staff, staff invites). Keep in step with FAMILY_MODELS.access.
  access: ['store_staff', 'staff_invites'],
};

/**
 * Extra pre-flip checks per family (SELECT-only, both sides). `access`: the gate decides on D1 `stores` (owner, status,
 * billing suspension, deleted) once the marker exists, so a store whose directory row differs from Postgres would be decided
 * on stale facts the moment we flip. The directory mirror is dual-written; this proves it before the switch.
 */
const STORE_FACTS_SQL_PG =
  "SELECT id, owner_id, status, billing_suspended_reason, deleted_at IS NOT NULL AS deleted FROM stores WHERE storage_backend <> 'do'";
async function storeFactMismatches(client, d) {
  const fact = r =>
    `${r.owner_id}|${r.status}|${r.billing_suspended_reason ?? ''}|${r.deleted ? 1 : 0}`;
  const pg = new Map((await client.query(STORE_FACTS_SQL_PG)).rows.map(r => [r.id, fact(r)]));
  const d1 = new Map(
    (
      await d1Query(
        d,
        'SELECT id, owner_id, status, billing_suspended_reason, deleted_at IS NOT NULL AS deleted, storage_backend FROM stores'
      )
    ).map(r => [r.id, { v: fact(r), backend: r.storage_backend }])
  );
  const bad = [];
  for (const [id, v] of pg) {
    const row = d1.get(id);
    // Stores D1 owns (`do`) are skipped: their Postgres row is sealed and stale by design. A PG store missing from D1
    // would be a 404 at the gate, so it counts as drift.
    if (!row) bad.push(id);
    else if (row.backend !== 'do' && row.v !== v) bad.push(id);
  }
  return bad;
}

const freezeKey = family => `platform_freeze.${family}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const markerKey = family => `platform_cutover.${family}`;
const q = s => `"${s}"`;
const MAX_FILE_BYTES = 800_000;

const upsert = (table, columns, pk, row) => {
  const nonPk = columns.filter(c => !pk.includes(c));
  const conflict = nonPk.length
    ? `DO UPDATE SET ${nonPk.map(c => `${q(c)} = excluded.${q(c)}`).join(', ')}`
    : 'DO NOTHING';
  return `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${row.map(lit).join(', ')}) ON CONFLICT (${pk.map(q).join(', ')}) ${conflict};`;
};

async function main() {
  const { args } = cli({
    family: { type: 'string' },
    d1: { type: 'string' },
    'd1-target': { type: 'string', default: 'local' },
    'd1-config': { type: 'string' },
    'persist-to': { type: 'string' },
    // The API caches the freeze marker for 5 s and the cutover marker for 10 s per isolate: wait longer than both.
    'freeze-wait-ms': { type: 'string', default: '20000' },
    commit: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    'delete-marker': { type: 'boolean', default: false },
    unfreeze: { type: 'boolean', default: false },
  });
  const tables = FAMILIES[args.family];
  if (!tables) throw new Error(`pass --family <${Object.keys(FAMILIES).join('|')}>`);
  if (!args.d1) throw new Error('pass --d1 <database name>');
  const d = {
    db: args.d1,
    target: args['d1-target'],
    config: args['d1-config'],
    persistTo: args['persist-to'],
  };
  const key = markerKey(args.family);
  const marker = async () =>
    (
      await d1Query(d, `SELECT id, value, created_at FROM system_settings WHERE key = ${lit(key)}`)
    )[0];

  if (args.unfreeze) {
    await d1Statements(d, [
      `DELETE FROM system_settings WHERE key = ${lit(freezeKey(args.family))};`,
    ]);
    console.log(`freeze ${freezeKey(args.family)} removed`);
    return;
  }
  if (args['delete-marker']) {
    await d1Statements(d, [`DELETE FROM system_settings WHERE key = ${lit(key)};`]);
    console.log(
      `marker ${key} deleted. Isolates that already saw it keep serving D1 until they recycle: use this only before traffic.`
    );
    return;
  }

  const have = await marker();
  if (args.status) {
    const counts = await d1QueryMany(
      d,
      tables.map(t => `SELECT count(*) AS n FROM ${q(t)}`)
    );
    console.log(`marker: ${have ? `PRESENT ${have.value} (${have.created_at})` : 'absent'}`);
    tables.forEach((t, i) => console.log(`  ${t.padEnd(28)} D1 ${counts[i][0].n}`));
    return;
  }
  if (args.commit && have)
    throw new Error(
      `marker ${key} already exists: D1 is the source of truth for ${args.family}; refusing to overwrite it from Postgres`
    );

  const t0 = performance.now();
  const plan = loadPlan();
  let client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
  const bound = await bindPlan(client, plan);
  const fam = bound.platform.tables.filter(bt => tables.includes(bt.name)); // already FK-ordered
  const missing = tables.filter(t => !fam.some(bt => bt.name === t));
  if (missing.length) throw new Error(`not in the platform plan: ${missing.join(', ')}`);

  const loss = [];
  for (const bt of fam)
    for (const x of await droppedColumnLoss(client, bt, plan.platform, 'all'))
      if (!x.ruled) loss.push(x);
  if (loss.length)
    throw new Error(`Postgres holds data in columns D1 drops: ${JSON.stringify(loss)}`);

  const dSchema = new Set(
    (await d1Query(d, `SELECT name FROM sqlite_master WHERE type = 'table'`)).map(r => r.name)
  );
  const noTable = tables.filter(t => !dSchema.has(t));
  if (noTable.length) throw new Error(`D1 schema is not applied (missing ${noTable.join(', ')})`);

  // 1. report + FK pre-check
  const pgCounts = {};
  for (const bt of fam)
    pgCounts[bt.name] = Number(
      (await client.query(`SELECT count(*) AS n FROM "${bt.origin}"`)).rows[0].n
    );
  const d1Counts = await d1QueryMany(
    d,
    tables.map(t => `SELECT count(*) AS n FROM ${q(t)}`)
  );
  console.log(`family ${args.family}  marker: ${have ? 'PRESENT' : 'absent'}`);
  fam.forEach((bt, i) =>
    console.log(
      `  ${bt.name.padEnd(28)} PG ${String(pgCounts[bt.name]).padStart(7)}   D1 ${String(d1Counts[i][0].n).padStart(7)}`
    )
  );
  const storeCols = fam
    .map(bt => ({ bt, col: bt.columns.find(c => ['store_id', 'beneficiary_id'].includes(c.col)) }))
    .filter(x => x.col);
  const d1Stores = new Set((await d1Query(d, 'SELECT id FROM stores')).map(r => r.id));
  const orphans = [];
  for (const { bt, col } of storeCols) {
    const r = await client.query(
      `SELECT DISTINCT "${col.src}" AS id FROM "${bt.origin}" WHERE "${col.src}" IS NOT NULL`
    );
    const gone = r.rows.map(x => x.id).filter(id => !d1Stores.has(id));
    if (gone.length)
      orphans.push({
        table: bt.name,
        column: col.col,
        stores: gone.slice(0, 10),
        count: gone.length,
      });
  }
  if (orphans.length) {
    console.log(
      `FK PRE-CHECK FAILED: family rows name stores that are not in D1 stores:\n${JSON.stringify(orphans, null, 1)}`
    );
    throw new Error(
      'stores must be in D1 first (run the directory reconcile / migrate-platform-to-d1 for stores)'
    );
  }
  if (args.family === 'access') {
    const drift = await storeFactMismatches(client, d);
    if (drift.length) {
      console.log(
        `STORE DIRECTORY DRIFT (owner/status/suspension/deleted): ${drift.slice(0, 10).join(', ')} (${drift.length})`
      );
      throw new Error('D1 stores differ from Postgres: run the directory reconcile, then re-run');
    }
    console.log('  store directory facts equal on both sides');
  }
  if (!args.commit) {
    await client.query('ROLLBACK');
    await client.end();
    console.log(
      `dry run: nothing written (${fmtMs(performance.now() - t0)}). Add --commit to copy, verify and flip.`
    );
    return;
  }

  // 1b. FREEZE writes to the family (retryable 503 from the API), wait out the isolate caches, and only THEN take the snapshot
  // we copy from: one REPEATABLE READ snapshot taken earlier would hide writes made during the copy (lost silently).
  const freezeWait = Number(args['freeze-wait-ms']);
  const setFreeze = on =>
    d1Statements(d, [
      on
        ? `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(freezeKey(args.family))}, ${lit(new Date().toISOString())}, 'cutover', 0) ON CONFLICT (key) DO NOTHING;`
        : `DELETE FROM system_settings WHERE key = ${lit(freezeKey(args.family))};`,
    ]);
  await client.query('ROLLBACK');
  await client.end();
  await setFreeze(true);
  console.log(
    `FROZEN ${args.family}: writes get 503 PLATFORM_FAMILY_FROZEN; waiting ${freezeWait} ms for isolates`
  );
  let flipped = false;
  try {
    await sleep(freezeWait);
    client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    if (args.family === 'access') {
      const drift = await storeFactMismatches(client, d);
      if (drift.length)
        throw new Error(`store directory drift after the freeze: ${drift.slice(0, 5).join(', ')}`);
    }

    // 2. copy (idempotent upserts, FK order)
    let stmts = [];
    let bytes = 0;
    const flush = async () => {
      if (stmts.length) await d1Statements(d, stmts);
      stmts = [];
      bytes = 0;
    };
    const before = {};
    for (const bt of fam) {
      before[bt.name] = await sourceDigest(client, bt, plan.platform, 'all');
      const names = bt.columns.map(c => c.col);
      for await (const page of sourcePages(client, bt, plan.platform, 'all', null, args.pageSize))
        for (const r of page) {
          const s = upsert(bt.name, names, bt.pk, r);
          stmts.push(s);
          bytes += s.length;
          if (bytes >= MAX_FILE_BYTES) await flush();
        }
      await flush();
      console.log(`  copied ${bt.name} (${before[bt.name].count} rows)`);
    }

    // 3. verify: count + digest on both sides, foreign keys
    const results = await d1QueryMany(d, [
      ...fam.map(
        bt =>
          `SELECT ${bt.columns.map(c => q(c.col)).join(', ')} FROM ${q(bt.name)} ORDER BY ${bt.pk.map(q).join(', ')}`
      ),
      'PRAGMA foreign_key_check',
    ]);
    const bad = [];
    for (const [i, bt] of fam.entries()) {
      const dg = new TableDigest();
      const cn = bt.columns.map(c => c.col);
      for (const r of results[i])
        await dg.add(
          cn,
          cn.map(c => r[c]),
          bt.pk
        );
      const dst = await dg.finish();
      const src = await sourceDigest(client, bt, plan.platform, 'all');
      const ok = src.count === dst.count && src.digest === dst.digest;
      console.log(
        `  verify ${bt.name.padEnd(28)} ${ok ? 'EQUAL' : 'MISMATCH'}  src ${src.count} ${src.digest.slice(0, 12)}  d1 ${dst.count} ${dst.digest.slice(0, 12)}`
      );
      if (!ok) bad.push(bt.name);
    }
    const fkRows = results.at(-1);
    if (fkRows.length) bad.push(`foreign_key_check:${JSON.stringify(fkRows.slice(0, 5))}`);
    if (bad.length) {
      await client.query('ROLLBACK');
      await client.end();
      throw new Error(
        `verification failed (${bad.join(', ')}); the switch was NOT flipped. Re-run (a write may have landed in Postgres mid-copy).`
      );
    }

    // 4. flip
    const value = JSON.stringify({
      family: args.family,
      copiedAt: new Date().toISOString(),
      tables: Object.fromEntries(fam.map(bt => [bt.name, before[bt.name]])),
    });
    await d1Statements(d, [
      `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(key)}, ${lit(value)}, 'cutover', 0) ON CONFLICT (key) DO NOTHING;`,
    ]);
    if (!(await marker())) throw new Error('marker was not written');
    flipped = true;
    console.log(
      `FLIPPED: ${key} written. The API serves ${args.family} from D1 within 10 s per isolate; the freeze stays until then.`
    );

    // 5. wait out the isolate caches, then verify on a NEW connection (a fresh snapshot sees every Postgres write that landed
    // in the window) and re-digest D1; only then lift the freeze.
    await client.query('ROLLBACK');
    await client.end();
    await sleep(freezeWait);
    client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    const drift = [];
    for (const bt of fam) {
      const now = await sourceDigest(client, bt, plan.platform, 'all');
      if (now.count !== before[bt.name].count || now.digest !== before[bt.name].digest)
        drift.push(bt.name);
    }
    await client.query('ROLLBACK');
    await client.end();
    await setFreeze(false);
    console.log(`UNFROZEN ${args.family}`);
    if (drift.length) {
      console.log(
        `DRIFT: Postgres changed after the copy in ${drift.join(', ')} (writes during the 10 s flip window). Re-apply those rows by hand; list them with a PG query on updated_at.`
      );
      process.exit(2);
    }
    console.log(
      `done in ${fmtMs(performance.now() - t0)}; Postgres digests unchanged since the copy (verified on a new connection).`
    );
  } catch (e) {
    // Before the flip a failure is safe to retry: lift the freeze. After the flip the freeze is lifted by step 5; if the
    // script died between, the freeze is harmless (the marker wins) and `--unfreeze` removes it.
    if (!flipped) {
      await setFreeze(false).catch(() => {});
      console.log(`UNFROZEN ${args.family} (copy aborted before the flip)`);
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  });
