/**
 * R2 Orphan Audit
 * ===============
 *
 * Read-only inventory of every object in the configured Cloudflare R2 bucket
 * vs. every URL referenced anywhere in the database. Anything in the bucket
 * that no live row points to is reported as an "orphan" so the merchant can
 * decide whether to delete it. **The script never deletes anything.**
 *
 * Run it manually:
 *
 *   tsx scripts/r2-orphan-audit.ts
 *
 * Required environment variables (same names the API uses, see
 * apps/api/src/config/index.ts):
 *
 *   STORAGE_ENDPOINT     R2 S3-compatible endpoint
 *                        (e.g. https://<account>.r2.cloudflarestorage.com)
 *   STORAGE_ACCESS_KEY   R2 access key id
 *   STORAGE_SECRET_KEY   R2 secret access key
 *   STORAGE_BUCKET       R2 bucket name (default: "uploads")
 *   STORAGE_PUBLIC_URL   Public base URL stored in DB rows
 *                        (e.g. https://pub-xxx.r2.dev). Used to map a
 *                        DB-stored URL back to its R2 key.
 *   DATABASE_URL         Prisma connection string
 *
 * Output:
 *   - Stats printed to stdout: total keys, total bytes, orphan count,
 *     orphan bytes.
 *   - Full orphan key list written to /tmp/r2-orphans-<timestamp>.txt,
 *     one key per line. The merchant reviews this file before deleting.
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import {
  collectReferencedR2Keys,
  type R2ReferenceDb,
  type R2ReferenceRunner,
} from '../apps/api/src/lib/r2-references';

interface R2Object {
  key: string;
  size: number;
  lastModified?: Date;
}

interface AuditResult {
  totalKeys: number;
  totalBytes: number;
  orphanKeys: string[];
  orphanBytes: number;
  /** Keys we deliberately skipped because they were too fresh — likely
   *  in-flight uploads whose DB row hasn't landed yet. */
  skippedRecent: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * Page through every object in the bucket and collect (key, size) pairs.
 */
