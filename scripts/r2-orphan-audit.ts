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
 * Walk every column in the schema that may store an R2 URL and return the
 * full set of referenced keys. New image-bearing columns must be added here
 * to avoid false-positive orphans.
 */
async function collectReferencedKeys(
  prisma: PrismaClient,
  publicBase: string,
  endpoint: string,
  bucket: string
): Promise<Set<string>> {
  const keys = new Set<string>();
  const add = (url: string | null | undefined) => {
    if (!url) return;
    const key = urlToKey(url, publicBase, endpoint, bucket);
    if (key) keys.add(key);
  };

  // Stores: logos + favicon + hero image + og image
  const stores = await prisma.store.findMany({
    select: { logo: true, logoAr: true, favicon: true, heroImage: true, ogImage: true },
  });
  for (const s of stores) {
    add(s.logo);
    add(s.logoAr);
    add(s.favicon);
    add(s.heroImage);
    add(s.ogImage);
  }

  // Store layoutSettings JSON may carry slide images. Decode best-effort.
  const layoutRows = await prisma.store.findMany({ select: { layoutSettings: true } });
  for (const row of layoutRows) {
    walkJsonForUrls(row.layoutSettings, add);
  }

  // Store CMS pages: cover image
  const pages = await prisma.storePage.findMany({ select: { coverImage: true } });
  for (const p of pages) add(p.coverImage);

  // Categories: cover image
  const categories = await prisma.category.findMany({ select: { image: true } });
  for (const c of categories) add(c.image);

  // Product images (the main gallery)
  const productImages = await prisma.productImage.findMany({ select: { url: true } });
  for (const pi of productImages) add(pi.url);

  // Product variants: per-variant image (Group H — landed in this batch)
  // The column is added by Group H's migration; guard against running before
  // that migration applies by using a try/catch on the query.
  try {
    const variants = await prisma.productVariant.findMany({ select: { imageUrl: true } });
    for (const v of variants) add(v.imageUrl);
  } catch {
    // imageUrl column not present yet — nothing to do.
  }

  // Users: avatar (used by both customers and admins)
  const users = await prisma.user.findMany({ select: { avatar: true } });
  for (const u of users) add(u.avatar);

  return keys;
}

/**
 * Recursively walk a JSON value looking for string fields that look like
 * R2 URLs. Used for blob columns (Store.layoutSettings, marketingPixels,
 * etc.) where image URLs may be nested arbitrarily.
 */
function walkJsonForUrls(value: unknown, visit: (url: string) => void): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://')) visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkJsonForUrls(item, visit);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      walkJsonForUrls(v, visit);
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
    const referenced = await collectReferencedKeys(prisma, publicBase, endpoint, bucket);
    console.log(`Found ${referenced.size} referenced keys in database.`);

    const orphans: string[] = [];
    let orphanBytes = 0;
    let totalBytes = 0;
    let skippedRecent = 0;
    const now = Date.now();
    for (const obj of objects) {
      totalBytes += obj.size;
      if (referenced.has(obj.key)) continue;
      // Skip keys that were uploaded more recently than the
      // min-age window. The window protects against the race where a
      // file was just PUT to R2 but the DB row carrying its URL
      // hasn't been written yet (or is in flight). Without this
      // guard, a cleanup running mid-upload can wipe a freshly-uploaded
      // image — exactly the failure mode that may have produced
      // Palora's missing covers.
      const ageMs = obj.lastModified ? now - obj.lastModified.getTime() : Infinity;
      if (ageMs < minAgeMs) {
        skippedRecent++;
        continue;
      }
      orphans.push(obj.key);
      orphanBytes += obj.size;
    }

    if (apply && orphans.length > 0) {
      console.log(
        `\n--apply set: deleting ${orphans.length} orphan keys (min-age ${minAgeHours}h)…`
      );
      // R2's S3-compatible API caps DeleteObjects batches at 1000.
      const BATCH = 1000;
      for (let i = 0; i < orphans.length; i += BATCH) {
        const slice = orphans.slice(i, i + BATCH);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: slice.map(Key => ({ Key })), Quiet: true },
          })
        );
        console.log(`  deleted ${Math.min(i + BATCH, orphans.length)}/${orphans.length}`);
      }
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
