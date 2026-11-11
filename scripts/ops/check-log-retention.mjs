#!/usr/bin/env node
// READ-ONLY ops check (M-145): the "30 days" in docs/RETENTION.md for application logs rests on an R2 lifecycle
// rule on `ebda-logs`. This asks Cloudflare what the rule IS and fails when it is missing or longer than 30 days.
//
// Default is a DRY RUN: prints the one GET it would send and exits 0. Nothing is sent without --live.
//   node scripts/ops/check-log-retention.mjs                    dry run
//   CF_API_TOKEN=<R2 read> CF_ACCOUNT_ID=<id> node scripts/ops/check-log-retention.mjs --live [--bucket ebda-logs] [--max-days 30]
// Exit: 0 ok, 1 retention missing or too long, 2 could not run. The token needs R2 Read only; this script never writes.

export const DEFAULT_BUCKET = 'ebda-logs';
export const DEFAULT_MAX_DAYS = 30;

/** Shortest enabled whole-bucket expiry, in days, or null when no enabled rule expires objects. */
export function shortestExpiryDays(rules) {
  let best = null;
  for (const r of rules ?? []) {
    if (r?.enabled === false) continue;
    if (r?.conditions?.prefix) continue; // a prefix rule leaves the rest of the bucket unexpired
    const cond = r?.deleteObjectsTransition?.condition;
    if (cond?.type !== 'Age' || typeof cond.maxAge !== 'number') continue;
    const days = cond.maxAge / 86400;
    if (best === null || days < best) best = days;
  }
  return best;
}

export function evaluate(rules, maxDays = DEFAULT_MAX_DAYS) {
  const days = shortestExpiryDays(rules);
  if (days === null) return { ok: false, days, reason: 'no enabled whole-bucket expiry rule' };
  if (days > maxDays) return { ok: false, days, reason: `expires after ${days} days, limit ${maxDays}` };
  return { ok: true, days, reason: `expires after ${days} days` };
}

async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const bucket = opt('--bucket', DEFAULT_BUCKET);
  const maxDays = Number(opt('--max-days', DEFAULT_MAX_DAYS));
  const acct = process.env.CF_ACCOUNT_ID ?? '<CF_ACCOUNT_ID>';
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/r2/buckets/${bucket}/lifecycle`;
  if (!live) {
    console.log(`DRY RUN. Would GET ${url} (Bearer CF_API_TOKEN, R2 Read) and require an enabled whole-bucket expiry <= ${maxDays} days.`);
    return 0;
  }
  if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID) {
    console.error('CF_API_TOKEN and CF_ACCOUNT_ID are required with --live');
    return 2;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` } });
  if (!res.ok) {
    console.error(`lifecycle GET failed: HTTP ${res.status}`);
    return 2;
  }
  const body = await res.json();
  const verdict = evaluate(body?.result?.rules, maxDays);
  console.log(`${bucket}: ${verdict.ok ? 'OK' : 'FAIL'} - ${verdict.reason}`);
  return verdict.ok ? 0 : 1;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main().then(c => process.exit(c), e => (console.error(e), process.exit(2)));
