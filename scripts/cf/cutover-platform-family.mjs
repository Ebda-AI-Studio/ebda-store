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
//   2. --commit FIRST FREEZES the family (system_settings platform_freeze.<family>: every write to it is refused with a
//      retryable 503 by the API), waits --drain-ms (default 45 s, longer than a Postgres transaction may live) so in-flight
//      writes finish, and ONLY THEN opens the Postgres snapshot. Without the freeze a write between the snapshot and the
//      flip is silently lost. It refuses when the marker already exists (after the flip D1 is the truth; a re-copy would overwrite it).
//      Upserts every family table in foreign-key order (idempotent, so an interrupted run is simply re-run), then
//      verifies row count + a digest of every migrated column on BOTH sides (the same TableDigest the store cutover uses)
//      and `PRAGMA foreign_key_check`. ONLY if every table is equal does it insert `system_settings.platform_cutover.<family>`.
//      The API reads that row (apps/api/src/services/platform/cutover.ts): before it, Postgres; after it, D1 only.
//   3. after the flip it waits --settle-ms (12 s: every isolate has seen the marker, and a write refuses to go to Postgres
//      anyway), lifts the freeze, then re-digests Postgres on a NEW connection/snapshot: a difference means a write still
//      slipped into Postgres; the script prints the tables and exits 2 so the row can be re-applied by hand.
// Postgres is opened READ ONLY (lib/pg.mjs refuses a prod URL without --allow-prod-read) and rolled back.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cli, fmtMs } from './lib/cli.mjs';
import pg from 'pg';
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
  // N-10b. system_settings holds the cutover / freeze bookkeeping rows too; they are excluded from the digest.
  platform: [
    'system_settings',
    'store_features',
    'legal_acceptances',
    'legal_notice_sends',
    'legal_notice_deliveries',
    'provider_verifications',
    'provider_verification_events',
    'provider_activation_requests',
    'merchant_api_keys',
    'SlugRedirect',
  ],
  // The payment-webhook inbox. A provider callback is never refused: during the freeze it is recorded straight into D1.
  inbox: ['webhook_events'],
};

/** Families whose Postgres rows are EMPTIED after the flip (fail closed: Postgres policies/definers that still read them deny). */
const EMPTY_PG_AFTER_FLIP = new Set(['access']);

const STORE_FACTS_SQL_PG =
  'SELECT id, owner_id, status, billing_suspended_reason, deleted_at IS NOT NULL AS deleted FROM stores';
/**
 * `access` pre-flip check: the gate decides on D1 `stores` (owner, status, suspension, deleted) once the marker exists, so
 * every PG-backed store must carry the same facts there. The `storage_backend` column exists ONLY in D1: a store D1 owns
 * (`do`) is skipped (its Postgres row is sealed and stale by design); a Postgres store missing from D1 is drift (404 at the gate).
 */
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
    if (!row) bad.push(id);
    else if (row.backend !== 'do' && row.v !== v) bad.push(id);
  }
  return bad;
}

