import type { InngestFunction } from 'inngest';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Weekly archive+delete of audit_logs rows older than 90 days.
 * Mirrors the manual `scripts/archive-audit-logs.mjs --apply --export`
 * invocation but on a cron so we don't have to remember to run it.
 *
 * Trigger: every Sunday at 03:00 UTC (06:00 Asia/Kuwait — middle of
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

export const auditLogArchive: InngestFunction.Any = inngest.createFunction(
  {
    id: 'audit-log-archive-weekly',
    name: 'Archive + delete audit_logs older than 90d',
    retries: 1,
    triggers: [{ cron: '0 3 * * 0' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const total = await step.run('count-old-rows', () =>
      prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } })
    );

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
        const rows: Array<{ id: string }> = await prisma.auditLog.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: { id: 'asc' },
          take: EXPORT_PAGE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
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
        const result = await prisma.$executeRawUnsafe<number>(
          `DELETE FROM public.audit_logs WHERE id IN (
             SELECT id FROM public.audit_logs WHERE created_at < $1 LIMIT ${DELETE_BATCH}
           )`,
          cutoff
        );
        if (!result || result === 0) break;
        total += Number(result);
      }
      return total;
    });

    logger.info({ archived: exported.written, deleted, cutoff }, 'audit-log-archive: complete');
    return { archived: exported.written, deleted };
  }
);
