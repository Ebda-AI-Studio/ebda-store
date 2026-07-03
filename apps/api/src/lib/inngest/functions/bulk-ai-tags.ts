import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { suggestProductTags, MAX_TAGS_PER_PRODUCT } from '../../ai/product-tag-suggester';

/**
 * Catalogue-wide product-tag sweep.
 *
 * For every product, suggests up to MAX_TAGS_PER_PRODUCT (5) tags from
 * name + description. Reuses the store's existing `Tag` rows by
 * case-insensitive name match before creating a new one — never creates a
 * near-duplicate tag. Tags are purely additive: this sweep NEVER deletes a
 * `ProductTag` link or a `Tag` row.
 *
 * Re-sweep semantics:
 *   - Default: skip a product that already has >=1 tag (smart-skip).
 *   - `force: true`: also process already-tagged products, but only ever
 *     TOPS UP — adds newly-suggested tags the product doesn't have yet,
 *     up to the per-product cap. Existing tags are never removed (there is
 *     nothing to "clobber" since tags are additive-only by design).
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

export const bulkAiTags: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-tags',
    name: 'Bulk: suggest product tags across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/tags-requested' }],
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
      logger.warn('bulk-ai/tags-requested fired without ids');
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

        // Store-wide tag cache — name (lowercased) -> id. Reused + extended
        // across every product in this sweep so two products suggesting the
        // "same" tag with different casing never create two Tag rows.
        const existingTags = await prisma.tag.findMany({
          where: { storeId },
          select: { id: true, name: true },
        });
        const tagByLowerName = new Map(existingTags.map(t => [t.name.toLowerCase(), t.id]));
        const existingTagNames = existingTags.map(t => t.name);

        const products = await prisma.product.findMany({
          where: { storeId, status: 'active', deletedAt: null },
          select: {
            id: true,
            name: true,
            description: true,
            tags: { select: { tagId: true } },
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
                'bulk-ai-tags: cancelled by merchant'
              );
              break;
            }
          }

          const currentTagIds = new Set(product.tags.map(t => t.tagId));
          const remainingSlots = MAX_TAGS_PER_PRODUCT - currentTagIds.size;

          if ((!force && currentTagIds.size > 0) || remainingSlots <= 0) {
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

            const suggested = await callWithRetry(
              () =>
                suggestProductTags(
                  {
                    storeName: store?.name ?? storeId,
                    product: { name: product.name, description: product.description },
                    existingTagNames,
                  },
                  apiKey,
                  MODEL
                ),
              `tags:${product.id}`
            );

            // Resolve each suggested name to a tag id, creating new Tag rows
            // only when no case-insensitive match already exists.
            const toLink: string[] = [];
            for (const name of suggested) {
              if (toLink.length >= remainingSlots) break;
              const key = name.toLowerCase();
              let tagId = tagByLowerName.get(key);
              if (!tagId) {
                const created = await prisma.tag.create({ data: { storeId, name } });
                tagId = created.id;
                tagByLowerName.set(key, tagId);
                existingTagNames.push(name);
              }
              if (!currentTagIds.has(tagId) && !toLink.includes(tagId)) {
                toLink.push(tagId);
              }
            }

            if (toLink.length === 0) {
              skipped++;
            } else {
              await prisma.productTag.createMany({
                data: toLink.map(tagId => ({ productId: product.id, tagId })),
                skipDuplicates: true,
              });
              filled++;
            }
          } catch (err) {
            if (isAiQuotaCapError(err)) {
              logger.warn({ storeId, jobId }, 'bulk-ai-tags: quota cap hit, aborting sweep');
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
        'bulk-ai-tags complete'
      );
    })();
  }
);
