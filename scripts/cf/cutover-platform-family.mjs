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
  // N-10d. MONEY. Refuses unless the `billing` marker exists (a claim is confirmed inside the billing ledger flow). The order
  // receipts of stores that live on their Durable Object are NOT copied (their home is the DO, Ruling INSTAPAY-DO-1): the
  // run counts them and refuses --commit until --accept-skipped-do-receipts <that count> acknowledges the number.
  payments: ['instapay_receipts', 'manual_payment_claims'],
  // N-10d. Non-money platform tables.
  ops: ['answer_engine_provider_configs', 'store_usage_snapshots', 'ci_insights'],
  // N-10d. The audit trail: Postgres `audit_logs` rows with NO store -> D1 `platform_audit_log` (own flow below: `auditCutover`).
  audit: [],
};

/** Families the shared table-copy flow below handles; `audit` has its own flow. */
const REQUIRES = { payments: 'billing' };

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
    // a freeze carries its own expiry: if this script dies without lifting it the API ignores it after this long and pages
    'freeze-ttl-ms': { type: 'string', default: '900000' },
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
    await client.query('ROLLBACK');
    await client.end();
    if (orphans.length) {
      console.log(
        `FK PRE-CHECK FAILED: family rows name stores that are not in D1 stores:\n${JSON.stringify(orphans, null, 1)}`
      );
      throw new Error(
        'stores must be in D1 first (run the directory reconcile / migrate-platform-to-d1 for stores)'
      );
    }
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
  frozenNow = true;
  console.log(
    `FROZEN ${args.family}: writes are refused (503, retryable). Draining ${args['drain-ms']} ms ...`
  );
  let flipped = false;
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
    for (const bt of fam) {
      before[bt.name] = await digestOf(client, bt, plan);
      const names = bt.columns.map(c => c.col);
      for await (const page of sourcePages(client, bt, plan.platform, 'all', null, args.pageSize))
        for (const r of page) {
          if (skipRow(bt, r)) continue;
          const st = upsert(bt.name, names, bt.pk, r);
          stmts.push(st);
          bytes += st.length;
          if (bytes >= MAX_FILE_BYTES) await flush();
        }
      await flush();
      console.log(`  copied ${bt.name} (${before[bt.name].count} rows)`);
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
          `SELECT ${bt.columns.map(c => q(c.col)).join(', ')} FROM ${q(bt.name)}${verifyWhere(bt.name, inboxStash, doStores)} ORDER BY ${bt.pk.map(q).join(', ')}`
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
  await lift();
  if (frozenNow) throw new Error('the freeze is still up (see above); run --unfreeze');
  console.log('freeze lifted.');

  // 6. drift: a NEW connection = a snapshot taken after the flip. Any difference is a write that reached Postgres.
  const after = await open();
  const drift = [];
  for (const bt of after.fam) {
    const now = await digestOf(after.client, bt, plan);
    if (now.count !== before[bt.name].count || now.digest !== before[bt.name].digest)
      drift.push(bt.name);
  }
  await after.client.query('ROLLBACK');
  await after.client.end();
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
  let all = 0;
  for await (const rows of auditPages(client, size))
    for (const r of rows) {
      all++;
      if (olderThanMs === null || Number(r.created_ms) < olderThanMs)
        await dg.add(AUDIT_COLS, auditRowToD1(r), ['id']);
    }
  return { ...(await dg.finish()), all };
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
    const d1Rows = await d1Query(
      d,
      `SELECT ${AUDIT_COLS.map(q).join(', ')} FROM platform_audit_log WHERE created_at < ${Number(T)} ORDER BY id`
    );
    const dg = new TableDigest();
    for (const r of d1Rows)
      await dg.add(
        AUDIT_COLS,
        AUDIT_COLS.map(c => r[c]),
        ['id']
      );
    const dst = await dg.finish();
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

/** D1 rows to compare: the cutover bookkeeping rows live in system_settings and are not part of the copied data. */
function verifyWhere(table, inboxStash = [], doStores = new Set()) {
  if (table === 'instapay_receipts' && doStores.size)
    return ` WHERE NOT (kind = 'order' AND store_id IN (${[...doStores].map(lit).join(', ')}))`;
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
