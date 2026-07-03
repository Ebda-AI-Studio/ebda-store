import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { generateProductAltText } from '../../ai/product-alt-text-generator';

/**
 * Catalogue-wide image alt-text sweep (Gemini Vision).
 *
 * Walks every active product, looks at up to IMAGES_PER_PRODUCT_CAP images
 * (ordered by position) that are still missing `alt`, and asks Gemini
 * Vision to write a concise, descriptive alt string for each. A product
 * whose capped image set is already fully alt-filled is skipped entirely
 * (no Gemini calls). `ProductImage` has no AI-vs-human provenance field, so
 * — like category assignment — an image that already has `alt` (however it
 * got there) is NEVER overwritten, regardless of `force`. Re-running the
 * sweep only ever fills gaps left by new images.
 *
 * The per-product image cap protects the Gemini quota from a single
 * many-image product burning the whole sweep's budget; assertAiQuota +
 * the throttle apply PER IMAGE (each is its own Vision call), not per
 * product.
 *
 * Progress is tracked at PRODUCT granularity (matches every other bulk
 * sweep's BulkAiJob shape): a product counts `filled` if at least one of
 * its images got a fresh alt, `skipped` if none needed one, `failed` if
 * every attempted image failed.
 */

const ERROR_CAP = 50;
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const IMAGES_PER_PRODUCT_CAP = 4;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface BulkError {
  entityKind: 'product';
  entityId: string;
  entityName: string;
  error: string;
}

export const bulkAiImageAlt: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-image-alt',
    name: 'Bulk: generate image alt-text across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/image-alt-requested' }],
  },
  async ({ event }) => {
    const { jobId, storeId } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/image-alt-requested fired without ids');
      return;
    }

    return (async () => {
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { status: 'running', startedAt: new Date() },
      });

      const errors: BulkError[] = [];
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let processed = 0;
      let quotaReached = false;

      try {
        const apiKey = config.googleAiKey;
        if (!apiKey) {
          throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
        }

        const products = await prisma.product.findMany({
          where: { storeId, status: 'active', deletedAt: null },
          select: {
            id: true,
            name: true,
            nameAr: true,
            images: {
              orderBy: { position: 'asc' },
              take: IMAGES_PER_PRODUCT_CAP,
              select: { id: true, url: true, alt: true },
            },
          },
        });

        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { total: products.length },
        });

        for (const product of products) {
          if (processed % 5 === 0 && processed > 0) {
            const currentJob = await prisma.bulkAiJob.findUnique({
              where: { id: jobId },
              select: { status: true },
            });
            if (currentJob?.status === 'cancelled') {
              logger.info(
                { jobId, storeId, processed, filled, skipped, failed },
                'bulk-ai-image-alt: cancelled by merchant'
              );
              break;
            }
          }

          const missingAlt = product.images.filter(img => !img.alt?.trim());
          if (missingAlt.length === 0) {
            skipped++;
            processed++;
            if (processed % 10 === 0 || processed === products.length) {
              await prisma.bulkAiJob.update({
                where: { id: jobId },
                data: { processed, filled, skipped, failed, errors: errors as object },
              });
            }
            continue;
          }

          let productFilled = 0;
          let productFailed = 0;

          for (const image of missingAlt) {
            try {
              await assertAiQuota();

              const alt = await callWithRetry(
                () =>
                  generateProductAltText(
                    {
                      imageUrl: image.url,
                      product: { name: product.name, nameAr: product.nameAr },
                    },
                    apiKey,
                    MODEL
                  ),
                `image-alt:${image.id}`
              );

              await prisma.productImage.update({
                where: { id: image.id },
                data: { alt },
              });
              productFilled++;
            } catch (err) {
              if (isAiQuotaCapError(err)) {
                logger.warn({ storeId, jobId }, 'bulk-ai-image-alt: quota cap hit, aborting sweep');
                processed++;
                throw err;
              }
              if (errors.length < ERROR_CAP) {
                errors.push({
                  entityKind: 'product',
                  entityId: product.id,
                  entityName: product.name,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              productFailed++;
            }

            await sleep(THROTTLE_MS);
          }

          if (productFilled > 0) filled++;
          else if (productFailed > 0) failed++;
          else skipped++;

          processed++;

          if (processed % 10 === 0 || processed === products.length) {
            await prisma.bulkAiJob.update({
              where: { id: jobId },
              data: { processed, filled, skipped, failed, errors: errors as object },
            });
          }
        }
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        quotaReached = true;
        if (errors.length < ERROR_CAP) {
          errors.push({
            entityKind: 'product',
            entityId: storeId,
            entityName: 'sweep',
            error: err instanceof Error ? err.message : 'AI quota cap reached',
          });
        }
      }

      const finalRow = await prisma.bulkAiJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: finalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
          processed,
          filled,
          skipped,
          failed,
          errors: errors as object,
          completedAt: new Date(),
        },
      });

      logger.info(
        { jobId, storeId, filled, skipped, failed, quotaReached },
        'bulk-ai-image-alt complete'
      );
    })();
  }
);
