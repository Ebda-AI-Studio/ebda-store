import type { JobDef } from '../../jobs/types';
import { loadS3 } from '../../lazy-modules';
import { auditRetention } from '../../definer';
import logger from '../../logger';
import { inngest } from '../client';
import { archivePlatformAuditD1, archiveStoreAuditDo } from '../../../services/audit-retention-cf';

/**
 * Weekly archive+delete of audit_logs rows older than 90 days.
 * Mirrors the manual `scripts/archive-audit-logs.mjs --apply --export`
 * invocation but on a cron so we don't have to remember to run it.
 *
 * Trigger: every Sunday at 03:00 UTC (06:00 Africa/Cairo — middle of
 * the night, well after the night-shift admins finish for the day).
 *
 * Why archive AND delete: dropping the rows shrinks the working set
 * and keeps INSERT contention low for live admin writes; the JSONL
 * dump on R2 satisfies any "we need an audit trail" compliance ask
 * without keeping it in the hot OLTP table.
 */
const RETENTION_DAYS = 90;
const DELETE_BATCH = 5000;
const EXPORT_PAGE = 5000;

/** An R2 `put` for the archive prefix, or null when STORAGE_* is not configured. */
async function archivePut(): Promise<((key: string, body: string) => Promise<void>) | null> {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const accessKey = process.env.STORAGE_ACCESS_KEY;
  const secretKey = process.env.STORAGE_SECRET_KEY;
  const bucket = process.env.STORAGE_BUCKET || 'uploads';
  if (!endpoint || !accessKey || !secretKey) {
    logger.warn('audit-log-archive: STORAGE_* not set, skipping the Cloudflare audit archive');
    return null;
  }
  const { S3Client, PutObjectCommand } = await loadS3();
  const s3 = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });
  return async (key, body) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(body, 'utf-8'),
        ContentType: 'application/x-ndjson',
        ContentEncoding: 'utf-8',
      })
    );
  };
}

export const auditLogArchive: JobDef = inngest.createFunction(
  {
    id: 'audit-log-archive-weekly',
    name: 'Archive + delete audit_logs older than 90d',
    retries: 1,
    triggers: [{ cron: '0 3 * * 0' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // audit_logs is a cross-tenant system table. Inngest crons run without any
    // HTTP tenant context so no store GUC is set. FORCE RLS on audit_logs would
    // filter every read to 0 rows. Use withRlsBypass for all DB access here.
    // NEON-ZERO N-10d: the rows that no longer live in Postgres (D1 platform_audit_log, every DO store's audit_logs).
    // Runs whether or not Postgres still holds old rows, and never lets a Cloudflare failure hide behind a Postgres result.
    const cf = await step.run('archive-cloudflare-audit', async () => {
      const put = await archivePut();
      if (!put) return { skipped: true, d1: 0, stores: 0, storeRows: 0 };
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const d1 = await archivePlatformAuditD1(cutoff, put, stamp);
      const doRows = await archiveStoreAuditDo(cutoff, put, stamp);
      return { skipped: false, d1, stores: doRows.stores, storeRows: doRows.rows };
    });
    logger.info(cf, 'audit-log-archive: cloudflare audit archived');

    const total = await step.run('count-old-rows', () => auditRetention.count(cutoff));

    if (total === 0) {
      logger.info({ cutoff }, 'audit-log-archive: nothing to archive');
      return { archived: 0, deleted: 0 };
    }

    const exported = await step.run('export-to-r2', async () => {
      const endpoint = process.env.STORAGE_ENDPOINT;
      const accessKey = process.env.STORAGE_ACCESS_KEY;
      const secretKey = process.env.STORAGE_SECRET_KEY;
      const bucket = process.env.STORAGE_BUCKET || 'uploads';

      if (!endpoint || !accessKey || !secretKey) {
        logger.warn('audit-log-archive: STORAGE_* not set, skipping R2 export');
        return { skipped: true, written: 0, key: null };
      }

      const { S3Client, PutObjectCommand } = await loadS3();
      const s3 = new S3Client({
        endpoint,
        region: 'auto',
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        forcePathStyle: true,
      });

      const chunks: string[] = [];
      let cursor: string | null = null;
      let written = 0;
      while (true) {
        // withRlsBypass in a loop: each page is a fresh transaction. The cursor
        // value is captured in closure so the next page picks up where we left off.
        // Through definers: audit_logs spans every store AND store-less platform rows.
        const rows: Array<{ id: string }> = await auditRetention.page(cutoff, cursor, EXPORT_PAGE);
        if (rows.length === 0) break;
        for (const r of rows) chunks.push(JSON.stringify(r) + '\n');
        written += rows.length;
        cursor = rows[rows.length - 1].id;
        if (rows.length < EXPORT_PAGE) break;
      }

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
      logger.info(
        { written, key, sizeMb: (body.length / 1024 / 1024).toFixed(1) },
        'audit-log-archive: exported to r2'
      );
      return { skipped: false, written, key };
    });

    const deleted = await step.run('delete-old-rows', async () => {
      let total = 0;
      while (true) {
        // Raw DELETE bypasses Prisma's model layer — wrap in withRlsBypass so
        // the session's GUC allows the DELETE to execute cross-tenant.
        const result = await auditRetention.purge(cutoff, DELETE_BATCH);
        if (!result || result === 0) break;
        total += Number(result);
      }
      return total;
    });

    logger.info({ archived: exported.written, deleted, cutoff }, 'audit-log-archive: complete');
    return { archived: exported.written, deleted };
  }
);
