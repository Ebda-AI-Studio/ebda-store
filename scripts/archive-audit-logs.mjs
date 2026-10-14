// Archive + delete old audit_logs rows.
//
// audit_logs grows monotonically — every admin write inserts a row.
// Without periodic archival the table eventually dominates DB size,
// and INSERT contention slows every admin write. This script keeps
// the working set small by deleting rows older than --days (default
// 90), with an optional --export to R2 first for compliance cover.
//
// Run from `apps/api/` so `@ebda/database` resolves and the
// STORAGE_* env vars are loaded.
//
// Usage:
//   node ../../scripts/archive-audit-logs.mjs                    # dry-run, count only
//   node ../../scripts/archive-audit-logs.mjs --apply             # delete (no archive)
//   node ../../scripts/archive-audit-logs.mjs --apply --export    # archive to R2 + delete
//   node ../../scripts/archive-audit-logs.mjs --days=30 --apply   # 30-day retention
//
// Suggested cron: weekly, with --apply --export. Configure in Railway:
//   railway run --service api -- node ../../scripts/archive-audit-logs.mjs --apply --export
import 'dotenv/config';
import { prisma } from '@ebda/database';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const DAYS_ARG = process.argv.find(a => a.startsWith('--days='));
const DAYS = DAYS_ARG ? Number(DAYS_ARG.split('=')[1]) : 90;
const APPLY = process.argv.includes('--apply');
const EXPORT_TO_R2 = process.argv.includes('--export');

if (!Number.isFinite(DAYS) || DAYS < 1) {
  console.error(`Invalid --days value: ${DAYS}. Must be >= 1.`);
  process.exit(1);
}

const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
console.log(`Cutoff: ${cutoff.toISOString()} (${DAYS} days)`);

const total = await prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } });
console.log(`Rows older than cutoff: ${total}`);

if (total === 0) {
  console.log('Nothing to archive. Done.');
  await prisma.$disconnect();
  process.exit(0);
}

if (!APPLY) {
  console.log(
    'DRY RUN — pass --apply to delete (and optionally --export to write a JSONL backup to R2 first).'
  );
  await prisma.$disconnect();
  process.exit(0);
}

if (EXPORT_TO_R2) {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const accessKey = process.env.STORAGE_ACCESS_KEY;
  const secretKey = process.env.STORAGE_SECRET_KEY;
  const bucket = process.env.STORAGE_BUCKET || 'uploads';
  if (!endpoint || !accessKey || !secretKey) {
    console.error('--export requires STORAGE_ENDPOINT / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const s3 = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });

  // Stream rows page-by-page to avoid loading 100k+ rows into memory.
  // Each page becomes one chunk of the multi-line JSONL output.
  const PAGE = 5000;
  let cursor = null;
  let written = 0;
  const chunks = [];
  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const r of rows) chunks.push(JSON.stringify(r) + '\n');
    written += rows.length;
    cursor = rows[rows.length - 1].id;
    process.stdout.write(`\rExported ${written}/${total}…`);
    if (rows.length < PAGE) break;
  }
  process.stdout.write('\n');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `audit-archive/${ts}-cutoff-${cutoff.toISOString().slice(0, 10)}.jsonl`;
  const body = Buffer.from(chunks.join(''), 'utf-8');
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/x-ndjson',
      ContentEncoding: 'utf-8',
    })
  );
  console.log(
    `✓ Archived ${written} rows to s3://${bucket}/${key} (${(body.length / 1024 / 1024).toFixed(1)} MB)`
  );
}

// Delete in batches so a 200k-row delete doesn't hold a lock long enough
// to stall live admin writes. Each batch is its own transaction; if the
// process is killed mid-run, future runs pick up where we left off.
const BATCH = 5000;
let deleted = 0;
while (true) {
  const result = await prisma.$executeRawUnsafe(
    `DELETE FROM "audit_logs" WHERE id IN (
       SELECT id FROM "audit_logs" WHERE "created_at" < $1 LIMIT ${BATCH}
     )`,
    cutoff
  );
  if (result === 0) break;
  deleted += result;
  process.stdout.write(`\rDeleted ${deleted}/${total}…`);
}
process.stdout.write('\n');
console.log(`✓ Deleted ${deleted} audit_logs rows older than ${cutoff.toISOString()}`);

await prisma.$disconnect();
