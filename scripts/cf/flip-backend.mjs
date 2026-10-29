#!/usr/bin/env node
// Phase 5: move stores between backends. D1 ebda-platform stores.storage_backend is the ONE switch:
// 'do' = StoreDO serves the store, 'pg' = Postgres (read-only fallback for 7 days after cutover).
//   node scripts/cf/flip-backend.mjs --to do --all --verify-report verify.json --d1 ebda-platform --d1-target remote --d1-config <wrangler.jsonc> --yes
//   node scripts/cf/flip-backend.mjs --to pg --all ... --replay-pg-url <writable owner url> --yes     (rollback)
//
// --to do   refuses unless a fresh passing verify report covers every store; seals each StoreDO, which also
//           records a per-row baseline of the whole DO, writes the flag, then records the same baseline of D1.
// --to pg   (Audit DB-1) NEVER drops live writes silently. It diffs every StoreDO and D1 against the baseline
//           taken at the flip. No change: flip. Changes: (a) REPLAY them into Postgres in ONE transaction and
//           commit only when Postgres and the live side then hold equal counts and checksums; or (b) if no
//           replay URL is given, or the replay or its verification fails (the transaction is rolled back,
//           Postgres is left exactly as it was), REFUSE and point at the forward-fix runbook
//           (docs/runbooks/cutover-cf.md section 9). --accept-data-loss <all|slug,...> is the explicit,
//           named override. --reset-do wipes the StoreDOs afterwards so a cutover can be retried.
// Without --yes it only prints the plan. The flag is a NEVER-stale read: the script polls --health-url until
// the /health storage_backend counts match, and fails if they do not within 60 s.
import fs from 'node:fs';
import { cli } from './lib/cli.mjs';
import { d1Query, d1QueryMany, lit } from './lib/d1.mjs';
import { diffAgainstBaseline, writeBaseline } from './lib/d1-baseline.mjs';
import { connectWritable } from './lib/pg.mjs';
import { loadPlan } from './lib/plan.mjs';
import { pgTypes, replayTable } from './lib/replay.mjs';
import { bindPlan, sourceDigest } from './lib/source.mjs';
import { TableDigest } from '../../packages/cf-migrate/src/canon.mjs';

const { args } = cli({
  to: { type: 'string' },
  yes: { type: 'boolean', default: false },
  d1: { type: 'string' },
  'd1-target': { type: 'string', default: 'local' },
  'd1-config': { type: 'string' },
  'persist-to': { type: 'string' },
  'verify-report': { type: 'string' },
  'health-url': { type: 'string' },
  'no-seal': { type: 'boolean', default: false },
  'replay-pg-url': { type: 'string' },
  'allow-prod-write': { type: 'boolean', default: false },
  'accept-data-loss': { type: 'string' },
  'reset-do': { type: 'boolean', default: false },
});
const d = {
  db: args.d1,
  target: args['d1-target'],
  config: args['d1-config'],
  persistTo: args['persist-to'],
};
const FORWARD_FIX =
  'docs/runbooks/cutover-cf.md section 9 (forward-fix): fix the problem on the Cloudflare side and keep serving from it';
const NOT_IN_PG = new Set(['entity_index', 'platform_audit_log']);
// The backend selector is the switch this script itself throws, not live data: it has no Postgres column by design and
// a rollback sets it back to 'pg', so a changed D1 stores row must not be refused for carrying it (Ruling CUTOVER-5).
const SELECTOR_COLUMNS = new Set(['stores.storage_backend']);

