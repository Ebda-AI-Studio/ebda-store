#!/usr/bin/env node
/**
 * One-off (2026-11-11): cancel the subscription of every SOFT-DELETED store, so billing-renewal-daily and the reminder
 * job never select it. Found: `qa-merchant-test` (3f2bf043-...), status inactive, deleted, storage_backend `pg`
 * (pre-Postgres-removal leftover, 410 STORE_STORAGE_REMOVED), still holding a `growth` trial subscription.
 *
 * DRY-RUN by default (prints the rows). `--apply` runs the UPDATE. Needs CLOUDFLARE_ACCOUNT_ID and the platform D1 id:
 *   CLOUDFLARE_ACCOUNT_ID=... PLATFORM_DB_ID=<uuid> node scripts/ops/close-gone-store-subscriptions.mjs [--apply]
 * Reversible: the previous status is printed; restore with UPDATE store_subscriptions SET status='<old>' WHERE id='<id>'.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const id = process.env.PLATFORM_DB_ID;
if (!id || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error('set CLOUDFLARE_ACCOUNT_ID and PLATFORM_DB_ID');
  process.exit(2);
}
const apply = process.argv.includes('--apply');
const dir = mkdtempSync(join(tmpdir(), 'gone-subs-'));
writeFileSync(
  join(dir, 'wrangler.jsonc'),
  JSON.stringify({
    name: 'q',
    d1_databases: [{ binding: 'DB', database_name: 'ebda-platform', database_id: id }],
  })
);
const run = sql =>
  JSON.parse(
    (() => {
      const out = execFileSync(
        'npx',
        ['wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql],
        {
          cwd: dir,
          encoding: 'utf8',
        }
      );
      return out.slice(out.indexOf('['));
    })()
  )[0];
const WHERE = `store_id IN (SELECT id FROM stores WHERE deleted_at IS NOT NULL) AND status NOT IN ('canceled','comped')`;
const rows = run(
  `SELECT id, store_id, plan_code, status FROM store_subscriptions WHERE ${WHERE}`
).results;
console.log(apply ? 'APPLY' : 'DRY-RUN', JSON.stringify(rows, null, 2));
if (apply && rows.length) {
  const r = run(`UPDATE store_subscriptions SET status='canceled' WHERE ${WHERE}`);
  console.log('changed', r.meta.changes);
}
