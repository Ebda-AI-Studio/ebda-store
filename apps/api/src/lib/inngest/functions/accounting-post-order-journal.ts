import type { JobDef } from '../../jobs/types';
import { runInStoreCtx } from '../../jobs/store-db';
import logger from '../../logger';
import { inngest } from '../client';
import { postOrderPaymentJournal } from '../../../services/accounting/posting/order-posting';
import { featureService } from '../../../services/feature.service';
import { SentryService } from '../../../services/sentry.service';

/**
 * Listens to the canonical order/created Inngest event (fired by OrderService
 * + the refresh-payment safety net + payment webhooks) and posts the
 * double-entry GL journal: DR Cash[provider] / CR Sales+Tax+Shipping + DR COGS
 * / CR Inventory.
 *
 * Idempotent via journal.service's (source, sourceId) lookup, so multiple
 * fires (webhook retries, refresh-payment, Inngest retries) post the journal
 * exactly once per (orderId, kind).
 *
 * Why listen to order/created instead of hooking into OrderService directly:
 * payment-paid transitions are spread across four route handlers (lines 364,
 * 436, 553, 619 in order.routes.ts). The Inngest event is the single
 * rendezvous point that fires in all four paths. Trade-off: ~seconds gap
 * between order-marked-paid and journal post. Mitigated by the daily
 * reconciliation job (Task 14) which catches any missed posts.
 */
export const accountingPostOrderJournal: JobDef = inngest.createFunction(
  {
    id: 'accounting-post-order-journal',
    name: 'Accounting — post journal on order paid',
    retries: 3,
    // Concurrency keyed per-store to prevent two parallel posts racing on the
    // same store's sequence counter. Per-store concurrency = 5 is conservative
    // but safe (sequence service is already concurrent-safe via Postgres upsert).
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'order/created' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = (event.data ?? {}) as { orderId?: string; storeId?: string };
    if (!orderId || !storeId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostOrderJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
    }
    // Feature gate — skip journal posting when accounting.basic is disabled for the store.
    // In a step: on a Workflow only step bodies hold a database connection.
    const accountingEnabled = await step.run('check-feature', () =>
      featureService.isFeatureEnabled(storeId, 'accounting.basic')
    );
    if (!accountingEnabled) {
      logger.info(
        { storeId, orderId },
        'accountingPostOrderJournal: accounting.basic disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', feature: 'accounting.basic' };
    }
    // PORTED (Ruling CF-JOBS-4): a store on its Durable Object posts through `journalSale` (no Postgres transaction).
    // FORCE RLS: postOrderPaymentJournal reads the order via prisma — it
    // must run inside runInTenantContext(storeId) so the GUC is set.
    // The accounting services (journal.service, account.service) already
    // call withRlsBypass internally for their cross-tenant GL writes, so
    // wrapping the outer call in runInTenantContext is safe (the inner
    // bypasses nest cleanly via separate transactions).
    await step.run('post-journal', async () => {
      try {
        await runInStoreCtx(storeId, () => postOrderPaymentJournal({ orderId }));
      } catch (err) {
        // Surface the failure to structured logs + Sentry. Without this the
        // throw is only visible in the Inngest dashboard — a starved COA (the
        // "seed COA first" error) would otherwise fail silently after all
        // retries exhaust. Rethrow so Inngest still records + retries the step.
        logger.error(
          { err, orderId, storeId },
          'accountingPostOrderJournal: failed to post order payment journal'
        );
        SentryService.captureException(err as Error, {
          tags: { fn: 'accounting-post-order-journal' },
          extra: { orderId, storeId },
        });
        throw err;
      }
    });
    logger.info({ orderId, storeId }, 'accountingPostOrderJournal: posted');
    return { posted: true, orderId };
  }
);
