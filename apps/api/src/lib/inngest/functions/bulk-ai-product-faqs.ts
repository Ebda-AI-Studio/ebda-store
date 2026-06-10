import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { generateProductFaqs } from '../../ai/product-faq-generator';

/**
 * Catalogue-wide product-FAQ sweep.
 *
 * Generates bilingual (EN + AR) FAQ pairs for every active product using
 * the SAME core as the per-product "Draft with AI" button
 * (`generateProductFaqs` in lib/ai/product-faq-generator.ts). DRY: one
 * prompt + parse path for both the single-product route and this sweep.
 *
 * Re-sweep semantics (mirrors bulk-ai-recommendations):
 *   - Default: smart-skip products that already have ANY FAQ row. Only
 *     products with zero FAQs get a Gemini call.
 *   - `force: true`: process every product. Deletes that product's prior
 *     AI-DRAFTED FAQs (manuallyEdited rows are preserved) then inserts the
 *     freshly-generated ones.
 *   - Cooperative cancellation: polls bulk_ai_jobs.status every 5 items.
 *
 * Follows the canonical bulk-AI patterns:
 *   - concurrency key on storeId (one sweep per store at a time)
 *   - retries: 2
 *   - throttle at AI_BULK_THROTTLE_MS (default 2500ms — ~24 RPM)
 *   - assertAiQuota before each Gemini call (respects AI_DAILY_REQUEST_CAP)
 *   - error cap at 50 so no single run bloats the BulkAiJob row
 *   - quota errors re-thrown cleanly (not silenced)
 */

const ERROR_CAP = 50;
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
// FAQ pairs to draft per product.
const FAQS_PER_PRODUCT = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface BulkError {
  entityKind: 'product';
  entityId: string;
  entityName: string;
  error: string;
}

export const bulkAiProductFaqs: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-product-faqs',
    name: 'Bulk: draft product FAQs across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/product-faqs-requested' }],
  },
  async ({ event, step }) => {
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
      logger.warn('bulk-ai/product-faqs-requested fired without ids');
      return;
    }

    return runInTenantContext(storeId, async () => {
    await step.run('mark-running', () =>
      prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { status: 'running', startedAt: new Date() },
      })
    );

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
          _count: { select: { faqs: true } },
        },
      });

      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { total: products.length },
      });

      for (const product of products) {
        // Cooperative cancellation — check every 5 items.
        if (processed % 5 === 0 && processed > 0) {
          const currentJob = await prisma.bulkAiJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });
          if (currentJob?.status === 'cancelled') {
            logger.info(
              { jobId, storeId, processed, filled, skipped, failed },
              'bulk-ai-product-faqs: cancelled by merchant'
            );
            break;
          }
        }

        // Smart-skip: products that already have FAQs are left alone unless
        // force is set. Counts as skipped (not failed) so re-runs report
        // cleanly.
        if (!force && product._count.faqs > 0) {
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

          // Shared core — identical to the per-product "Draft with AI" path.
          const faqs = await callWithRetry(
            () =>
              generateProductFaqs(
                {
                  storeName: store?.name ?? storeId,
                  product: {
                    name: product.name,
                    nameAr: product.nameAr,
                    description: product.description,
                  },
                  count: FAQS_PER_PRODUCT,
                },
                apiKey,
                MODEL
              ),
            `product-faqs:${product.id}`
          );

          // Keep only well-formed rows (question + answer present).
          const validFaqs = faqs.filter(
            f =>
              f &&
              typeof f.question === 'string' &&
              f.question.trim() &&
              typeof f.answer === 'string' &&
              f.answer.trim()
          );

          if (validFaqs.length === 0) {
            skipped++;
          } else {
            await prisma.$transaction(async tx => {
              // On force, replace only AI-drafted rows — never clobber
              // merchant-edited FAQs.
              if (force) {
                await tx.productFaq.deleteMany({
                  where: { productId: product.id, aiDrafted: true, manuallyEdited: false },
                });
              }
              await tx.productFaq.createMany({
                data: validFaqs.map(f => ({
                  productId: product.id,
                  question: f.question.slice(0, 500),
                  questionAr: f.questionAr?.slice(0, 500) ?? null,
                  answer: f.answer.slice(0, 2000),
                  answerAr: f.answerAr?.slice(0, 2000) ?? null,
                  aiDrafted: true,
                })),
              });
            });
            filled++;
          }
        } catch (err) {
          if (isAiQuotaCapError(err)) {
            logger.warn({ storeId, jobId }, 'bulk-ai-product-faqs: quota cap hit, aborting sweep');
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
          failed++;
        }

        processed++;

        // Throttle to stay under the free-tier RPM — only after a real call.
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
      { jobId, storeId, filled, skipped, failed, quotaReached, force },
      'bulk-ai-product-faqs complete'
    );
    }); // end runInTenantContext
  }
);
