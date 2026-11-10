#!/usr/bin/env node
// Orphan merchant identities left by the 2026-11-10 signup 500: unverified, '!pending' hash, created that day.
// The Store profile table is gone from the Worker (NZ-D23), so "no profile row" holds for every such row.
// Dry-run by default; --apply deletes ONLY the rows the same SELECT returns (FKs cascade). Never prints a hash.
// Usage: node scripts/ops/identity-orphan-cleanup.mjs [--apply] [--day=2026-11-10]
import { execFileSync } from 'node:child_process';

const apply = process.argv.includes('--apply');
const day = (process.argv.find(a => a.startsWith('--day=')) ?? '--day=2026-11-10').slice(6);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('bad --day');
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: '69188202efc4df480140dd76545aa3ab' };
const d1 = sql =>
  JSON.parse(
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'ebda-identity', '--remote', '--json', '--command', sql],
      { env, encoding: 'utf8', cwd: new URL('../../apps/accounts/', import.meta.url).pathname }
    )
  )[0].results;
const mask = e => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');
const SCOPE = `password_hash = '!pending' AND email_verified = 0`;
const rows = () => d1(`SELECT id, email, created_at FROM users WHERE ${SCOPE} ORDER BY created_at`);

const before = rows();
const stray = before.filter(r => !String(r.created_at).startsWith(day));
console.log(`before: ${before.length} unverified+pending rows`);
for (const r of before) console.log(`  ${mask(r.email)}  ${r.created_at}`);
if (stray.length) {
  console.error(`STOP: ${stray.length} row(s) not created on ${day}; nothing deleted.`);
  process.exit(2);
}
if (!apply) {
  console.log('dry-run: pass --apply to delete the rows above');
  process.exit(0);
}
if (before.length) {
  const ids = before.map(r => `'${String(r.id).replace(/[^0-9a-f-]/gi, '')}'`).join(',');
  d1(`DELETE FROM users WHERE id IN (${ids}) AND ${SCOPE}`);
}
console.log(`after: ${rows().length} rows`);