const doCall = async (id, op, body) => {
  const r = await fetch(`${args.doUrl}/cutover/stores/${id}/${op}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.secret}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
};

async function waitHealth(want) {
  if (!args['health-url'])
    return console.log('no --health-url: confirm /health storage_backend by hand before smoke');
  const t0 = Date.now();
  for (;;) {
    const h = await fetch(args['health-url'])
      .then(r => r.json())
      .catch(() => ({}));
    if (
      JSON.stringify(Object.entries(h.storage_backend ?? {}).sort()) ===
      JSON.stringify(Object.entries(want).sort())
    )
      break;
    if (Date.now() - t0 > 60_000)
      throw new Error(
        `/health still reports ${JSON.stringify(h.storage_backend)} after 60 s, expected ${JSON.stringify(want)}`
      );
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`/health agrees: ${JSON.stringify(want)}`);
}

async function setBackend(stores, to) {
  await d1Query(
    d,
    `UPDATE stores SET storage_backend = ${lit(to)} WHERE id IN (${stores.map(s => lit(s.id)).join(',')})`
  );
  const after = await d1Query(
    d,
    `SELECT storage_backend, COUNT(*) AS n FROM stores GROUP BY storage_backend`
  );
  console.log(`D1 now: ${JSON.stringify(after)}`);
  await waitHealth(Object.fromEntries(after.map(r => [r.storage_backend, r.n])));
}

const count = t => (t ? t.added.length + t.changed.length + t.deleted.length : 0);

async function collectChanges(stores, plan) {
  const perStore = {};
  for (const s of stores) {
    const r = await doCall(s.id, '__diff', null);
    if (!r.ok)
      throw new Error(`cannot enumerate changes of ${s.slug}: HTTP ${r.status} ${r.j.error ?? ''}`);
    perStore[s.slug] = r.j.tables;
  }
  const platform = await diffAgainstBaseline(d, plan.platform);
  return { perStore, platform };
}

function summarize({ perStore, platform }) {
  const lines = [];
  let total = 0;
  for (const [slug, tables] of Object.entries(perStore))
    for (const [t, x] of Object.entries(tables)) {
      total += count(x);
      lines.push(`  ${slug}.${t}: +${x.added.length} ~${x.changed.length} -${x.deleted.length}`);
    }
  for (const [t, x] of Object.entries(platform)) {
    total += count(x);
    lines.push(`  D1.${t}: +${x.added.length} ~${x.changed.length} -${x.deleted.length}`);
  }
  return { total, lines };
}

/** replay every change into Postgres in ONE transaction; commit only when both sides then agree */
async function replayAndVerify(stores, plan, changes) {
  const client = await connectWritable(args['replay-pg-url'] ?? process.env.CUTOVER_REPLAY_PG_URL, {
    allowProd: args['allow-prod-write'],
  });
  try {
    const bound = await bindPlan(client, plan);
    const types = await pgTypes(client);
    const storeBy = new Map(bound.store.tables.map(t => [t.name, t]));
    const platBy = new Map(bound.platform.tables.map(t => [t.name, t]));
    const report = [];
    const lossy = [];

    const run = async (by, diffTables, order, tag, storeId, all) => {
      for (const phase of ['upsert', 'delete']) {
        const names = phase === 'upsert' ? order : [...order].reverse();
        for (const name of names) {
          const x = diffTables[name];
          if (!x) continue;
          const bt = by.get(name);
          if (!bt) {
            if (!NOT_IN_PG.has(name))
              report.push(
                `${tag}.${name}: Cloudflare-only table, ${count(x)} change(s) not replayed`
              );
            continue;
          }
          if (name === 'stores' && (x.added.length || x.deleted.length))
            throw new Error(
              'a store was created or deleted on the live side after the flip: not replayable'
            );
          const n = await replayTable(client, types, bt, x, phase, {
            storeId,
            allowed: new Set(stores.map(s => s.id)),
            all,
          });
          if (phase === 'upsert') {
            for (const col of n.skippedCols) {
              const i = x.columns.indexOf(col);
              const hits = [...x.added, ...x.changed].filter(
                r => r[i] !== null && r[i] !== undefined
              ).length;
              if (hits && !SELECTOR_COLUMNS.has(`${name}.${col}`))
                lossy.push(`${tag}.${name}.${col}: ${hits} row(s) with data, no Postgres column`);
            }
          }
          if (n.upserted || n.deleted)
            report.push(`${tag}.${name}: ${n.upserted} upserted, ${n.deleted} deleted`);
        }
      }
    };
    await run(
      platBy,
      changes.platform,
      plan.platform.map(t => t.name),
      'D1',
      null,
      plan.platform
    );
    for (const s of stores)
      await run(
        storeBy,
        changes.perStore[s.slug] ?? {},
        plan.store.map(t => t.name),
        s.slug,
        s.id,
        plan.store
      );
    report.forEach(l => console.log('  replay ' + l));
    if (lossy.length && !args['accept-data-loss'])
      throw new Error(`live-side data with no Postgres column would be lost: ${lossy.join('; ')}`);

    // verification INSIDE the transaction: Postgres (with the replay applied) must equal the live side
    let bad = 0;
    for (const s of stores) {
      const tables = bound.store.tables;
      const src = {};
      for (const bt of tables)
        src[bt.name] = await sourceDigest(client, bt, plan.store, 'store', s.id);
      const r = await doCall(s.id, '__verify', {
        fk: true,
        tables: tables.map(bt => ({
          table: bt.name,
          columns: bt.columns.map(c => c.col),
          pk: bt.pk,
        })),
      });
      if (!r.ok) throw new Error(`verify ${s.slug}: HTTP ${r.status} ${r.j.error ?? ''}`);
      for (const bt of tables) {
        const a = src[bt.name];
        const b = r.j.tables[bt.name];
        if (a.count !== b.count || a.digest !== b.digest) {
          bad++;
          console.log(
            `  MISMATCH ${s.slug}.${bt.name}: Postgres ${a.count} rows vs live ${b.count} rows`
          );
        }
      }
    }
    const res = await d1QueryMany(
      d,
      bound.platform.tables.map(
        bt =>
          `SELECT ${bt.columns.map(c => `"${c.col}"`).join(', ')} FROM "${bt.name}" ORDER BY ${bt.pk.map(k => `"${k}"`).join(', ')}`
      )
    );
    for (const [i, bt] of bound.platform.tables.entries()) {
      const names = bt.columns.map(c => c.col);
      const dg = new TableDigest();
      for (const r of res[i])
        await dg.add(
          names,
          names.map(c => r[c]),
          bt.pk
        );
      const a = await sourceDigest(client, bt, plan.platform, 'all');
      const b = await dg.finish();
      if (a.count !== b.count || a.digest !== b.digest) {
        bad++;
        console.log(`  MISMATCH D1.${bt.name}: Postgres ${a.count} rows vs live ${b.count} rows`);
      }
    }
    if (bad) throw new Error(`${bad} table(s) differ after the replay`);
    await client.query('COMMIT');
    console.log('replay committed: Postgres and the live side hold equal counts and checksums');
    for (const s of stores) await doCall(s.id, '__rebase', null);
    await writeBaseline(d, plan.platform);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(
      `replay FAILED and was rolled back (Postgres is unchanged): ${e.message}. Rollback refused: ${FORWARD_FIX}`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  if (!['do', 'pg'].includes(args.to)) throw new Error('--to do|pg');
  if (!args.d1) throw new Error('pass --d1 <database>');
  if (!args.all && !args.store) throw new Error('pass --all or --store <id|slug>[,<id|slug>...]');

  const col = await d1Query(
    d,
    `SELECT name FROM pragma_table_info('stores') WHERE name = 'storage_backend'`
  );
  if (!col.length)
    throw new Error(
      'D1 stores has no storage_backend column: the backend selector (plan task 2.4) is not deployed to this database'
    );
  const refs = args.store ? args.store.split(',') : null;
  const where = refs
    ? `WHERE id IN (${refs.map(lit).join(',')}) OR slug IN (${refs.map(lit).join(',')})`
    : '';
  const stores = await d1Query(
    d,
    `SELECT id, slug, storage_backend FROM stores ${where} ORDER BY slug`
  );
  if (!stores.length || (refs && stores.length < refs.length))
    throw new Error(`resolved ${stores.length} stores for ${refs ? refs.length : 'all'} requested`);
  console.log(
    `${stores.length} store(s) to '${args.to}': ${stores.map(s => `${s.slug}(${s.storage_backend})`).join(', ')}`
  );
  const plan = loadPlan();

  if (args.to === 'do') {
    if (!args['verify-report'])
      throw new Error('--to do needs --verify-report <file written by verify-store.mjs --report>');
    const v = JSON.parse(fs.readFileSync(args['verify-report'], 'utf8'));
    if (!v.ok) throw new Error('the verify report is not ok');
    if (!v.at || Date.now() - Date.parse(v.at) > 60 * 60 * 1000)
      throw new Error('the verify report is older than 60 minutes: re-run verify-store.mjs');
    const covered = new Set(v.results.map(r => r.label.replace(/^store /, '')));
    const missing = stores.filter(s => !covered.has(s.slug));
    if (missing.length)
      throw new Error(`verify report does not cover: ${missing.map(s => s.slug).join(', ')}`);
  }
  if (!args.yes) return console.log('dry plan only: pass --yes to apply');
  if (args.to === 'pg' || !args['no-seal'])
    if (!args.doUrl || !args.secret)
      throw new Error('needs CUTOVER_DO_URL and CUTOVER_IMPORT_SECRET');

  if (args.to === 'do') {
    if (!args['no-seal']) {
      for (const s of stores) {
        const r = await doCall(s.id, '__seal', null);
        if (!r.ok) throw new Error(`seal ${s.slug}: HTTP ${r.status}`);
      }
      console.log(
        'sealed + baselined: no further imports can reach these StoreDOs, and every later write is detectable'
      );
    }
    await setBackend(stores, 'do');
    const n = await writeBaseline(d, plan.platform);
    console.log(`D1 baseline recorded (${n} rows)`);
    return;
  }

  // ---- rollback to Postgres ----
  const changes = await collectChanges(stores, plan);
  const { total, lines } = summarize(changes);
  if (total === 0)
    console.log(
      'no write happened on the Cloudflare side since the flip: the rollback loses nothing'
    );
  else {
    console.log(`${total} row change(s) happened on the Cloudflare side since the flip:`);
    lines.forEach(l => console.log(l));
    const accepted = args['accept-data-loss'];
    if (accepted) {
      const ok =
        accepted === 'all' ||
        stores.every(
          s =>
            accepted.split(',').includes(s.slug) ||
            !Object.keys(changes.perStore[s.slug] ?? {}).length
        );
      if (!ok)
        throw new Error(`--accept-data-loss does not name every affected store. ${FORWARD_FIX}`);
      console.warn(
        `WARNING: --accept-data-loss: ${total} row change(s) are DISCARDED by this rollback`
      );
    } else if (!(args['replay-pg-url'] ?? process.env.CUTOVER_REPLAY_PG_URL)) {
      throw new Error(
        `rollback REFUSED: ${total} write(s) exist only on the Cloudflare side and no --replay-pg-url was given to carry them back. ${FORWARD_FIX}`
      );
    } else await replayAndVerify(stores, plan, changes);
  }
  await setBackend(stores, 'pg');
  if (args['reset-do']) {
    for (const s of stores) {
      const r = await doCall(s.id, '__unseal', { confirm: 'wipe-and-unseal' });
      if (!r.ok) throw new Error(`unseal ${s.slug}: HTTP ${r.status} ${r.j.error ?? ''}`);
    }
    await d1QueryMany(d, ['DROP TABLE IF EXISTS cf_seal_baseline']);
    console.log(
      'StoreDOs wiped and unsealed: re-run migrate-store-to-do + verify to retry the cutover'
    );
  } else
    console.log(
      'StoreDOs stay sealed with their data (nothing deleted); pass --reset-do to wipe them before a retry'
    );
}

main().catch(e => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