const markerKey = family => `platform_cutover.${family}`;
const freezeKey = family => `platform_freeze.${family}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
    commit: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    'delete-marker': { type: 'boolean', default: false },
    unfreeze: { type: 'boolean', default: false },
    'drain-ms': { type: 'string', default: '45000' },
    'settle-ms': { type: 'string', default: '12000' },
    // `access` only: a WRITE connection used once, after the flip, to empty the migrated Postgres rows.
    'pg-write-url': { type: 'string' },
    'allow-prod-write': { type: 'boolean', default: false },
    // a freeze carries its own expiry: if this script dies without lifting it the API ignores it after this long and pages
    'freeze-ttl-ms': { type: 'string', default: '900000' },
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
  const fkey = freezeKey(args.family);
  const marker = async () =>
    (
      await d1Query(d, `SELECT id, value, created_at FROM system_settings WHERE key = ${lit(key)}`)
    )[0];
  const setFreeze = () =>
    d1Statements(d, [
      `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(fkey)}, ${lit(JSON.stringify({ expiresAt: Date.now() + Number(args['freeze-ttl-ms']), by: 'cutover-platform-family' }))}, 'cutover', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
    ]);
  const liftFreeze = () =>
    d1Statements(d, [`DELETE FROM system_settings WHERE key = ${lit(fkey)};`]);

  if (args.unfreeze) {
    await liftFreeze();
    console.log(`freeze ${fkey} lifted.`);
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
    const fr = await d1Query(d, `SELECT 1 AS n FROM system_settings WHERE key = ${lit(fkey)}`);
    console.log(
      `marker: ${have ? `PRESENT ${have.value} (${have.created_at})` : 'absent'}   freeze: ${fr.length ? 'ON' : 'off'}`
    );
    tables.forEach((t, i) => console.log(`  ${t.padEnd(28)} D1 ${counts[i][0].n}`));
    return;
  }
  if (args.commit && have)
    throw new Error(
      `marker ${key} already exists: D1 is the source of truth for ${args.family}; refusing to overwrite it from Postgres`
    );

  const t0 = performance.now();
  const writeUrl = args['pg-write-url'] ?? process.env.CUTOVER_PG_WRITE_URL;
  const plan = loadPlan();
  const open = async () => {
    const client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    const bound = await bindPlan(client, plan);
    const fam = bound.platform.tables.filter(bt => tables.includes(bt.name)); // already FK-ordered
    return { client, fam };
  };

  // 1. dry run: report + FK pre-check (also the first half of --commit; its snapshot is closed before the freeze)
  {
    const { client, fam } = await open();
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
      .map(bt => ({
        bt,
        col: bt.columns.find(c => ['store_id', 'beneficiary_id', 'storeId'].includes(c.col)),
      }))
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
    let drift0 = [];
    if (args.family === 'access') {
      drift0 = await storeFactMismatches(client, d);
      if (drift0.length)
        console.log(
          `STORE DIRECTORY DRIFT (owner/status/suspension/deleted/missing): ${drift0.slice(0, 10).join(', ')} (${drift0.length})`
        );
      else console.log('  store directory facts equal on both sides');
    }
    await client.query('ROLLBACK');
    await client.end();
    if (drift0.length)
      throw new Error('D1 stores differ from Postgres: run the directory reconcile, then re-run');
    if (orphans.length) {
      console.log(
        `FK PRE-CHECK FAILED: family rows name stores that are not in D1 stores:\n${JSON.stringify(orphans, null, 1)}`
      );
      throw new Error(
        'stores must be in D1 first (run the directory reconcile / migrate-platform-to-d1 for stores)'
      );
    }
    if (args.commit && EMPTY_PG_AFTER_FLIP.has(args.family) && !writeUrl)
      throw new Error(
        `family ${args.family} empties its Postgres rows after the flip (fail closed): pass --pg-write-url (or CUTOVER_PG_WRITE_URL) and, for a prod host, --allow-prod-write. Nothing was frozen.`
      );
    if (
      args.commit &&
      EMPTY_PG_AFTER_FLIP.has(args.family) &&
      /neon\.tech$/.test(new URL(writeUrl).hostname) &&
      !args['allow-prod-write']
    )
      throw new Error(
        'the write URL is a production Neon host: pass --allow-prod-write to confirm. Nothing was frozen.'
      );
    if (!args.commit) {
      console.log(
        `dry run: nothing written (${fmtMs(performance.now() - t0)}). Add --commit to freeze, copy, verify and flip.`
      );
      return;
    }
  }

  // 2. FREEZE and drain BEFORE the snapshot: a snapshot opened earlier would not see the writes the drain waits for,
  //    and a write after it would be lost.
  let frozenNow = false;
  const lift = async () => {
    if (!frozenNow) return;
    try {
      await liftFreeze();
      frozenNow = false;
    } catch (e) {
      // LOUD: a freeze left behind stops every write to the family until it expires (the API ignores it after its
      // expiresAt and pages). Non-zero exit; the operator must run --unfreeze.
      console.error(`!!! COULD NOT LIFT THE FREEZE ${fkey}: ${e.message}`);
      console.error(
        `!!! run: node scripts/cf/cutover-platform-family.mjs --family ${args.family} --unfreeze (same --d1 flags)`
      );
      process.exitCode = 1;
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      console.error(`${sig}: lifting the freeze before exit`);
      lift().finally(() => process.exit(130));
    });
  await setFreeze();
  const frozenAt = Date.now();
  frozenNow = true;
  console.log(
    `FROZEN ${args.family}: writes are refused (503, retryable). Draining ${args['drain-ms']} ms ...`
  );
  let flipped = false;
  let copied = {};
  const before = {};
  let famNames = [];
  try {
    await sleep(Number(args['drain-ms']));
    const { client, fam } = await open();
    famNames = fam.map(b => b.name);
    // 2b. billing: webhooks deferred during the freeze live in the dedupe table and could collide with a Postgres row of
    // the same (provider, event_id) on copy. Set them aside, copy, then put back those Postgres does not already know
    // (one it knows was already applied: dropping it IS the dedupe).
    let deferred = [];
    if (tables.includes('billing_webhook_events')) {
      deferred = await d1Query(
        d,
        `SELECT id, provider, event_id, event_type, outcome, detail, received_at FROM billing_webhook_events WHERE outcome = 'deferred'`
      );
      if (deferred.length)
        await d1Statements(d, [`DELETE FROM billing_webhook_events WHERE outcome = 'deferred';`]);
      console.log(`  ${deferred.length} deferred webhook(s) set aside`);
    }
    // 2c. inbox: callbacks recorded into D1 during the freeze are set aside, the Postgres rows copied, then the set-aside
    // rows put back unless Postgres already holds that idempotency key (a redelivery of a known event is the dedupe).
    let inboxStash = [];
    if (tables.includes('webhook_events')) {
      inboxStash = await d1Query(d, 'SELECT * FROM webhook_events');
      if (inboxStash.length) await d1Statements(d, ['DELETE FROM webhook_events;']);
      console.log(`  ${inboxStash.length} freeze-born inbox row(s) set aside`);
    }
    // 3. copy (idempotent upserts, FK order)
    let stmts = [];
    let bytes = 0;
    const flush = async () => {
      if (stmts.length) await d1Statements(d, stmts);
      stmts = [];
      bytes = 0;
    };
    const copiedPks = {};
    for (const bt of fam) {
      before[bt.name] = await sourceDigest(client, bt, plan.platform, 'all');
      const names = bt.columns.map(c => c.col);
      const pkIdx = bt.pk.map(c => names.indexOf(c));
      copiedPks[bt.name] = new Map();
      for await (const page of sourcePages(client, bt, plan.platform, 'all', null, args.pageSize))
        for (const r of page) {
          copiedPks[bt.name].set(
            JSON.stringify(pkIdx.map(i => String(r[i]))),
            pkIdx.map(i => r[i])
          );
          const st = upsert(bt.name, names, bt.pk, r);
          stmts.push(st);
          bytes += st.length;
          if (bytes >= MAX_FILE_BYTES) await flush();
        }
      await flush();
      console.log(`  copied ${bt.name} (${before[bt.name].count} rows)`);
    }
    copied = copiedPks;

    // 3b. STRAYS: upserts never delete, so a D1 row Postgres does not have (left by an earlier partial migration, or a row
    // Postgres since deleted) would be a permanent MISMATCH and, for membership, a phantom grant. Inside the freeze, remove it.
    for (const bt of fam) {
      const have = await d1Query(
        d,
        `SELECT ${bt.pk.map(q).join(', ')} FROM ${q(bt.name)}${verifyWhere(bt.name)}`
      );
      const stray = have.filter(
        row => !copiedPks[bt.name].has(JSON.stringify(bt.pk.map(c => String(row[c]))))
      );
      if (stray.length) {
        await d1Statements(
          d,
          stray.map(
            row =>
              `DELETE FROM ${q(bt.name)} WHERE ${bt.pk.map(c => `${q(c)} = ${lit(row[c])}`).join(' AND ')};`
          )
        );
        console.log(`  removed ${stray.length} stray D1 row(s) from ${bt.name} (not in Postgres)`);
      }
    }

    if (inboxStash.length) {
      const cols = Object.keys(inboxStash[0]);
      await d1Statements(
        d,
        inboxStash.map(
          r =>
            `INSERT INTO webhook_events (${cols.map(q).join(', ')}) VALUES (${cols.map(c => lit(r[c])).join(', ')}) ON CONFLICT (idempotency_key) DO NOTHING;`
        )
      );
      console.log(
        `  ${inboxStash.length} freeze-born inbox row(s) put back (already-known ones dropped)`
      );
    }
    if (deferred.length) {
      await d1Statements(
        d,
        deferred.map(
          r =>
            `INSERT INTO billing_webhook_events (id, provider, event_id, event_type, outcome, detail, received_at) VALUES (${[r.id, r.provider, r.event_id, r.event_type, r.outcome, r.detail, r.received_at].map(lit).join(', ')}) ON CONFLICT (provider, event_id) DO NOTHING;`
        )
      );
      console.log(`  ${deferred.length} deferred webhook(s) put back (already-known ones dropped)`);
    }
    // 4. verify: count + digest on both sides, foreign keys
    const results = await d1QueryMany(d, [
      ...fam.map(
        bt =>
          `SELECT ${bt.columns.map(c => q(c.col)).join(', ')} FROM ${q(bt.name)}${verifyWhere(bt.name, inboxStash)} ORDER BY ${bt.pk.map(q).join(', ')}`
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
      const src = before[bt.name];
      const ok = src.count === dst.count && src.digest === dst.digest;
      console.log(
        `  verify ${bt.name.padEnd(28)} ${ok ? 'EQUAL' : 'MISMATCH'}  src ${src.count} ${src.digest.slice(0, 12)}  d1 ${dst.count} ${dst.digest.slice(0, 12)}`
      );
      if (!ok) bad.push(bt.name);
    }
    const fkRows = results.at(-1);
    if (fkRows.length) bad.push(`foreign_key_check:${JSON.stringify(fkRows.slice(0, 5))}`);
    await client.query('ROLLBACK');
    await client.end();
    if (bad.length)
      throw new Error(
        `verification failed (${bad.join(', ')}); the switch was NOT flipped and the freeze is lifted. Re-run.`
      );

    // The API ignores the freeze after --freeze-ttl-ms: never flip when more than 80% of it is gone (the drift check and the
    // emptying still have to run inside it).
    if (Date.now() - frozenAt > 0.8 * Number(args['freeze-ttl-ms']))
      throw new Error(
        `the freeze has used 80% of --freeze-ttl-ms (${args['freeze-ttl-ms']}): not flipping; re-run.`
      );
    // 5. flip
    const value = JSON.stringify({
      family: args.family,
      copiedAt: new Date().toISOString(),
      tables: Object.fromEntries(famNames.map(n => [n, before[n]])),
    });
    await d1Statements(d, [
      `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(key)}, ${lit(value)}, 'cutover', 0) ON CONFLICT (key) DO NOTHING;`,
    ]);
    if (!(await marker())) throw new Error('marker was not written');
    flipped = true;
    console.log(
      `FLIPPED: ${key} written. Waiting ${args['settle-ms']} ms so every isolate sees it ...`
    );
  } finally {
    if (!flipped) {
      await lift();
      if (!frozenNow) console.log('freeze lifted (nothing was flipped).');
    }
  }
  await sleep(Number(args['settle-ms']));

  // 6. drift: a NEW connection = a snapshot taken after the flip. Any difference is a write that reached Postgres.
  const after = await open();
  const drift = [];
  for (const bt of after.fam) {
    const now = await sourceDigest(after.client, bt, plan.platform, 'all');
    if (now.count !== before[bt.name].count || now.digest !== before[bt.name].digest)
      drift.push(bt.name);
  }
  await after.client.query('ROLLBACK');
  await after.client.end();

  // 7. FAIL CLOSED (still frozen): empty the migrated Postgres rows, so every Postgres policy/definer that still reads them
  // (users/stores RLS, ebda_may_act_on_user, customer search) denies instead of granting a stale membership. Only the rows
  // copied are deleted, by primary key, in one transaction. The Neon dump is the backup. Skipped on drift: those rows are the
  // only copy of a write D1 does not have.
  if (EMPTY_PG_AFTER_FLIP.has(args.family) && !drift.length) {
    const w = new pg.Client({
      connectionString: writeUrl,
      application_name: 'ebda-cf-migrate-empty',
    });
    await w.connect();
    try {
      await w.query('BEGIN');
      await w.query('SET LOCAL row_security = off');
      for (const bt of [...after.fam].reverse()) {
        const ids = [...copied[bt.name].values()].map(v => v[0]);
        if (bt.pk.length !== 1) throw new Error(`${bt.name}: expected a single-column primary key`);
        const res = await w.query(`DELETE FROM "${bt.origin}" WHERE "${bt.pk[0]}" = ANY($1)`, [
          ids,
        ]);
        console.log(`  emptied Postgres ${bt.origin}: ${res.rowCount} row(s)`);
        if (res.rowCount !== ids.length)
          throw new Error(
            `${bt.origin}: deleted ${res.rowCount}, expected ${ids.length}; rolled back`
          );
      }
      await w.query('COMMIT');
    } catch (e) {
      await w.query('ROLLBACK').catch(() => {});
      console.log(
        `EMPTYING POSTGRES FAILED (${e.message}); Postgres rows remain, the freeze is lifted. Re-run only the empty by hand.`
      );
      process.exitCode = 3;
    } finally {
      await w.end();
    }
  }
  await lift();
  if (frozenNow) throw new Error('the freeze is still up (see above); run --unfreeze');
  console.log('freeze lifted.');
  if (drift.length) {
    console.log(
      `DRIFT: Postgres changed after the copy in ${drift.join(', ')}. Re-apply those rows in D1 by hand (query Postgres on updated_at).`
    );
    process.exit(2);
  }
  console.log(
    `done in ${fmtMs(performance.now() - t0)}; Postgres digests unchanged since the copy.`
  );
}

/** D1 rows to compare: the cutover bookkeeping rows live in system_settings and are not part of the copied data. */
function verifyWhere(table, inboxStash = []) {
  if (table === 'system_settings')
    return ` WHERE key NOT LIKE 'platform_cutover.%' AND key NOT LIKE 'platform_freeze.%'`;
  // webhooks that arrived during the freeze are stored here as `deferred` (D1 only); they are not part of the copy
  if (table === 'billing_webhook_events') return ` WHERE outcome <> 'deferred'`;
  // callbacks recorded during the freeze are D1-only rows, not part of the copied data
  if (table === 'webhook_events' && inboxStash.length)
    return ` WHERE id NOT IN (${inboxStash.map(r => lit(r.id)).join(', ')})`;
  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  });
