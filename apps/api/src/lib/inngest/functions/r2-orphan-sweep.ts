import type { JobDef } from '../../jobs/types';
import type { S3Client } from '@aws-sdk/client-s3';
import { loadS3 } from '../../lazy-modules';
import {
  prisma,
  isOwnerRole,
  withOwnerTx,
  storeDirectory,
  withoutHiddenStores,
} from '@ebda/database';
import { platformDb } from '../../platform-directory';
import { platformD1ReferencedKeys } from '../../r2-platform-d1-references';
import { collectDoStoreReferencedKeys } from '../../r2-do-references';
import { storeHasNoDataHere } from '../../store-pg-gone';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import { config } from '../../../config';
import { urlToR2Key } from '../../../services/r2-cleanup.service';
import {
  assertStrictTablesVisible,
  collectReferencedR2Keys,
  isDerivedR2Key,
  isExpiredDerivedKey,
} from '../../r2-references';

/**
 * Weekly R2 orphan sweep — cron 0 4 * * 0 (Sunday 04:00 UTC).
 *
 * Lists every object in the R2 bucket, collects every URL still
 * referenced anywhere in the database, computes the diff, and
 * REPORTS the result via structured logger + Telegram alert.
 *
 * DOES NOT DELETE by default. Set env var R2_ORPHAN_SWEEP_APPLY=true
 * to enable batch deletion of confirmed orphans (DeleteObjects ≤1000
 * objects/request). Default is report-only — review the logs/alerts
 * before enabling apply mode.
 *
 * Safety guards:
 *  - Objects younger than 24 h are skipped (in-flight upload protection:
 *    a file may have landed in R2 before its DB row was committed).
 *  - R2_ORPHAN_SWEEP_APPLY must be the literal string "true" to enable
 *    deletion — any other value (including "1", "yes") stays in report mode.
 *  - Only runs if storage is configured (STORAGE_ENDPOINT etc.). Exits
 *    cleanly if not.
 *  - Cross-tenant DB queries run via withRlsBypass so FORCE RLS policies
 *    (set per HTTP request, absent on cron) don't filter rows to 0.
 *  - …and that is PROVEN before any orphan is reported or deleted:
 *    assertStrictTablesVisible (lib/r2-references.ts, issue 2288) refuses the
 *    delete — and marks a report untrustworthy — when a STRICT registry table
 *    reads 0 rows while the catalog says it has rows or cannot say.
 */

/** Objects younger than this are skipped regardless of DB reference state. */
const MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Maximum orphans included in the Telegram alert sample (keeps message short). */
const ALERT_SAMPLE = 10;

/** DeleteObjects batch cap (R2 S3-compatible API limit). */
const DELETE_BATCH = 1000;

