import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { fillProductFields, isAutopilotEnabled } from '../../../services/ai-autofill.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Reacts to product.upserted events and runs AI autofill on the product.
 *
 * Gated by a per-store aiAutopilot toggle (default ON) so merchants can
 * disable automated fills without touching code. On create events the
 * function also kicks the recommendations sweep for the new product so
 * cross-sell suggestions are generated immediately rather than waiting
 * for the next manual bulk sweep.
 *
 * Multiple functions may listen to product.upserted (e.g. product-meta-sync
 * for the Meta Catalog bot) — Inngest runs all registered listeners in
 * parallel.
 */
export const aiAutofillProduct: InngestFunction.Any = inngest.createFunction(
  {
    id: 'ai-autofill-product',
    name: 'AI-first: autofill product fields on create/update',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    // A merchant saving the same product several times in a row fired one AI
    // autofill per save. Wait for the edits to settle (10s with no new save
    // for that product) and run once on the latest event.
    debounce: { key: 'event.data.productId', period: '10s' },
    retries: 2,
    triggers: [{ event: 'product.upserted' as any }],
  },
  async ({ event }) => {
    const {
      storeId,
      productId,
      op = 'update',
      changedFields = [],
    } = event.data as {
      storeId: string;
      productId: string;
      op?: 'create' | 'update';
      changedFields?: string[];
    };

    if (!storeId || !productId) return;

    await runInTenantContext(storeId, async () => {
      if (!(await isAutopilotEnabled(storeId))) {
        logger.info({ storeId, productId }, '[ai-autofill] autopilot off, skipping');
        return;
      }

      const result = await fillProductFields(storeId, productId, { op, changedFields });
      logger.info(
        { storeId, productId, op, filled: result.filled },
        '[ai-autofill] product filled'
      );

      if (op === 'create') {
        // Kick the AI recommendations sweep for the new product so cross-sell
        // suggestions are ready without waiting for a manual bulk sweep.
        // We create a system-initiated bulkAiJob (userId: null — no HTTP context)
        // and fire the same event the admin route uses, scoped with force:true
        // so it processes this newly-added product even if it already appeared
        // in a prior catalogue sweep.
        try {
          // Coalesce: a bulk import fires one create event per product. The
          // recommendations sweep is store-wide and smart-skips, so the first
          // job already covers every new product — don't spawn N near-identical
          // jobs. Skip if one is already queued/running for this store.
          const existing = await prisma.bulkAiJob.findFirst({
            where: { storeId, kind: 'recommendations', status: { in: ['queued', 'running'] } },
            select: { id: true },
          });
          if (existing) {
            logger.info(
              { storeId, productId, jobId: existing.id },
              '[ai-autofill] recommendations sweep already pending, skipping'
            );
            return;
          }

          const job = await prisma.bulkAiJob.create({
            data: {
              storeId,
              userId: null, // system-initiated — no authenticated user context
              kind: 'recommendations',
            },
            select: { id: true },
          });

          await inngest.send({
            name: 'bulk-ai/recommendations-requested',
            data: { jobId: job.id, storeId, force: false },
          });

          logger.info(
            { storeId, productId, jobId: job.id },
            '[ai-autofill] recommendations sweep enqueued for new product'
          );
        } catch (err) {
          // Non-fatal: autofill already succeeded; recommendations will be
          // generated on the next manual bulk sweep.
          logger.warn(
            { err, storeId, productId },
            '[ai-autofill] failed to enqueue recommendations sweep'
          );
        }
      }
    }); // end runInTenantContext
  }
);
