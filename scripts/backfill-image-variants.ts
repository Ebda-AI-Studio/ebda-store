/**
 * Backfill the webp width ladder for images uploaded before image variants
 * existed (docs/architecture/image-variants.md, ruling PERF-STORE-3).
 *
 * DRY RUN BY DEFAULT: nothing is written without --apply. Never deletes anything.
 * Idempotent and resumable: an original that already has every rung is skipped.
 *
 *   tsx scripts/backfill-image-variants.ts                      # dry run, whole stores/ prefix
 *   tsx scripts/backfill-image-variants.ts --prefix stores/<id>/ --limit 20
 *   tsx scripts/backfill-image-variants.ts --apply --concurrency 4
 *   tsx scripts/backfill-image-variants.ts --apply --start-after <last key printed by the previous run>
 *
 * Flags: --apply · --limit N (max originals to generate for) · --concurrency N (default 4)
 *        --prefix <p> (default stores/) · --start-after <key>
 *
 * Env (same as the API / r2-orphan-audit): STORAGE_ENDPOINT, STORAGE_ACCESS_KEY,
 * STORAGE_SECRET_KEY, STORAGE_BUCKET (default "uploads"). Refuses to run without them.
 *
 * Order: deploy the API (it starts writing variants for NEW uploads) -> run this ->
 * deploy the web loader that requests variant URLs.
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { isVariantEligibleKey, isVariantKey, variantKey, variantKeysFor } from '@force/shared';
import { generateImageVariants } from '../apps/api/src/services/image-variants.service';

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

export interface Args {
  apply: boolean;
  limit: number;
  concurrency: number;
  prefix: string;
  startAfter: string | undefined;
}

export function parseArgs(argv: string[]): Args {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, dflt: number): number => {
    const v = val(name);
    const n = v === undefined ? dflt : Number(v);
    return Number.isInteger(n) && n > 0 ? n : dflt;
  };
  return {
    apply: argv.includes('--apply'),
    limit: num('--limit', Number.POSITIVE_INFINITY),
    concurrency: num('--concurrency', 4),
    prefix: val('--prefix') ?? 'stores/',
    startAfter: val('--start-after'),
  };
}

/**
 * Pure planning step: which listed keys are eligible originals, and which of their
 * rungs are absent from `present` (the keys seen so far in this page)? A rung absent
 * from the page may still exist on the next/previous page, so the caller confirms
 * with HeadObject before generating — see `confirmMissing`.
 */
export function planPage(keys: string[]): Array<{ key: string; candidateMissing: string[] }> {
  const present = new Set(keys);
  const plan: Array<{ key: string; candidateMissing: string[] }> = [];
  for (const key of keys) {
    if (isVariantKey(key) || !isVariantEligibleKey(key)) continue;
    plan.push({ key, candidateMissing: variantKeysFor(key).filter(v => !present.has(v)) });
  }
  return plan;
}

async function exists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as { name?: string }).name === 'NotFound') return false;
    throw err;
  }
}

async function run(): Promise<void> {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY;
  const secretAccessKey = process.env.STORAGE_SECRET_KEY;
  const bucket = process.env.STORAGE_BUCKET || 'uploads';
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.error(
      'Refusing to run: STORAGE_ENDPOINT / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY must be set.'
    );
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const client = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  console.log(
    `${args.apply ? 'APPLY' : 'DRY RUN'} bucket=${bucket} prefix=${args.prefix} ` +
      `concurrency=${args.concurrency} limit=${args.limit} startAfter=${args.startAfter ?? '-'}`
  );

  const stats = { scanned: 0, eligible: 0, complete: 0, generated: 0, failed: 0 };
  let lastKey = args.startAfter ?? '';
  let token: string | undefined;
  let first = true;

  const processOne = async (key: string, candidateMissing: string[]): Promise<void> => {
    try {
      // Confirm candidates really are absent (they may sit on another listing page).
      const missing: string[] = [];
      for (const v of candidateMissing) if (!(await exists(client, bucket, v))) missing.push(v);
      if (missing.length === 0) {
        stats.complete++;
        return;
      }
      if (!args.apply) {
        stats.generated++; // "would generate"
        return;
      }
      const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await (
        got.Body as { transformToByteArray: () => Promise<Uint8Array> }
      ).transformToByteArray();
      const variants = await generateImageVariants(Buffer.from(bytes));
      if (variants.length === 0)
        throw new Error('no variants produced (animated, unreadable or unsupported)');
      for (const v of variants) {
        const vk = variantKey(key, v.width);
        if (!missing.includes(vk)) continue;
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: vk,
            Body: v.buffer,
            ContentType: 'image/webp',
            CacheControl: CACHE_IMMUTABLE,
          })
        );
      }
      stats.generated++;
    } catch (err) {
      stats.failed++;
      console.warn(`  FAILED ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  outer: do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: args.prefix,
        ContinuationToken: token,
        StartAfter: first ? args.startAfter : undefined,
      })
    );
    first = false;
    const keys = (page.Contents ?? []).map(o => o.Key).filter((k): k is string => Boolean(k));
    stats.scanned += keys.length;
    const plan = planPage(keys);
    stats.eligible += plan.length;

    const queue = [...plan];
    const workers = Array.from({ length: args.concurrency }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (stats.generated + stats.failed >= args.limit) return;
        await processOne(item.key, item.candidateMissing);
      }
    });
    await Promise.all(workers);
    if (keys.length > 0) lastKey = keys[keys.length - 1]!;
    if (stats.generated + stats.failed >= args.limit) break outer;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  console.log('\n=== Image variant backfill ===');
  console.log(`Mode:              ${args.apply ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`Scanned keys:      ${stats.scanned}`);
  console.log(`Eligible originals:${stats.eligible}`);
  console.log(`Already complete:  ${stats.complete}`);
  console.log(`${args.apply ? 'Generated:' : 'Would generate:'}  ${stats.generated}`);
  console.log(`Failed:            ${stats.failed}`);
  console.log(`Last key (resume with --start-after): ${lastKey}`);
}

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /backfill-image-variants\.[tj]s$/.test(process.argv[1]);

if (isDirectRun) {
  run().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