interface R2Obj {
  key: string;
  size: number;
  lastModified?: Date;
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

/**
 * Page through every object in the configured R2 bucket.
 * Reuses the same S3 client setup as the orphan-audit script and
 * StorageService (endpoint + access key + secret key from config).
 */
async function listAllObjects(client: S3Client, bucket: string): Promise<R2Obj[]> {
  const { ListObjectsV2Command } = await loadS3();
  const objects: R2Obj[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key)
        objects.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/**
 * Every R2 key currently referenced by at least one live row.
 *
 * The column set is the shared registry `R2_REFERENCE_COLUMNS`
 * (lib/r2-references.ts) — the same one scripts/r2-orphan-audit.ts and
 * r2-cleanup.service.ts `isStillReferenced()` read, so the three can no
 * longer drift. (They did: none of the three hand-written lists read
 * `Store.pwaSettings`, so every live PWA icon looked like an orphan.)
 *
 * Each page of each table runs in its own withOwnerTx call so a slow table
 * doesn't hold a single massive transaction open across the whole sweep.
 * withOwnerTx (an OWNER-ROLE connection) is required: this scans every store's
 * rows plus the store-less admin accounts, which the strict-RLS app role cannot
 * see — see the owner-role gate at the top of the handler.
 */
async function collectReferencedKeys(): Promise<Set<string>> {
  return collectReferencedR2Keys({
    run: fn => withOwnerTx(tx => fn(tx)),
    toKey: urlToR2Key,
  });
}

/**
 * The keys referenced from the tables of every store that lives on its Durable Object (Ruling CF-JOBS-4B). Their Postgres rows
 * are sealed and stale, so the reference set must come from the DO: one `r2References` page at a time per registered column set.
 * ANY failure (a store whose DO cannot be read, a registry table the DO schema does not have) throws: with a partial reference
 * set live images would be called orphans, so the run ends here and nothing is deleted.
 */
export async function collectDoReferencedKeys(): Promise<string[]> {
  const stores = await withoutHiddenStores(() =>
    storeDirectory(undefined, { includeDeleted: true })
  );
  const keys = new Set<string>();
  for (const { id } of stores) {
    if (await storeHasNoDataHere(id)) continue; // a gone `pg` store (qa-merchant-test) has no DO to read
    const storeKeys = await collectDoStoreReferencedKeys(id, urlToR2Key);
    if (storeKeys) for (const k of storeKeys) keys.add(k);
  }
  return [...keys];
}

export const r2OrphanSweep: JobDef = inngest.createFunction(
  {
    id: 'r2-orphan-sweep',
    name: 'R2 orphan sweep (weekly cron, report-only by default)',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 4 * * 0' }], // Sunday 04:00 UTC
  },
  async ({ step }) => {
    // ── Guard: storage must be configured ────────────────────────────────
    if (!config.storageEndpoint || !config.storageAccessKey || !config.storageSecretKey) {
      logger.info('r2-orphan-sweep: storage not configured — skipping');
      return { skipped: true, reason: 'storage not configured' };
    }

    // ── Guard: this job needs an OWNER-ROLE connection ───────────────────
    // It decides which R2 objects are unreferenced by reading EVERY store's rows
    // plus the store-less admin accounts (`users.store_id` NULL). The strict-RLS
    // app role (`ebda_app`) cannot see all of them, and a partial reference set
    // would call live images orphans. So on the app role the sweep does not run
    // at all (no read, no delete, no alert): it needs a privileged job runner
    // (SP5). The per-URL check on replace/delete (`r2-cleanup.service`) is a
    // different, store-by-store path and is unaffected.
    // NEON-ZERO (Ruling NZ-PG-2): where the platform D1 is bound Postgres is gone - there is no owner-role connection to
    // need and no Postgres row to read. The references are the D1 platform tables + every store's DO (both collected below).
    const pgGone = !!platformDb();
    if (!pgGone && !(await isOwnerRole())) {
      logger.warn(
        'r2-orphan-sweep: skipped — needs an owner-role DB connection; the strict-RLS app role cannot see every reference'
      );
      return { skipped: true, reason: 'requires owner-role connection' };
    }

    const bucket = config.storageBucket || 'uploads';

    // R2_ORPHAN_SWEEP_APPLY=true enables deletion — any other value stays
    // in report-only mode. Default OFF for safety.
    const applyDeletes = process.env.R2_ORPHAN_SWEEP_APPLY === 'true';

    const { S3Client, DeleteObjectsCommand } = await loadS3();
    const client = new S3Client({
      endpoint: config.storageEndpoint,
      region: 'auto',
      credentials: {
        accessKeyId: config.storageAccessKey,
        secretAccessKey: config.storageSecretKey,
      },
      forcePathStyle: true,
    });

    // EVERYTHING RETURNED FROM step.run IS JSON-SERIALIZED.
    //
    // Inngest persists each step's result so a replay can resume without
    // re-running it, and that round-trip is JSON. Rich types do not survive:
    // a Set becomes `{}`, a Date becomes a string. Both were being returned
    // directly here, so this function threw `referenced.has is not a function`
    // on EVERY run since it shipped (d8d27e86) and had never once completed —
    // which is why an orphaned object from a 2026-06-15 tenant delete sat
    // undetected until a manual audit on 2026-08-09 found it. The safety net
    // was dead on arrival.
    //
    // So each step returns plain JSON, and the rich type is rebuilt OUTSIDE
    // the step where it is actually used.

    // ── Step 1: list R2 bucket ────────────────────────────────────────────
    // lastModified crosses the boundary as an ISO string, not a Date.
    const rawObjects = await step.run('list-r2-objects', async () =>
      (await listAllObjects(client, bucket)).map(o => ({
        key: o.key,
        size: o.size,
        lastModifiedIso: o.lastModified ? o.lastModified.toISOString() : null,
      }))
    );
    const objects = rawObjects.map(
      (o: { key: string; size: number; lastModifiedIso: string | null }) => ({
        key: o.key,
        size: o.size,
        lastModified: o.lastModifiedIso ? new Date(o.lastModifiedIso) : undefined,
      })
    );
    logger.info({ count: objects.length, bucket }, 'r2-orphan-sweep: listed R2 objects');

    // ── Step 2: collect DB-referenced keys ───────────────────────────────
    // Array over the wire; Set rebuilt here for the O(1) lookup below.
    const referencedList = pgGone
      ? []
      : await step.run('collect-referenced-keys', async () =>
          Array.from(await collectReferencedKeys())
        );
    // + the references held on the Durable Object of every DO store (their Postgres rows are not the truth any more)
    const doReferenced = await step.run('collect-do-referenced-keys', () =>
      collectDoReferencedKeys()
    );
    // + the platform tables that moved to D1 (their Postgres rows are stale)
    const d1Referenced = await step.run('collect-d1-referenced-keys', async () =>
      Array.from(await platformD1ReferencedKeys(urlToR2Key))
    );
    const referenced = new Set([...referencedList, ...doReferenced, ...d1Referenced]);
    logger.info({ count: referenced.size }, 'r2-orphan-sweep: collected referenced keys from DB');

    // ── Step 3: compute orphans ───────────────────────────────────────────
    const now = Date.now();
    const orphans: string[] = [];
    let totalBytes = 0;
    let orphanBytes = 0;
    let skippedYoung = 0;

    for (const obj of objects) {
      totalBytes += obj.size;
      if (referenced.has(obj.key)) continue;
      // Derived objects (email barcode PNGs) have no DB column: never orphans. They are
      // re-renderable, so they are removed only once past their retention window.
      if (isDerivedR2Key(obj.key)) {
        if (isExpiredDerivedKey(obj.key, obj.lastModified, now)) {
          orphans.push(obj.key);
          orphanBytes += obj.size;
        }
        continue;
      }
      // Skip objects younger than 24 h — the DB row may not have landed yet
      // (upload-to-DB write is not atomic; protecting against that race).
      const ageMs = obj.lastModified ? now - obj.lastModified.getTime() : Infinity;
      if (ageMs < MIN_AGE_MS) {
        skippedYoung++;
        continue;
      }
      orphans.push(obj.key);
      orphanBytes += obj.size;
    }

    const summary = {
      totalKeys: objects.length,
      totalBytes,
      orphanCount: orphans.length,
      orphanBytes,
      skippedYoung,
      applyDeletes,
    };

    logger.info(summary, 'r2-orphan-sweep: computed orphans');

    // ── Step 3b: prove the registry read was not filtered by RLS ─────────
    // Same guard as scripts/r2-orphan-audit.ts (issues 2251/2288): a STRICT
    // registry table that reads 0 rows while the catalog says it has rows (or
    // cannot say) means its references are missing and its images would be
    // called orphans. With deletes on, refuse — the throw fails the run
    // loudly and nothing is deleted. In report-only mode the report is still
    // sent, marked as untrustworthy, because the operator acts on it.
    let visibilityError: string | null = null;
    if (orphans.length > 0 && !pgGone) {
      visibilityError = await step.run('assert-strict-tables-visible', async () => {
        try {
          await assertStrictTablesVisible(fn => withOwnerTx(tx => fn(tx)), prisma);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      });
      if (visibilityError && applyDeletes) {
        throw new Error(`r2-orphan-sweep: not deleting — ${visibilityError}`);
      }
      if (visibilityError) {
        logger.error({ visibilityError }, 'r2-orphan-sweep: orphan report is not trustworthy');
      }
    }

    // ── Step 4: optional batch delete ────────────────────────────────────
    let deleted = 0;
    if (applyDeletes && orphans.length > 0) {
      deleted = await step.run('delete-orphans', async () => {
        let count = 0;
        for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
          const slice = orphans.slice(i, i + DELETE_BATCH);
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: slice.map(Key => ({ Key })), Quiet: true },
            })
          );
          count += slice.length;
          logger.info(
            { deleted: count, total: orphans.length },
            'r2-orphan-sweep: batch delete progress'
          );
        }
        return count;
      });
      logger.info({ deleted }, 'r2-orphan-sweep: apply-delete complete');
    }

    // ── Step 5: send alert summary ────────────────────────────────────────
    if (orphans.length > 0 || applyDeletes) {
      const sample = orphans.slice(0, ALERT_SAMPLE);
      const moreCount = orphans.length - sample.length;
      const lines = [
        ...(visibilityError
          ? [`⚠️ REPORT NOT TRUSTWORTHY — do not act on it: ${visibilityError}`, '']
          : []),
        `Orphans found: ${orphans.length} (${formatBytes(orphanBytes)})`,
        `Total bucket: ${objects.length} objects (${formatBytes(totalBytes)})`,
        `Skipped (< 24 h): ${skippedYoung}`,
        applyDeletes ? `Deleted: ${deleted}` : 'Mode: REPORT ONLY (R2_ORPHAN_SWEEP_APPLY not set)',
        '',
        'Sample orphan keys:',
        ...sample.map(k => `  ${k}`),
        ...(moreCount > 0 ? [`  …and ${moreCount} more`] : []),
      ];

      void sendAlert({
        level: visibilityError || orphans.length > 100 ? 'p1' : 'info',
        scope: 'platform',
        source: 'r2-orphan-sweep',
        title: `R2 orphan sweep: ${orphans.length} orphan object${
          orphans.length === 1 ? '' : 's'
        } found`,
        body: lines.join('\n'),
      });
    } else {
      logger.info('r2-orphan-sweep: no orphans found — bucket is clean');
    }

    return { ...summary, deleted };
  }
);