async function listAllR2Objects(client: S3Client, bucket: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of response.Contents ?? []) {
      if (obj.Key) {
        objects.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * Convert a DB-stored URL back to its R2 object key, or null if the URL is
 * external / malformed. Mirrors `StorageService.getKeyFromUrl` but without
 * the import dependency since this script runs standalone.
 */
function urlToKey(
  url: string,
  publicBase: string,
  endpoint: string,
  bucket: string
): string | null {
  if (!url) return null;
  // Public URL form: https://pub-xxx.r2.dev/<key>
  if (publicBase && url.startsWith(publicBase + '/')) {
    return url.slice(publicBase.length + 1);
  }
  // Endpoint form: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
  const endpointPrefix = `${endpoint}/${bucket}/`;
  if (url.startsWith(endpointPrefix)) {
    return url.slice(endpointPrefix.length);
  }
  return null;
}

/**
 * Every R2 key referenced by any live row. The column set is the shared
 * registry `R2_REFERENCE_COLUMNS` (apps/api/src/lib/r2-references.ts), the
 * same one the weekly sweep and the per-URL cleanup read. It used to be a
 * hand-written list here that never read `Store.pwaSettings` — so `--apply`
 * would have deleted every live PWA icon and favicon. A new URL-bearing
 * column is added to the registry, and tests/unit/r2-reference-registry.test.ts
 * fails until it is.
 */
async function collectReferencedKeys(
  run: R2ReferenceRunner,
  publicBase: string,
  endpoint: string,
  bucket: string
): Promise<Set<string>> {
  return collectReferencedR2Keys({
    run,
    toKey: url => urlToKey(url, publicBase, endpoint, bucket),
  });
}

/**
 * The same privilege the weekly sweep uses (`withRlsBypass`,
 * r2-orphan-sweep.ts), rebuilt on this script's own client so it does not pull
 * in the API. This is the only delete-capable collector, and it used to read
 * the registry with a bare client — no tenant context, no bypass (issue 2251).
 * Harmless while production connects as the table owner; the moment the
 * Phase 3 force_app cutover flips DATABASE_URL, a contextless read of a STRICT
 * table returns zero rows, every blog cover / expense receipt / stock-adjustment
 * photo / how-to image reads as an orphan, and `--apply` deletes them from R2
 * irreversibly. One transaction per page, like the sweep.
 */
export function rlsBypassRunner(prisma: Pick<PrismaClient, '$transaction'>): R2ReferenceRunner {
  return fn =>
    prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SET LOCAL app.bypass_rls = 'true'`;
        // Reset a stale session-level store id so old-style policies
        // (`current_store_id() IS NULL`) allow all rows too — same as
        // withRlsBypass in @force/database.
        await tx.$executeRaw`SET LOCAL app.current_store_id = ''`;
        return fn(tx as unknown as R2ReferenceDb);
      },
      { maxWait: 10_000, timeout: 30_000 }
    );
}

/**
 * Registry tables whose RLS policy is STRICT — no contextless allowance, so a
 * read without the bypass sees nothing (the pinned list is STRICT_TABLES in
 * tests/integration/rls-force-app.test.ts; tests/unit/r2-orphan-classify.test.ts
 * keeps this in step with it and the registry).
 */
export const STRICT_R2_TABLES = ['blog_posts', 'expenses', 'stock_adjustments', 'store_howtos'];

/**
 * Last line before an irreversible delete (issue 2251): through the SAME
 * runner the collection used, every STRICT registered table must show rows
 * whenever the catalog (pg_class.reltuples, which RLS does not filter) says it
 * has any. Zero visible rows over a non-empty table means the read was
 * filtered, the referenced set is incomplete, and every key those rows point
 * to would be deleted as an "orphan". Refuse instead.
 */
export async function assertStrictTablesVisible(
  run: R2ReferenceRunner,
  catalog: R2ReferenceDb
): Promise<void> {
  for (const table of STRICT_R2_TABLES) {
    const [seen] = await run(db =>
      db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}"`)
    );
    const [est] = await catalog.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT GREATEST(c.reltuples, 0)::int AS n FROM pg_class c WHERE c.oid = $1::regclass`,
      `public.${table}`
    );
    if ((seen?.n ?? 0) === 0 && (est?.n ?? 0) > 0) {
      throw new Error(
        `REFUSING --apply: "${table}" shows 0 rows to the collector while the catalog estimates ` +
          `${est!.n}. RLS is filtering the registry read, so its R2 references are missing and ` +
          `would be deleted as orphans. Check the connection role / app.bypass_rls.`
      );
    }
  }
}

/**
 * Read CLI flags so the same script can run as a read-only audit OR
 * as an authoritative cleanup. Defaults are conservative: dry-run
 * (no deletes) and a 1-hour minimum age on any candidate key (so an
 * upload that landed in R2 a minute ago doesn't get reaped before the
 * DB row catches up).
 */
function parseArgs() {
  const apply = process.argv.includes('--apply');
  const minAgeArg = process.argv.find(a => a.startsWith('--min-age-hours='));
  const minAgeHours = minAgeArg ? Number(minAgeArg.split('=')[1]) : 1;
  return {
    apply,
    minAgeMs: Math.max(0, minAgeHours) * 60 * 60 * 1000,
    minAgeHours: Math.max(0, minAgeHours),
  };
}

/**
 * Decide which listed objects are deletable orphans.
 *
 * Pure and separated from the audit for one reason: the min-age window is a
 * DATA-LOSS guard, not a tuning knob. It protects the race where a file has been
 * PUT to R2 but the DB row carrying its URL has not been written yet — without
 * it, a cleanup running mid-upload wipes a freshly-uploaded image, which is the
 * failure mode that may have produced Palora's missing covers. A guard that
 * cannot be tested is a guard nobody can trust.
 *
 * An object with NO lastModified is treated as infinitely old, matching the
 * original behaviour: it is deletable if unreferenced.
 */
export function classifyOrphans(
  objects: R2Object[],
  referenced: Set<string>,
  minAgeMs: number,
  now: number
): { orphans: string[]; orphanBytes: number; totalBytes: number; skippedRecent: number } {
  const orphans: string[] = [];
  let orphanBytes = 0;
  let totalBytes = 0;
  let skippedRecent = 0;

  for (const obj of objects) {
    totalBytes += obj.size;
    if (referenced.has(obj.key)) continue;

    const ageMs = obj.lastModified ? now - obj.lastModified.getTime() : Infinity;
    if (ageMs < minAgeMs) {
      skippedRecent++;
      continue;
    }

    orphans.push(obj.key);
    orphanBytes += obj.size;
  }

  return { orphans, orphanBytes, totalBytes, skippedRecent };
}

/** R2's S3-compatible API caps DeleteObjects batches at 1000 keys. */
export const DELETE_BATCH_SIZE = 1000;

async function deleteKeysInBatches(
  client: S3Client,
  bucket: string,
  keys: string[]
): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const slice = keys.slice(i, i + DELETE_BATCH_SIZE);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: slice.map(Key => ({ Key })), Quiet: true },
      })
    );
    console.log(`  deleted ${Math.min(i + DELETE_BATCH_SIZE, keys.length)}/${keys.length}`);
  }
}

async function audit(): Promise<AuditResult> {
  const endpoint = requireEnv('STORAGE_ENDPOINT');
  const accessKey = requireEnv('STORAGE_ACCESS_KEY');
  const secretKey = requireEnv('STORAGE_SECRET_KEY');
  const bucket = process.env.STORAGE_BUCKET || 'uploads';
  const publicBase = process.env.STORAGE_PUBLIC_URL || '';
  const { apply, minAgeMs, minAgeHours } = parseArgs();

  const client = new S3Client({
    endpoint,
    region: 'auto',
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true,
  });

  console.log('Listing R2 objects...');
  const objects = await listAllR2Objects(client, bucket);
  console.log(`Found ${objects.length} objects in bucket "${bucket}".`);

  const prisma = new PrismaClient();
  try {
    console.log('Collecting referenced keys from database...');
    const run = rlsBypassRunner(prisma);
    const referenced = await collectReferencedKeys(run, publicBase, endpoint, bucket);
    console.log(`Found ${referenced.size} referenced keys in database.`);

    const { orphans, orphanBytes, totalBytes, skippedRecent } = classifyOrphans(
      objects,
      referenced,
      minAgeMs,
      Date.now()
    );

    if (apply && orphans.length > 0) {
      await assertStrictTablesVisible(run, prisma);
      console.log(
        `\n--apply set: deleting ${orphans.length} orphan keys (min-age ${minAgeHours}h)…`
      );
      await deleteKeysInBatches(client, bucket, orphans);
    }

    return {
      totalKeys: objects.length,
      totalBytes,
      orphanKeys: orphans,
      orphanBytes,
      skippedRecent,
    };
  } finally {
    await prisma.$disconnect();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

// Only run when invoked directly. Without this guard, importing anything from
// this file (e.g. classifyOrphans in a unit test) EXECUTES the audit and calls
// process.exit(1) on the first missing env var — which is why the delete guard
// had no test until now.
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /r2-orphan-audit\.[tj]s$/.test(process.argv[1]);

if (isDirectRun) {
  audit()
    .then(result => {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const outPath = path.join('/tmp', `r2-orphans-${ts}.txt`);
      fs.writeFileSync(outPath, result.orphanKeys.join('\n') + '\n');

      const apply = process.argv.includes('--apply');
      console.log('');
      console.log('=== R2 Orphan Audit ===');
      console.log(`Total keys:       ${result.totalKeys}`);
      console.log(`Total bytes:      ${formatBytes(result.totalBytes)}`);
      console.log(`Orphan count:     ${result.orphanKeys.length}`);
      console.log(`Orphan bytes:     ${formatBytes(result.orphanBytes)}`);
      console.log(`Skipped (fresh):  ${result.skippedRecent}`);
      console.log(`Orphan list:      ${outPath}`);
      console.log('');
      if (apply) {
        console.log('Applied: orphan objects above were deleted from R2.');
      } else {
        console.log('Dry run. Pass --apply to delete the orphans listed above.');
        console.log('Pass --min-age-hours=N (default 1) to widen the safety window.');
      }
    })
    .catch(err => {
      console.error('Audit failed:', err);
      process.exit(1);
    });
}
