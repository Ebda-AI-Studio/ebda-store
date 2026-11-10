#!/usr/bin/env node
// Nightly backup (Rulings NZ-BACKUP-1, ICEBERG-BK-1/2). Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, EBDA_BACKUP_AGE_PUBLIC_KEY,
// BACKUP_EXPORT_SECRET, optional EBDA_API_URL (default https://api.ebda.app), EBDA_BACKUP_CF_CAP_BYTES (default 1 GiB),
// EBDA_BACKUP_MEDIA_CAP_BYTES (default 10 GiB). D1 ebda-platform + ebda-identity + StoreDOs, then R2 ebda-media incrementally.
// Exit 0 only when everything was stored, read back and both size guards are clean. Writes the report to $GITHUB_STEP_SUMMARY.
import { appendFileSync } from 'node:fs';
import { runBackup, backupMedia, DEFAULT_CAP_BYTES, DEFAULT_MEDIA_CAP_BYTES } from './lib/cf-backup.mjs';
import { realBackupIo, restMediaIo, wranglerR2 } from './lib/cf-backup-io.mjs';

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
const token = need('CLOUDFLARE_API_TOKEN');
const accountId = need('CLOUDFLARE_ACCOUNT_ID');
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const io = realBackupIo({
  log,
  recipient: need('EBDA_BACKUP_AGE_PUBLIC_KEY'),
  apiUrl: process.env.EBDA_API_URL || 'https://api.ebda.app',
  secret,
  r2: wranglerR2(),
  media: restMediaIo({ accountId, token }),
});
const summary = md => {
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
};
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
  `- artifacts: ${report.artifacts} (D1 ebda-platform + D1 ebda-identity + ${report.stores} stores), ${report.reused} unchanged and referenced, not re-uploaded`,
  `- raw ${mib(report.rawBytes)} MiB, compressed ${mib(report.gzBytes)} MiB, uploaded this run ${mib(report.uploadedBytes)} MiB`,
  `- cf/ estimated total ${mib(report.estimatedCfTotalBytes)} MiB of cap ${mib(report.capBytes)} MiB (from cf/ledger.json)`,
  ...report.problems.map(p => `- PROBLEM: ${p}`),
].join('\n');
summary(md);

// Media runs after the databases are safe: a media failure fails the job (and alerts) but never costs the DB backup.
const mediaCap = Number(process.env.EBDA_BACKUP_MEDIA_CAP_BYTES) || DEFAULT_MEDIA_CAP_BYTES;
let media;
try {
  media = await backupMedia({ io, cap: mediaCap, log });
} catch (e) {
  console.error(`::error::media backup failed: ${(e?.message ?? String(e)).split('\n')[0]}`);
  summary(`### media backup FAILED\n- ${e?.message ?? e}`);
  process.exit(1);
}
summary(
  [
    `### media backup (R2 ebda-media -> media/): ${media.ok ? 'OK' : 'SIZE GUARD FAILED'}`,
    `- ${media.sourceObjects} source objects: ${media.copied} copied, ${media.unchanged} unchanged, ${media.markedDeleted} newly marked deleted`,
    `- uploaded this run ${mib(media.uploadedBytes)} MiB, media/ total ${mib(media.totalBytes)} MiB of cap ${mib(media.capBytes)} MiB`,
    ...media.problems.map(p => `- PROBLEM: ${p}`),
  ].join('\n')
);
process.exit(report.ok && media.ok ? 0 : 1);
