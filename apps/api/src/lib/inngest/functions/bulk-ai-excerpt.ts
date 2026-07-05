import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import type { AiFieldSources } from '@force/shared';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { generateProductExcerpt } from '../../ai/product-excerpt-generator';
import { AppError } from '../../../middleware/error-handler';

/**
 * Catalogue-wide product-excerpt sweep.
 *
 * Derives a 1-2 sentence bilingual excerpt from each product's full
 * description and writes `Product.excerpt` / `excerptAr`, stamping
 * `aiFieldSources.excerpt` / `.excerptAr` = 'ai' (the same provenance map
 * `ai-autofill.service.ts` uses) so a merchant's manual edit is never
 * silently overwritten.
 *
 * Re-sweep semantics:
 *   - Default: skip a product whose `excerpt` is already non-empty
 *     (human OR ai-written — smart-skip, counts as skipped).
 *   - `force: true`: re-generate only products whose CURRENT excerpt is
 *     empty OR ai-owned (`aiFieldSources.excerpt === 'ai'`). A human-owned
 *     excerpt (present, no 'ai' provenance, or explicitly stamped 'human')
 *     is never touched, matching the ai-autofill `canWrite` guard.
 *
 * Same guardrails as bulk-ai-product-faqs: concurrency 1/store, retries 2,
 * AI_BULK_THROTTLE_MS throttle, assertAiQuota before each Gemini call,
 * error cap 50, cooperative cancellation every 5 items.
 */

const ERROR_CAP = 50;
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface BulkError {
  entityKind: 'product';
  entityId: string;
  entityName: string;
  error: string;
}

export const bulkAiExcerpt: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-excerpt',
    name: 'Bulk: draft product excerpts across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/excerpt-requested' }],
  },
  async ({ event }) => {
    const {
      jobId,
      storeId,
      force = false,
    } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/excerpt-requested fired without ids');
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

        const store = await prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true },
        });

        const products = await prisma.product.findMany({
          where: { storeId, status: 'active', deletedAt: null },
          select: {
            id: true,
            name: true,
            nameAr: true,
            description: true,
            descriptionAr: true,
            excerpt: true,
            excerptAr: true,
            aiFieldSources: true,
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
                'bulk-ai-excerpt: cancelled by merchant'
              );
              break;
            }
          }

          const sources = (product.aiFieldSources as AiFieldSources) ?? {};
          const hasExcerpt = !!product.excerpt?.trim();
          // Safe to (re)write only if empty, or explicitly ai-owned (force
          // refresh). A human-owned or unprovenanced-but-present excerpt is
          // never touched — mirrors ai-autofill.service's canWrite guard.
          const canWrite = !hasExcerpt || (force && sources.excerpt === 'ai');

          if (!canWrite) {
            skipped++;
            processed++;
            if (processed % 25 === 0 || processed === products.length) {
              await prisma.bulkAiJob.update({
                where: { id: jobId },
                data: { processed, filled, skipped, failed, errors: errors as object },
              });
            }
            continue;
          }

          try {
            await assertAiQuota();

            const result = await callWithRetry(
              () =>
                generateProductExcerpt(
                  {
                    storeId,
                    storeName: store?.name ?? storeId,
                    product: {
                      name: product.name,
                      nameAr: product.nameAr,
                      description: product.description,
                      descriptionAr: product.descriptionAr,
                    },
                  },
                  apiKey,
                  MODEL
                ),
              `excerpt:${product.id}`
            );

            if (!result.excerpt.trim() && !result.excerptAr.trim()) {
              skipped++;
            } else {
              await prisma.product.update({
                where: { id: product.id },
                data: {
                  excerpt: result.excerpt || product.excerpt,
                  excerptAr: result.excerptAr || product.excerptAr,
                  aiFieldSources: {
                    ...sources,
                    ...(result.excerpt ? { excerpt: 'ai' } : {}),
                    ...(result.excerptAr ? { excerptAr: 'ai' } : {}),
                  },
                },
              });
              filled++;
            }
          } catch (err) {
            if (isAiQuotaCapError(err)) {
              logger.warn({ storeId, jobId }, 'bulk-ai-excerpt: quota cap hit, aborting sweep');
              throw err;
            }
            if (errors.length < ERROR_CAP) {
              errors.push({
                entityKind: 'product',
                entityId: product.id,
                entityName: product.name,
                error:
                  err instanceof AppError
                    ? err.message
                    : 'AI request failed — please try again shortly.',
              });
            }
            failed++;
          }

          processed++;
          await sleep(THROTTLE_MS);

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
            error: err instanceof AppError ? err.message : 'AI quota cap reached',
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
        { jobId, storeId, filled, skipped, failed, quotaReached, force },
        'bulk-ai-excerpt complete'
      );
    })();
  }
);
