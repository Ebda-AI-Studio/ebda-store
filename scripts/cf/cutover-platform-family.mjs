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
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli, fmtMs } from './lib/cli.mjs';
import pg from 'pg';
import { connectReadOnly } from './lib/pg.mjs';
import { loadPlan } from './lib/plan.mjs';
import { countsByTable } from './lib/counts.mjs';
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
    'trust_requests',
    'merchant_api_keys',
    'SlugRedirect',
  ],
  // The payment-webhook inbox. A provider callback is never refused: during the freeze it is recorded straight into D1.
  inbox: ['webhook_events'],
  // Ruling NZ-AN-1: platform-wide AI usage (the quota counts across stores). The per-store analytics tables use
  // scripts/cf/copy-analytics-to-do.mjs instead (same marker/freeze keys, family `analytics`).
  'ai-usage': ['ai_usage'],
  // N-10d. MONEY. Refuses unless the `billing` marker exists (a claim is confirmed inside the billing ledger flow). The order
  // receipts of stores that live on their Durable Object are NOT copied (their home is the DO, Ruling INSTAPAY-DO-1): the
  // run counts them and refuses --commit until --accept-skipped-do-receipts <that count> acknowledges the number.
  // INSTAPAY-AUTO-1: instapay_auto_confirmations is born on D1 (no Postgres rows in production); listed so the router and the copy agree.
  payments: ['instapay_receipts', 'manual_payment_claims', 'instapay_auto_confirmations'],
  // N-10d. Non-money platform tables.
  // NZ-C-11 adds the admin push devices (user-keyed, no store, no FK: users live in identity).
  ops: [
    'answer_engine_provider_configs',
    'store_usage_snapshots',
    'ci_insights',
    'onesignal_subscriptions',
  ],
  // N-10d. The audit trail: Postgres `audit_logs` rows with NO store -> D1 `platform_audit_log` (own flow below: `auditCutover`).
  audit: [],
};

/** Families the shared table-copy flow below handles; `audit` has its own flow. */
const REQUIRES = { payments: 'billing' };

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

/**
 * D1-only rows a table may hold DURING the freeze (written by the API, not part of the Postgres copy). Before the copy they
 * are set aside (written to a durable NDJSON file FIRST, then deleted by id so a row that arrives meanwhile is never
 * touched); after the copy they are put back, in a `finally` too, with SQL that is idempotent and never loses state.
 */
export const ASIDE = {
  billing_webhook_events: {
    cols: ['id', 'provider', 'event_id', 'event_type', 'outcome', 'detail', 'received_at'],
    where: "outcome = 'deferred'",
    // a (provider, event_id) Postgres already holds was applied there: dropping the deferred row IS the dedupe
    restore: (r, lit) =>
      `INSERT INTO billing_webhook_events (id, provider, event_id, event_type, outcome, detail, received_at) VALUES (${[r.id, r.provider, r.event_id, r.event_type, r.outcome, r.detail, r.received_at].map(lit).join(', ')}) ON CONFLICT (provider, event_id) DO NOTHING;`,
  },
};

// Inbox rows recorded into D1 during the freeze. `processed` WINS on a key Postgres already holds (a freeze-window
// redelivery that was processed must not be reset to `received` by the copied row), everything else keeps Postgres' row.
const INBOX_COLS = [
  'id',
  'provider',
  'idempotency_key',
  'store_id',
  'payload',
  'raw_body',
  'signature',
  'status',
  'attempts',
  'last_error',
  'result_order_id',
  'result_status',
  'received_at',
  'processed_at',
  'created_at',
  'updated_at',
];
ASIDE.webhook_events = {
  cols: INBOX_COLS,
  // every row that is not part of the Postgres copy: the freeze started before any of them
  where: '1 = 1',
  restore: (r, lit) =>
    `INSERT INTO webhook_events (${INBOX_COLS.join(', ')}) VALUES (${INBOX_COLS.map(c => lit(r[c])).join(', ')}) ON CONFLICT (idempotency_key) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error, result_order_id = excluded.result_order_id, result_status = excluded.result_status, processed_at = excluded.processed_at, updated_at = excluded.updated_at WHERE excluded.status = 'processed' AND webhook_events.status <> 'processed';`,
};

