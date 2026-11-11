#!/usr/bin/env node
/**
 * Buyer-key backfill driver (Ruling WA-BRIDGE-BIND-3). Run it BEFORE setting WA_BRIDGE_REQUIRE_BUYER_PROOF=1 on ebda-api: it stamps
 * `orders.buyer_key` on every order that has a phone but no key, so the Chat bridge's buyer proof matches old orders too.
 *
 * Calls the super-admin endpoint POST /admin/wa/buyer-key-backfill in a loop, following `nextCursor` until the fleet is done.
 *   DRY RUN by default (counts per store, writes nothing):
 *     EBDA_ADMIN_TOKEN=<super_admin access token> node scripts/ops/backfill-buyer-keys.mjs
 *   Apply:  ... node scripts/ops/backfill-buyer-keys.mjs --apply
 * Options: --api <url> (default https://api.ebda.app) --budget <orders per call, <=2000, default 500> --store <uuid> --cursor-file <path>
 * Resumable: the cursor is saved after every call; rerun the same command to continue (delete the file to start over). Idempotent:
 * re-running never overwrites a stamped key.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export function parseArgs(argv) {
  const a = { apply: false, api: 'https://api.ebda.app', budget: 500, store: undefined, cursorFile: '.buyer-key-backfill.cursor' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') a.apply = true;
    else if (k === '--api') a.api = argv[++i];
    else if (k === '--budget') a.budget = Number(argv[++i]);
    else if (k === '--store') a.store = argv[++i];
    else if (k === '--cursor-file') a.cursorFile = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  if (!Number.isInteger(a.budget) || a.budget < 1 || a.budget > 2000) throw new Error('--budget must be an integer 1..2000');
  return a;
}

/** Drives the loop; `fetchFn`, `io` and `log` are injectable for tests. */
export async function drive(args, token, { fetchFn = fetch, io = { exists: existsSync, read: p => readFileSync(p, 'utf8'), write: writeFileSync, rm: unlinkSync }, log = console.log } = {}) {
  const failed = [];
  let cursor = io.exists(args.cursorFile) ? io.read(args.cursorFile).trim() || undefined : undefined;
  if (cursor) log(`resuming from saved cursor (${args.cursorFile})`);
  const totals = { scanned: 0, keyed: 0, noPhone: 0, openUnkeyed: 0, openUnkeyedNoPhone: 0, skippedStores: 0, calls: 0 };
  do {
    const res = await fetchFn(`${args.api}/api/v1/admin/wa/buyer-key-backfill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ dryRun: !args.apply, budget: args.budget, ...(cursor ? { cursor } : {}), ...(args.store ? { storeId: args.store } : {}) }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) throw new Error(`backfill call failed: ${res.status} ${JSON.stringify(body)?.slice(0, 300)}`);
    const d = body.data;
    totals.calls++;
    for (const k of ['scanned', 'keyed', 'noPhone', 'openUnkeyed', 'openUnkeyedNoPhone', 'skippedStores']) totals[k] += d.totals[k];
    for (const s of d.stores) log(`${d.dryRun ? 'would key' : 'keyed'} ${String(s.keyed).padStart(5)}  noPhone ${String(s.noPhone).padStart(5)}  openUnkeyed ${String(s.openUnkeyed ?? 0).padStart(4)}  scanned ${String(s.scanned).padStart(5)}  ${s.storeId}${s.skipped ? `  SKIPPED(${s.skipped})` : ''}${s.done ? '' : '  (partial)'}`);
    for (const f of d.failed ?? []) failed.push(f);
    cursor = d.nextCursor ?? undefined;
    if (cursor) io.write(args.cursorFile, cursor);
    else if (io.exists(args.cursorFile)) io.rm(args.cursorFile);
  } while (cursor);
  log(`${args.apply ? 'APPLIED' : 'DRY RUN'}: ${JSON.stringify(totals)}`);
  if (failed.length) log(`FAILED STORES (${failed.length}): ${failed.map(f => `${f.storeId}=${f.code}`).join(', ')}. Retry each with: node scripts/ops/backfill-buyer-keys.mjs ${args.apply ? '--apply ' : ''}--store <id> --cursor-file <another-file>`);
  log(`HEADLINE: ${totals.openUnkeyed} unpaid COD/InstaPay orders had NO buyer key (${totals.openUnkeyedNoPhone} of them have no usable phone and cannot be keyed by this script: fix those by hand before Chat #67 deploys).`);
  return totals;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.EBDA_ADMIN_TOKEN;
  if (!token) {
    console.error('set EBDA_ADMIN_TOKEN (a super_admin access token)');
    process.exit(2);
  }
  drive(parseArgs(process.argv.slice(2)), token).catch(e => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
