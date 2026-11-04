#!/usr/bin/env node
// NEON-ZERO-1 N-9: move the storefront CUSTOMER auth rows (users with role=customer, their refresh tokens, passkeys) of each
// StoreDO store from Postgres into its StoreDO, then flip that store's marker. ONLY the controller runs it.
//
//   node scripts/cf/cutover-customer-auth.mjs --d1 ebda-platform --d1-target remote --d1-config apps/api/wrangler.jsonc \
//        --do-url https://api.ebda.app --pg-url "$CUTOVER_PG_URL" --allow-prod-read  --store <uuid> [--store <uuid> ...]   # DRY RUN
//   ... + --commit [--global]    copy -> verify -> flip (per store marker; --global also writes the all-stores marker after the last store)
//   ... + --status               marker / freeze / DO row counts, no Postgres
//   ... + --unfreeze             remove a freeze left behind by an aborted run
//   env: CUTOVER_IMPORT_SECRET (bearer for /cutover/stores/<id>/__auth), CUTOVER_PG_URL
//
// Per store, --commit: (1) refuses when the store (or global) marker exists, or the DO already says live; (2) writes the freeze
// (D1 system_settings customer_auth_freeze.<id> and .__any): a Postgres write of these rows is a retryable 503 in the API; waits
// --drain-ms (longer than any Postgres transaction may live); (3) ONLY THEN opens a new REPEATABLE READ snapshot
// (a snapshot taken before the freeze would hide writes made during the copy), copies in pages (idempotent upserts), reads the DO
// back page by page and compares count + digest of every column; (4) on equality inserts the marker; (5) waits again, re-digests
// Postgres on a NEW connection (a write that landed in the flip window shows as drift: exit 2), tells the DO it is live (imports
// are then refused 423, double-locking "refuse after marker"), and lifts the freeze. Any failure before the flip lifts the freeze.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cli, fmtMs } from './lib/cli.mjs';
import { connectReadOnly } from './lib/pg.mjs';
import { d1Query, d1Statements, lit } from './lib/d1.mjs';
import { TABLES, digestRows } from './lib/customer-auth-copy.mjs';