/**
 * The set-aside file holds D1 rows that can carry provider payloads and card references, so every line is AES-256-GCM
 * encrypted with a key from CUTOVER_STASH_KEY (>= 32 chars; the run refuses to set rows aside without it), the file is mode
 * 0600, and it is DELETED once the rows are back in D1.
 */
function stashKey() {
  const k = process.env.CUTOVER_STASH_KEY;
  if (!k || k.length < 32)
    throw new Error('set CUTOVER_STASH_KEY (>= 32 chars) before rows are set aside');
  return crypto.createHash('sha256').update(k).digest();
}
export const sealLine = obj => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', stashKey(), iv, { authTagLength: 16 });
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
};
export const openLine = line => {
  const [iv, tag, enc] = line.split('.').map(x => Buffer.from(x, 'base64'));
  // a short tag would be accepted by GCM as-is (forgery gets cheaper), so pin the length both ways
  if (tag.length !== 16) throw new Error('stash line: bad auth tag length');
  const d = crypto.createDecipheriv('aes-256-gcm', stashKey(), iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
};

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
    'accept-skipped-do-receipts': { type: 'string' },
    'drain-ms': { type: 'string', default: '45000' },
    'settle-ms': { type: 'string', default: '12000' },
    // `access` only: a WRITE connection used once, after the flip, to empty the migrated Postgres rows.
    'pg-write-url': { type: 'string' },
    'allow-prod-write': { type: 'boolean', default: false },
    // a freeze carries its own expiry: if this script dies without lifting it the API ignores it after this long and pages
    'freeze-ttl-ms': { type: 'string', default: '900000' },
    // where the set-aside rows are written BEFORE they are deleted (kept after the run)
    'stash-dir': { type: 'string', default: '.cutover-stash' },
    'restore-stash': { type: 'string' },
  });
  const tables = FAMILIES[args.family];
  if (!tables) throw new Error(`pass --family <${Object.keys(FAMILIES).join('|')}>`);
  if (args.family === 'audit') return auditCutover(args);
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

  if (args['restore-stash']) {
    const lines = fs
      .readFileSync(args['restore-stash'], 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => openLine(l));
    const sql = lines.map(({ table, row }) => ASIDE[table].restore(row, lit));
    if (sql.length) await d1Statements(d, sql);
    console.log(
      `restored ${sql.length} set-aside row(s) from ${args['restore-stash']} (idempotent)`
    );
    return;
  }
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
    const counts = countsByTable(
      tables,
      await d1QueryMany(
        d,
        tables.map(t => `SELECT count(*) AS n FROM ${q(t)}`)
      )
    );
    const fr = await d1Query(d, `SELECT 1 AS n FROM system_settings WHERE key = ${lit(fkey)}`);
    console.log(
      `marker: ${have ? `PRESENT ${have.value} (${have.created_at})` : 'absent'}   freeze: ${fr.length ? 'ON' : 'off'}`
    );
    tables.forEach(t => console.log(`  ${t.padEnd(28)} D1 ${counts[t]}`));
    return;
  }
  if (args.commit && have)
    throw new Error(
      `marker ${key} already exists: D1 is the source of truth for ${args.family}; refusing to overwrite it from Postgres`
    );

  if (REQUIRES[args.family] && args.commit) {
    const need = (
      await d1Query(
        d,
        `SELECT 1 AS n FROM system_settings WHERE key = ${lit(markerKey(REQUIRES[args.family]))}`
      )
    )[0];
    if (!need)
      throw new Error(
        `${args.family} requires the ${REQUIRES[args.family]} family to be on D1 first (marker ${markerKey(REQUIRES[args.family])} is absent)`
      );
  }
  // payments: the order receipts of a DO store live in its DO (Ruling INSTAPAY-DO-1) and are not copied into D1.
  const doStores =
    args.family === 'payments'
      ? new Set(
          (await d1Query(d, `SELECT id FROM stores WHERE storage_backend = 'do'`)).map(r => r.id)
        )
      : new Set();
  const skipRow = (bt, r) => {
    if (bt.name !== 'instapay_receipts' || doStores.size === 0) return false;
    const iStore = bt.columns.findIndex(c => c.col === 'store_id');
    const iKind = bt.columns.findIndex(c => c.col === 'kind');
    return r[iKind] === 'order' && doStores.has(r[iStore]);
  };
  const digestOf = async (client, bt, plan) => {
    if (bt.name !== 'instapay_receipts') return sourceDigest(client, bt, plan.platform, 'all');
    const dg = new TableDigest();
    const names = bt.columns.map(c => c.col);
    for await (const page of sourcePages(client, bt, plan.platform, 'all', null, 2000))
      for (const r of page) if (!skipRow(bt, r)) await dg.add(names, r, bt.pk);
    return dg.finish();
  };
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
    const d1Counts = countsByTable(
      tables,
      await d1QueryMany(
        d,
        tables.map(t => `SELECT count(*) AS n FROM ${q(t)}`)
      )
    );
    let skippedDoReceipts = 0;
    if (args.family === 'payments' && doStores.size) {
      skippedDoReceipts = Number(
        (
          await client.query(
            `SELECT count(*) AS n FROM "instapay_receipts" WHERE kind = 'order' AND store_id = ANY($1::text[])`,
            [[...doStores]]
          )
        ).rows[0].n
      );
      console.log(
        `  order receipts of ${doStores.size} DO store(s) in Postgres, NOT copied (their home is the DO): ${skippedDoReceipts}`
      );
      if (args.commit && skippedDoReceipts !== Number(args['accept-skipped-do-receipts'] ?? -1))
        throw new Error(
          `${skippedDoReceipts} DO-store order receipt(s) would be left in Postgres. Confirm they exist in their store DO (verify-store.mjs), then re-run with --accept-skipped-do-receipts ${skippedDoReceipts}`
        );
    }
    console.log(`family ${args.family}  marker: ${have ? 'PRESENT' : 'absent'}`);
    fam.forEach(bt =>
      console.log(
        `  ${bt.name.padEnd(28)} PG ${String(pgCounts[bt.name]).padStart(7)}   D1 ${String(d1Counts[bt.name]).padStart(7)}`
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
  freezeStartMs = Date.now();
  const freezeStartedAt = Date.now();
  await setFreeze();
  const frozenAt = Date.now();
  frozenNow = true;
  console.log(
    `FROZEN ${args.family}: writes are refused (503, retryable). Draining ${args['drain-ms']} ms ...`
  );
  let flipped = false;
  let copied = {};
  const stashFile = path.join(
    args['stash-dir'],
    `${args.family}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`
  );
  const aside = [];
  let putBackDone = false;
  // idempotent: runs after the copy AND in the finally, so an abort never leaves a callback / webhook only in memory
  const putBack = async () => {
    if (putBackDone) return;
    const sql = aside.flatMap(({ table, rows }) => rows.map(r => ASIDE[table].restore(r, lit)));
    if (sql.length) await d1Statements(d, sql);
    putBackDone = true;
    fs.rmSync(stashFile, { force: true }); // the rows are durable in D1 again: no copy stays on disk
    if (sql.length)
      console.log(`  ${sql.length} set-aside row(s) put back (already-known ones dropped)`);
  };
  const before = {};
  let famNames = [];
  try {
    await sleep(Number(args['drain-ms']));
    const { client, fam } = await open();
    famNames = fam.map(b => b.name);
    // 2b. set aside the D1-only rows (see ASIDE): durable file first, then delete exactly those ids
    for (const bt of fam) {
      const spec = ASIDE[bt.name];
      if (!spec) continue;
      const rows = await d1Query(
        d,
        `SELECT ${spec.cols.join(', ')} FROM ${q(bt.name)} WHERE ${spec.where}`
      );
      if (rows.length) {
        fs.mkdirSync(path.dirname(stashFile), { recursive: true });
        const fd = fs.openSync(stashFile, 'a', 0o600);
        fs.writeSync(fd, rows.map(r => sealLine({ table: bt.name, row: r })).join('\n') + '\n');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        for (let i = 0; i < rows.length; i += 400)
          await d1Statements(d, [
            `DELETE FROM ${q(bt.name)} WHERE id IN (${rows
              .slice(i, i + 400)
              .map(r => lit(r.id))
              .join(', ')});`,
          ]);
        aside.push({ table: bt.name, rows });
      }
      console.log(`  ${rows.length} ${bt.name} row(s) set aside (${stashFile})`);
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
      before[bt.name] = await digestOf(client, bt, plan);
      const names = bt.columns.map(c => c.col);
      const pkIdx = bt.pk.map(c => names.indexOf(c));
      copiedPks[bt.name] = new Map();
      for await (const page of sourcePages(client, bt, plan.platform, 'all', null, args.pageSize))
        for (const r of page) {
          if (skipRow(bt, r)) continue;
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

    await putBack();
    // 4. verify: count + digest on both sides, foreign keys
    const results = await d1QueryMany(d, [
      ...fam.map(
        bt =>
          `SELECT ${bt.columns.map(c => q(c.col)).join(', ')} FROM ${q(bt.name)}${verifyWhere(bt.name, doStores)} ORDER BY ${bt.pk.map(q).join(', ')}`
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
    await putBack().catch(e =>
      console.error(
        `!!! PUT-BACK FAILED (${e.message}); run: --restore-stash ${stashFile} (same --d1 flags)`
      )
    );
    if (!flipped) {
      await lift();
      if (!frozenNow) console.log('freeze lifted (nothing was flipped).');
    }
  }
  await sleep(Number(args['settle-ms']));

  // 5b. ai-usage (Ruling NZ-AN-1): while the family is frozen `recordUsage` writes the usage row of an AI call that already ran to
  // POSTGRES (never dropped). Copy those rows into D1 now (idempotent by id), then verify every one is there; the digest drift
  // check below would otherwise report them as lost writes.
  let skipDrift = new Set();
  if (args.family === 'ai-usage') {
    const c = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    try {
      const since = new Date(freezeStartedAt - 60_000);
      const rows = (
        await c.query(
          `SELECT id, store_id, feature, input_tokens, output_tokens, cached_hit, model, cost_micros, subject_type, subject_id, created_at
             FROM ai_usage WHERE created_at >= $1 ORDER BY id`,
          [since]
        )
      ).rows;
      const stmts = rows.map(
        r =>
          `INSERT INTO ai_usage (id, store_id, feature, input_tokens, output_tokens, cached_hit, model, cost_micros, subject_type, subject_id, created_at) VALUES (${[r.id, r.store_id, r.feature, r.input_tokens, r.output_tokens, r.cached_hit ? 1 : 0, r.model, r.cost_micros, r.subject_type, r.subject_id, new Date(r.created_at).getTime()].map(lit).join(', ')}) ON CONFLICT (id) DO NOTHING;`
      );
      for (let i = 0; i < stmts.length; i += 200) await d1Statements(d, stmts.slice(i, i + 200));
      let missing = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const ids = rows.slice(i, i + 200).map(r => lit(r.id));
        const have = (
          await d1Query(d, `SELECT count(*) AS n FROM ai_usage WHERE id IN (${ids.join(',')})`)
        )[0].n;
        missing += ids.length - Number(have);
      }
      console.log(
        `  ai-usage delta: ${rows.length} Postgres row(s) since the freeze, ${missing} missing in D1 after the copy`
      );
      if (missing) {
        console.log(
          'DELTA INCOMPLETE: copy the missing Postgres ai_usage rows (created_at since the freeze) into D1 by hand.'
        );
        process.exit(2);
      }
      skipDrift = new Set(['ai_usage']);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  // 6. drift: a NEW connection = a snapshot taken after the flip. Any difference is a write that reached Postgres.
  const after = await open();
  const drift = [];
  for (const bt of after.fam.filter(b => !skipDrift.has(b.name))) {
    const now = await digestOf(after.client, bt, plan);
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

// ───────────────────────────── family `audit` (N-10d) ─────────────────────────────
// Postgres `audit_logs` rows with NO store -> D1 `platform_audit_log`. Unlike the table families, audit NEVER refuses a write:
// the freeze only REDIRECTS new store-less rows to D1 (services/platform/cutover.ts `auditStoreLessOnD1`), so nothing is lost
// and nothing blocks. Flow: freeze (new rows -> D1) -> drain -> Postgres snapshot -> copy EVERY Postgres store-less row (id
// upsert; rows born in D1 during the freeze have other ids) -> verify the rows older than T (the freeze instant: D1 holds only
// copied rows there) -> flip the marker -> settle -> lift -> drift check on a NEW connection (a Postgres row that appeared
// after the snapshot = a write that bypassed the sink). Rows of stores on their Durable Object that Postgres still holds are
// RE-IMPORTED into their StoreDO before the flip (`reimportDoStoreAudit`, idempotent by id, verified per store).
const AUDIT_COLS = [
  'id',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'store_id',
  'meta',
  'created_at',
];
const AUDIT_PG_SQL = `SELECT id, user_id, action, resource_type, resource_id, details, ip_address, user_agent,
    (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
  FROM audit_logs WHERE store_id IS NULL AND id > $1 ORDER BY id LIMIT $2`;

/** The D1 row (aligned with AUDIT_COLS) for one Postgres audit row. */
export const auditRowToD1 = r => [
  r.id,
  r.user_id,
  r.action,
  r.resource_type,
  r.resource_id,
  null,
  JSON.stringify({
    details: r.details ?? {},
    ipAddress: r.ip_address ?? null,
    userAgent: r.user_agent ?? null,
  }),
  Number(r.created_ms),
];

async function* auditPages(client, size) {
  let after = '';
  for (;;) {
    const rows = (await client.query(AUDIT_PG_SQL, [after, size])).rows;
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1].id;
    if (rows.length < size) return;
  }
}

async function auditDigest(client, size, olderThanMs) {
  const dg = new TableDigest();
  const ids = [];
  let all = 0;
  for await (const rows of auditPages(client, size))
    for (const r of rows) {
      all++;
      if (olderThanMs === null || Number(r.created_ms) < olderThanMs) {
        await dg.add(AUDIT_COLS, auditRowToD1(r), ['id']);
        ids.push(r.id);
      }
    }
  return { ...(await dg.finish()), all, ids };
}

/** Digest of exactly these ids on the D1 side (BY ID: D1 may also hold mirrored impersonation rows or rows of an aborted run). */
export async function d1AuditDigestByIds(d, ids, query = d1Query) {
  const dg = new TableDigest();
  const sorted = [...ids].sort();
  for (let i = 0; i < sorted.length; i += 400) {
    const chunk = sorted.slice(i, i + 400);
    const rows = await query(
      d,
      `SELECT ${AUDIT_COLS.map(q).join(', ')} FROM platform_audit_log WHERE store_id IS NULL AND id IN (${chunk.map(lit).join(', ')}) ORDER BY id`
    );
    for (const r of rows)
      await dg.add(
        AUDIT_COLS,
        AUDIT_COLS.map(c => r[c]),
        ['id']
      );
  }
  return dg.finish();
}

/** Postgres audit row -> the `__auditimport` row shape (snake_case, details as JSON text, created_at epoch ms). */
export const auditRowToDoImport = r => ({
  id: r.id,
  action: r.action,
  user_id: r.user_id,
  store_id: r.store_id,
  resource_type: r.resource_type,
  resource_id: r.resource_id,
  details: JSON.stringify(r.details ?? {}),
  ip_address: r.ip_address,
  user_agent: r.user_agent,
  created_at: Number(r.created_ms),
});

const DO_AUDIT_SQL = `SELECT id, user_id, action, store_id, resource_type, resource_id, details, ip_address, user_agent,
    (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
  FROM audit_logs WHERE store_id = $1 AND id > $2 ORDER BY id LIMIT $3`;

/**
 * Re-import the Postgres audit rows of every DO store into its StoreDO (POST /cutover/stores/<id>/__auditimport: the one
 * write a SEALED store accepts, INSERT OR IGNORE by id, so rows the DO already holds are no-ops and a re-run is safe).
 * Every Postgres row of the store is sent, which covers "created at or after the store's migration" and also any older
 * row the migration copy missed; verified per store: the DO must hold every sent id (present = sent). Throws on the
 * first store that does not verify, BEFORE the marker is flipped.
 */
export async function reimportDoStoreAudit(client, args, doStores, fetchImpl = fetch) {
  const out = [];
  for (const storeId of doStores) {
    let after = '';
    let pg = 0;
    let present = 0;
    let inserted = 0;
    for (;;) {
      const rows = (await client.query(DO_AUDIT_SQL, [storeId, after, 500])).rows;
      if (rows.length === 0) break;
      const res = await fetchImpl(`${args.doUrl}/cutover/stores/${storeId}/__auditimport`, {
        method: 'POST',
        headers: { authorization: `Bearer ${args.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rows: rows.map(auditRowToDoImport) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok)
        throw new Error(`audit re-import ${storeId}: HTTP ${res.status} ${j.error ?? ''}`);
      pg += rows.length;
      present += j.present;
      inserted += j.inserted;
      after = rows[rows.length - 1].id;
      if (rows.length < 500) break;
    }
    if (present !== pg)
      throw new Error(`audit re-import ${storeId}: DO holds ${present} of ${pg} Postgres rows`);
    out.push({ storeId, pg, inserted });
    console.log(
      `  audit re-import ${storeId}: ${pg} row(s) in Postgres, ${inserted} added, all present`
    );
  }
  return out;
}

async function auditCutover(args) {
  if (!args.d1) throw new Error('pass --d1 <database name>');
  const d = {
    db: args.d1,
    target: args['d1-target'],
    config: args['d1-config'],
    persistTo: args['persist-to'],
  };
  const key = markerKey('audit');
  const fkey = freezeKey('audit');
  const marker = async () =>
    (
      await d1Query(d, `SELECT id, value, created_at FROM system_settings WHERE key = ${lit(key)}`)
    )[0];
  const liftFreeze = () =>
    d1Statements(d, [`DELETE FROM system_settings WHERE key = ${lit(fkey)};`]);
  if (args.unfreeze) {
    await liftFreeze();
    console.log(`freeze ${fkey} lifted.`);
    return;
  }
  if (args['delete-marker']) {
    await d1Statements(d, [`DELETE FROM system_settings WHERE key = ${lit(key)};`]);
    console.log(`marker ${key} deleted (before traffic only).`);
    return;
  }
  const have = await marker();
  const n = await d1Query(d, 'SELECT count(*) AS n FROM platform_audit_log');
  if (args.status) {
    console.log(
      `marker: ${have ? `PRESENT ${have.value}` : 'absent'}   platform_audit_log: ${n[0].n} row(s)`
    );
    return;
  }
  if (args.commit && have)
    throw new Error(`marker ${key} already exists: D1 is the source of truth; refusing to re-copy`);
  if (!args.doUrl || !args.secret || args.secret.length < 24)
    throw new Error(
      '--commit needs --do-url (or CUTOVER_DO_URL) and CUTOVER_IMPORT_SECRET for the per-store audit re-import'
    );
  const size = args.pageSize || 1000;
  const t0 = performance.now();
  const doStores = (await d1Query(d, `SELECT id FROM stores WHERE storage_backend = 'do'`)).map(
    r => r.id
  );

  const report = async client => {
    const pg = Number(
      (await client.query(`SELECT count(*) AS n FROM audit_logs WHERE store_id IS NULL`)).rows[0].n
    );
    const stranded = doStores.length
      ? Number(
          (
            await client.query(
              `SELECT count(*) AS n FROM audit_logs WHERE store_id = ANY($1::text[])`,
              [doStores]
            )
          ).rows[0].n
        )
      : 0;
    console.log(`audit: Postgres store-less rows ${pg}   D1 platform_audit_log ${n[0].n}`);
    console.log(
      `audit: rows of ${doStores.length} DO store(s) in Postgres: ${stranded} (re-imported into their StoreDO by --commit)`
    );
  };
  {
    const client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    await report(client);
    await client.query('ROLLBACK');
    await client.end();
    if (!args.commit) {
      console.log(`dry run: nothing written (${fmtMs(performance.now() - t0)}). Add --commit.`);
      return;
    }
  }

  const T = Date.now();
  let frozenNow = false;
  const lift = async () => {
    if (!frozenNow) return;
    try {
      await liftFreeze();
      frozenNow = false;
    } catch (e) {
      console.error(`!!! COULD NOT LIFT THE FREEZE ${fkey}: ${e.message}`);
      console.error(
        `!!! run: node scripts/cf/cutover-platform-family.mjs --family audit --unfreeze (same --d1 flags)`
      );
      process.exitCode = 1;
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => lift().finally(() => process.exit(130)));
  await d1Statements(d, [
    `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(fkey)}, ${lit(JSON.stringify({ expiresAt: Date.now() + Number(args['freeze-ttl-ms']), by: 'cutover-platform-family', t: T }))}, 'cutover', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
  ]);
  frozenNow = true;
  console.log(
    `REDIRECTING: new store-less audit rows now go to D1. Draining ${args['drain-ms']} ms ...`
  );
  let flipped = false;
  let before;
  try {
    await sleep(Number(args['drain-ms']));
    const client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    before = await auditDigest(client, size, T);
    let stmts = [];
    let bytes = 0;
    const flush = async () => {
      if (stmts.length) await d1Statements(d, stmts);
      stmts = [];
      bytes = 0;
    };
    let copied = 0;
    for await (const rows of auditPages(client, size))
      for (const r of rows) {
        const st = upsert('platform_audit_log', AUDIT_COLS, ['id'], auditRowToD1(r));
        stmts.push(st);
        bytes += st.length;
        copied++;
        if (bytes >= MAX_FILE_BYTES) await flush();
      }
    await flush();
    console.log(
      `  copied ${copied} row(s); ${copied - before.count} newer than the freeze instant (stragglers, kept)`
    );
    const dst = await d1AuditDigestByIds(d, before.ids);
    const ok = dst.count === before.count && dst.digest === before.digest;
    console.log(
      `  verify platform_audit_log ${ok ? 'EQUAL' : 'MISMATCH'}  src ${before.count} ${before.digest.slice(0, 12)}  d1 ${dst.count} ${dst.digest.slice(0, 12)}`
    );
    await client.query('ROLLBACK');
    await client.end();
    if (!ok)
      throw new Error(
        'verification failed; the switch was NOT flipped and the redirect is lifted. Re-run.'
      );
    await d1Statements(d, [
      `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(key)}, ${lit(JSON.stringify({ family: 'audit', copiedAt: new Date().toISOString(), rows: before.all, freezeInstant: T }))}, 'cutover', 0) ON CONFLICT (key) DO NOTHING;`,
    ]);
    if (!(await marker())) throw new Error('marker was not written');
    flipped = true;
    console.log(`FLIPPED: ${key} written. Waiting ${args['settle-ms']} ms ...`);
  } finally {
    if (!flipped) {
      await lift();
      if (!frozenNow) console.log('redirect lifted (nothing was flipped).');
    }
  }
  await sleep(Number(args['settle-ms']));
  await lift();
  if (frozenNow) throw new Error('the freeze is still up; run --unfreeze');
  const after = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
  const now = await auditDigest(after, size, null);
  await after.query('ROLLBACK');
  await after.end();
  if (now.all !== before.all) {
    console.log(
      `DRIFT: Postgres now holds ${now.all} store-less audit rows, ${before.all} at the copy. A write bypassed the sink: re-copy those rows (id > last copied) by hand.`
    );
    process.exit(2);
  }
  console.log(
    `done in ${fmtMs(performance.now() - t0)}; Postgres store-less audit row count unchanged since the copy.`
  );
}

/**
 * `system_settings` holds D1-ONLY bookkeeping next to the Postgres-copied settings: every family's marker and freeze
 * (`platform_cutover.*`, `platform_freeze.*`), the per-store / global customer-auth markers and freezes
 * (`customer_auth_cutover.*`, `customer_auth_freeze.*`), the analytics marker, and anything else the cutover scripts write
 * with `category = 'cutover'`. NONE of it is in Postgres, so the stray-row delete (step 3b) and the verify digest must never
 * see it: a row matched here would be DELETED as a "stray" (wiping a live customer-auth marker flips every store's customers
 * back to Postgres). Exported for the test that pins it.
 */
export const SYSTEM_SETTINGS_DATA_WHERE = ` WHERE COALESCE(category, '') <> 'cutover' AND key NOT LIKE 'platform_cutover.%' AND key NOT LIKE 'platform_freeze.%' AND key NOT LIKE 'customer_auth_%' AND key NOT LIKE '%_cutover.%' AND key NOT LIKE '%_freeze.%'`;

/** D1 rows to compare: the cutover bookkeeping rows live in system_settings and are not part of the copied data. */
let freezeStartMs = 0;
export function verifyWhere(table, doStores = new Set()) {
  if (table === 'instapay_receipts' && doStores.size)
    return ` WHERE NOT (kind = 'order' AND store_id IN (${[...doStores].map(lit).join(', ')}))`;
  if (table === 'system_settings') return SYSTEM_SETTINGS_DATA_WHERE;
  // webhooks that arrived during the freeze are stored here as `deferred` (D1 only); they are not part of the copy
  if (table === 'billing_webhook_events') return ` WHERE outcome <> 'deferred'`;
  // callbacks recorded into D1 during the freeze are D1-only rows, not part of the copied data
  if (table === 'webhook_events') return ` WHERE received_at < ${freezeStartMs}`;
  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  });
