#!/usr/bin/env node
// Phase 5: move stores between backends. D1 ebda-platform stores.storage_backend is the ONE switch:
// 'do' = StoreDO serves the store, 'pg' = Postgres (read-only fallback for 7 days after cutover).
//   node scripts/cf/flip-backend.mjs --to do --all --verify-report verify.json --d1 ebda-platform --d1-target remote --d1-config <wrangler.jsonc> --yes
//   node scripts/cf/flip-backend.mjs --to pg --all ... --yes            (rollback)
// --to do refuses unless the verify report is ok, fresh (<= 60 min) and covers every store being flipped,
// then seals each StoreDO (no further imports) BEFORE the flag moves. Without --yes it only prints the plan.
// The flag is a NEVER-stale read: after the write the script polls --health-url (the /health
// storage_backend counts) until the counts match, and fails if they do not within 60 s.
import fs from 'node:fs';
import { cli } from './lib/cli.mjs';
import { d1Query, lit } from './lib/d1.mjs';

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
});
const d = {
  db: args.d1,
  target: args['d1-target'],
  config: args['d1-config'],
  persistTo: args['persist-to'],
};

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

  if (args.to === 'do' && !args['no-seal']) {
    if (!args.doUrl || !args.secret)
      throw new Error('sealing needs CUTOVER_DO_URL and CUTOVER_IMPORT_SECRET');
    for (const s of stores) {
      const r = await fetch(`${args.doUrl}/cutover/stores/${s.id}/__seal`, {
        method: 'POST',
        headers: { authorization: `Bearer ${args.secret}` },
      });
      if (!r.ok) throw new Error(`seal ${s.slug}: HTTP ${r.status}`);
    }
    console.log('sealed: no further imports can reach these StoreDOs');
  }
  await d1Query(
    d,
    `UPDATE stores SET storage_backend = ${lit(args.to)} WHERE id IN (${stores.map(s => lit(s.id)).join(',')})`
  );
  const after = await d1Query(
    d,
    `SELECT storage_backend, COUNT(*) AS n FROM stores GROUP BY storage_backend`
  );
  console.log(`D1 now: ${JSON.stringify(after)}`);

  if (args['health-url']) {
    const want = Object.fromEntries(after.map(r => [r.storage_backend, r.n]));
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
  } else console.log('no --health-url: confirm /health storage_backend by hand before smoke');
}

main().catch(e => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