const markerKey = id => `customer_auth_cutover.${id}`;
const GLOBAL = 'customer_auth_cutover.__all';
const freezeKey = id => `customer_auth_freeze.${id}`;
const ANY = 'customer_auth_freeze.__any';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAGE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function doCall(args, storeId, op, body) {
  const res = await fetch(`${args.doUrl}/cutover/stores/${storeId}/__auth`, {
    method: 'POST',
    headers: { authorization: `Bearer ${args.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op, args: body }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false)
    throw new Error(`${op} ${storeId}: ${res.status} ${j.code ?? j.error ?? ''}`);
  return JSON.parse(j.json);
}

async function sourceRows(client, table, storeId) {
  const t = TABLES[table];
  const out = [];
  for (const r of (await client.query(t.sql, [storeId])).rows) out.push(t.map(r));
  return out;
}

async function main() {
  const { args, positionals } = cli(
    {
      d1: { type: 'string' },
      'd1-target': { type: 'string', default: 'local' },
      'd1-config': { type: 'string' },
      'persist-to': { type: 'string' },
      store: { type: 'string', multiple: true },
      // freeze -> drain -> snapshot: longer than any Postgres transaction may live (#407's sequence)
      'drain-ms': { type: 'string', default: '45000' },
      // after the flip: longer than the isolates' marker cache, before the drift check
      'settle-ms': { type: 'string', default: '20000' },
      // a freeze carries its own expiry: if this script dies the API ignores it after this long and pages (P1)
      'freeze-ttl-ms': { type: 'string', default: '900000' },
      commit: { type: 'boolean', default: false },
      global: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      unfreeze: { type: 'boolean', default: false },
    },
    {}
  );
  void positionals;
  const stores = args.store ?? [];
  if (!args.d1) throw new Error('pass --d1 <database name>');
  if (!stores.length || stores.some(s => !UUID.test(s)))
    throw new Error('pass --store <uuid> (one or more)');
  if (!args.status && !args.unfreeze && (!args.doUrl || !args.secret))
    throw new Error('set --do-url (or CUTOVER_DO_URL) and CUTOVER_IMPORT_SECRET');
  const d = {
    db: args.d1,
    target: args['d1-target'],
    config: args['d1-config'],
    persistTo: args['persist-to'],
  };
  const drain = Number(args['drain-ms']);
  const settle = Number(args['settle-ms']);
  const setFreeze = async (on, ids) => {
    const keys = [...ids.map(freezeKey), ANY];
    await d1Statements(
      d,
      keys.map(k =>
        on
          ? `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(k)}, ${lit(JSON.stringify({ expiresAt: Date.now() + Number(args['freeze-ttl-ms']), by: 'cutover-customer-auth' }))}, 'cutover', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value;`
          : `DELETE FROM system_settings WHERE key = ${lit(k)};`
      )
    );
  };
  const markerOf = async id =>
    (
      await d1Query(
        d,
        `SELECT key FROM system_settings WHERE key IN (${lit(markerKey(id))}, ${lit(GLOBAL)})`
      )
    )[0];

  if (args.unfreeze) {
    await setFreeze(false, stores);
    console.log('freeze removed for', stores.join(', '));
    return;
  }
  const backend = Object.fromEntries(
    (
      await d1Query(
        d,
        `SELECT id, storage_backend FROM stores WHERE id IN (${stores.map(lit).join(',')})`
      )
    ).map(r => [r.id, r.storage_backend])
  );
  for (const s of stores)
    if (backend[s] !== 'do')
      throw new Error(
        `store ${s} is not a DO store in D1 (storage_backend=${backend[s] ?? 'missing'}): refusing`
      );

  if (args.status) {
    for (const s of stores) {
      const m = await markerOf(s);
      console.log(`${s}  marker: ${m ? `PRESENT (${m.key})` : 'absent'}`);
      if (args.doUrl && args.secret)
        console.log(
          '   DO counts',
          JSON.stringify(await doCall(args, s, 'counts', {})),
          'live',
          JSON.stringify(await doCall(args, s, 'isLive', {}))
        );
    }
    return;
  }
  for (const s of stores) {
    const m = await markerOf(s);
    if (m && args.commit)
      throw new Error(
        `marker ${m.key} exists for ${s}: the DO is the source of truth; refusing to overwrite it from Postgres`
      );
    if ((await doCall(args, s, 'isLive', {})).live && args.commit)
      throw new Error(`the DO of ${s} is already live`);
  }

  const t0 = performance.now();
  let client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
  console.log('customer-auth family; PG vs DO per store');
  for (const s of stores) {
    const dc = await doCall(args, s, 'counts', {});
    for (const t of Object.keys(TABLES)) {
      const n = Number(
        (await client.query(`SELECT count(*) AS n FROM (${TABLES[t].sql}) q`, [s])).rows[0].n
      );
      console.log(
        `  ${s} ${t.padEnd(16)} PG ${String(n).padStart(6)}   DO ${String(dc[t]).padStart(6)}`
      );
    }
  }
  await client.query('ROLLBACK');
  await client.end();
  if (!args.commit) {
    console.log(
      `dry run: nothing written (${fmtMs(performance.now() - t0)}). Add --commit to freeze, copy, verify and flip.`
    );
    return;
  }

  const flipped = new Set();
  let frozenNow = false;
  const lift = async () => {
    await setFreeze(false, stores);
    frozenNow = false;
  };
  // a killed run must not leave the freeze up (it also expires on its own, with a P1)
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      console.error(`${sig}: lifting the freeze before exit`);
      lift().finally(() => process.exit(130));
    });
  await setFreeze(true, stores);
  frozenNow = true;
  console.log(
    `FROZEN ${stores.length} store(s): every customer-auth write gets 503 CUSTOMER_AUTH_FROZEN; draining ${drain} ms`
  );
  try {
    await sleep(drain);
    client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    const before = {};
    for (const s of stores) {
      before[s] = {};
      for (const t of Object.keys(TABLES)) {
        const rows = await sourceRows(client, t, s);
        before[s][t] = await digestRows(TABLES[t].cols, rows);
        for (let i = 0; i < rows.length; i += PAGE)
          await doCall(args, s, 'importRows', { table: t, rows: rows.slice(i, i + PAGE) });
      }
      console.log(`  copied ${s}`);
    }
    await client.query('ROLLBACK');
    await client.end();

    // verify: read the DO back (count + digest of every column), compare to the source digests
    const bad = [];
    for (const s of stores)
      for (const t of Object.keys(TABLES)) {
        const rows = [];
        for (let after = null; ; ) {
          const p = await doCall(args, s, 'exportRowsPage', { table: t, after, limit: 1000 });
          rows.push(...p.rows);
          if (!p.next) break;
          after = p.next;
        }
        const dg = await digestRows(TABLES[t].cols, rows);
        const ok = dg.count === before[s][t].count && dg.digest === before[s][t].digest;
        console.log(
          `  verify ${s} ${t.padEnd(16)} ${ok ? 'EQUAL' : 'MISMATCH'}  src ${before[s][t].count}  do ${dg.count}`
        );
        if (!ok) bad.push(`${s}:${t}`);
      }
    if (bad.length)
      throw new Error(
        `verification failed (${bad.join(', ')}); NOTHING flipped. Fix the cause and re-run (a stale extra row in a DO shows as a count difference).`
      );

    for (const s of stores) {
      const value = JSON.stringify({ copiedAt: new Date().toISOString(), tables: before[s] });
      await d1Statements(d, [
        `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(markerKey(s))}, ${lit(value)}, 'cutover', 0) ON CONFLICT (key) DO NOTHING;`,
      ]);
      if (!(await markerOf(s))) throw new Error(`marker for ${s} was not written`);
      flipped.add(s);
    }
    console.log(
      `FLIPPED ${stores.length} store(s). The API serves them from the StoreDO within 10 s per isolate; the freeze stays until then.`
    );

    // re-verify on a NEW connection after the marker TTL: a Postgres write that landed in the window shows as drift
    await sleep(settle);
    client = await connectReadOnly(args.pgUrl, { allowProd: args['allow-prod-read'] });
    const drift = [];
    for (const s of stores)
      for (const t of Object.keys(TABLES)) {
        const now = await digestRows(TABLES[t].cols, await sourceRows(client, t, s));
        if (now.count !== before[s][t].count || now.digest !== before[s][t].digest)
          drift.push(`${s}:${t}`);
      }
    await client.query('ROLLBACK');
    await client.end();
    if (drift.length) {
      await lift();
      console.log(
        `DRIFT: Postgres changed after the copy in ${drift.join(', ')}. The freeze is lifted; the DO is NOT marked live (imports stay open) so those rows can be re-applied by hand through importRows. Investigate.`
      );
      process.exit(2);
    }
    for (const s of stores) await doCall(args, s, 'markLive', {});
    if (args.global) {
      await d1Statements(d, [
        `INSERT INTO system_settings (id, key, value, category, is_public) VALUES (${lit(crypto.randomUUID())}, ${lit(GLOBAL)}, ${lit(JSON.stringify({ at: new Date().toISOString(), stores }))}, 'cutover', 0) ON CONFLICT (key) DO NOTHING;`,
      ]);
      console.log(
        'GLOBAL marker written: every DO store now serves customer auth from its StoreDO'
      );
    }
    await lift();
    console.log(
      `UNFROZEN; done in ${fmtMs(performance.now() - t0)}. Postgres digests unchanged since the copy (verified on a new connection).`
    );
  } catch (e) {
    const open = stores.filter(s => !flipped.has(s));
    await lift().catch(() => {});
    console.log(
      flipped.size
        ? `PARTIAL: flipped ${[...flipped].join(',')}; not flipped ${open.join(',') || '-'}.${frozenNow ? ' !!! the freeze is STILL UP: run --unfreeze' : ''}`
        : 'UNFROZEN (aborted before any flip)'
    );
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  });
