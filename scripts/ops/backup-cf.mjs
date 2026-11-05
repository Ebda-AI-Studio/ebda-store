#!/usr/bin/env node
// Nightly off-Cloudflare backup (Ruling NZ-BACKUP-1). Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, EBDA_BACKUP_AGE_PUBLIC_KEY,
// BACKUP_EXPORT_SECRET, optional EBDA_API_URL (default https://api.ebda.app), EBDA_BACKUP_CF_CAP_BYTES (default 1 GiB).
// Exit 0 only when everything was stored, read back and the size guard is clean. Writes the report to $GITHUB_STEP_SUMMARY.
import { appendFileSync } from 'node:fs';
import { runBackup, DEFAULT_CAP_BYTES } from './lib/cf-backup.mjs';
import { realBackupIo, wranglerR2 } from './lib/cf-backup-io.mjs';

const need = n => {
  const v = process.env[n];
  if (!v) {
    console.error(`::error::${n} is not set`);
    process.exit(2);
  }
  return v;
};
const secret = need('BACKUP_EXPORT_SECRET');
if (secret.length < 24) {
  console.error('::error::BACKUP_EXPORT_SECRET must be 24+ characters');
  process.exit(2);
}
need('CLOUDFLARE_API_TOKEN');
need('CLOUDFLARE_ACCOUNT_ID');
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const io = realBackupIo({
  log,
  recipient: need('EBDA_BACKUP_AGE_PUBLIC_KEY'),
  apiUrl: process.env.EBDA_API_URL || 'https://api.ebda.app',
  secret,
  r2: wranglerR2(),
});
const cap = Number(process.env.EBDA_BACKUP_CF_CAP_BYTES) || DEFAULT_CAP_BYTES;
let report;
try {
  report = await runBackup({ io, cap, log });
} catch (e) {
  const msg = `### cf backup FAILED\n- ${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ''}`;
  console.error(`::error::${(e?.message ?? String(e)).split('\n')[0]}`);
  console.error(msg);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, msg + '\n');
  process.exit(1);
}
const mib = n => (n / 1048576).toFixed(2);
const md = [
  `### cf backup ${report.day} (${report.tiers.join(', ')}): ${report.ok ? 'OK' : 'SIZE GUARD FAILED'}`,
  `- artifacts: ${report.artifacts} (D1 + ${report.stores} stores), ${report.reused} unchanged and referenced, not re-uploaded`,
  `- raw ${mib(report.rawBytes)} MiB, compressed ${mib(report.gzBytes)} MiB, uploaded this run ${mib(report.uploadedBytes)} MiB`,
  `- cf/ estimated total ${mib(report.estimatedCfTotalBytes)} MiB of cap ${mib(report.capBytes)} MiB (from cf/ledger.json)`,
  ...report.problems.map(p => `- PROBLEM: ${p}`),
].join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(report.ok ? 0 : 1);
