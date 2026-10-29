import type { JobDef } from '../../jobs/types';
import { loadS3 } from '../../lazy-modules';
import logger from '../../logger';
import { inngest } from '../client';
import { config } from '../../../config';
import { StorageService } from '../../../services/storage.service';
import {
  sweepExpiredCatalogueUploads,
  type SweepBucket,
} from '../../catalogue/expired-uploads-sweep';

/**
 * Daily sweep of expired catalogue-import originals in the private bucket (Ruling CATIMP-6).
 * Cron avoids a weekday field (Cloudflare numbers weekdays from Sunday=1). Logs counts only.
 */
async function realBucket(): Promise<SweepBucket> {
  const bucket = StorageService.privateBucket();
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await loadS3();
  const client = new S3Client({
    endpoint: config.storageEndpoint,
    region: 'auto',
    credentials: {
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecretKey,
    },
    forcePathStyle: true,
  });
  return {
    async listStorePrefixes() {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'stores/',
            Delimiter: '/',
            ContinuationToken: token,
          })
        );
        for (const p of res.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async listObjects(prefix) {
      const out: Array<{ key: string; lastModified?: Date }> = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
        );
        for (const o of res.Contents ?? [])
          if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified });
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async deleteObjects(keys) {
      let deleted = 0;
      let failed = 0;
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        try {
          const res = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map(Key => ({ Key })), Quiet: false },
            })
          );
          const bad = res.Errors?.length ?? 0;
          deleted += batch.length - bad;
          failed += bad;
        } catch {
          failed += batch.length;
        }
      }
      return { deleted, failed };
    },
  };
}

export const catalogImportUploadsSweep: JobDef = inngest.createFunction(
  {
    id: 'catalog-import-uploads-sweep',
    name: 'Delete expired catalogue-import uploads',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '40 3 * * *' }],
  },
  async () => {
    if (!StorageService.isAvailable() || !(config.storagePrivateBucket ?? '').trim()) {
      logger.info('[catalog-import-uploads-sweep] private storage not configured; skipping');
      return { skipped: true };
    }
    const result = await sweepExpiredCatalogueUploads(await realBucket());
    logger.info(result, '[catalog-import-uploads-sweep] done');
    return result;
  }
);
