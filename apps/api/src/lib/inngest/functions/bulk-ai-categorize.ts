import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { suggestProductCategory } from '../../ai/product-category-suggester';
import { AppError } from '../../../middleware/error-handler';

/**
 * Catalogue-wide category-assignment sweep — uncategorized products only.
 *
 * For every product with ZERO categories, asks Gemini to pick the single
 * best match from the STORE'S OWN existing categories (never invents a new
 * one — mirrors the per-product `/suggest-categories` logic). If nothing is
 * a confident match, the product is left uncategorized (counts as skipped,
 * not failed).
 *
 * `force` is accepted for wiring consistency with every other bulk sweep
 * but is intentionally a NO-OP here: a product with an existing category is
 * NEVER re-categorized (there's no "AI-owned vs human-owned" provenance on
 * `ProductCategory`, so overwriting would risk clobbering a merchant's
 * manual choice). Re-running the sweep only ever fills gaps.
 *
 * Same guardrails as bulk-ai-product-faqs: concurrency 1/store, retries 2,
 * AI_BULK_THROTTLE_MS throttle, assertAiQuota before each call, error cap
 * 50, cooperative cancellation every 5 items.
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

export const bulkAiCategorize: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-categorize',
    name: 'Bulk: assign categories to uncategorized products',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/categorize-requested' }],
  },
  async ({ event }) => {
    const { jobId, storeId } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/categorize-requested fired without ids');
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

        const existingCategories = await prisma.category.findMany({
          where: { storeId, isActive: true },
          select: { id: true, name: true, nameAr: true },
        });

        // Only uncategorized products are candidates — categorized products
        // are never touched by this sweep.
        const products = await prisma.product.findMany({
          where: {
            storeId,
            status: 'active',
            deletedAt: null,
            categories: { none: {} },
          },
          select: {
            id: true,
            name: true,
            description: true,
          },
        });

        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { total: products.length },
        });

        if (existingCategories.length === 0) {
          // Nothing to assign from — skip every product cleanly.
          skipped = products.length;
          processed = products.length;
        } else {
          for (const product of products) {
            if (processed % 5 === 0 && processed > 0) {
              const currentJob = await prisma.bulkAiJob.findUnique({
                where: { id: jobId },
                select: { status: true },
              });
              if (currentJob?.status === 'cancelled') {
                logger.info(
                  { jobId, storeId, processed, filled, skipped, failed },
                  'bulk-ai-categorize: cancelled by merchant'
                );
                break;
              }
            }

            try {
              await assertAiQuota();

              const matches = await callWithRetry(
                () =>
                  suggestProductCategory(
                    {
                      storeId,
                      storeName: store?.name ?? storeId,
                      product: { name: product.name, description: product.description },
                      existingCategories,
                    },
                    apiKey,
                    MODEL
                  ),
                `categorize:${product.id}`
              );

              const best = matches[0];
              if (!best) {
                skipped++;
              } else {
                await prisma.productCategory.create({
                  data: { productId: product.id, categoryId: best.id, position: 0 },
                });
                filled++;
              }
            } catch (err) {
              if (isAiQuotaCapError(err)) {
                logger.warn(
                  { storeId, jobId },
                  'bulk-ai-categorize: quota cap hit, aborting sweep'
                );
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
        { jobId, storeId, filled, skipped, failed, quotaReached },
        'bulk-ai-categorize complete'
      );
    })();
  }
);
