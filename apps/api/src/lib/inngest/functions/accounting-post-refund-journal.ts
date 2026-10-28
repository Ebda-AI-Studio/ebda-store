import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { postRefundJournal } from '../../../services/accounting/posting/refund-posting';
import {
  postAmountOnlyRefundJournal,
  postPartialReturnJournal,
} from '../../../services/accounting/posting/partial-return-posting';
import { featureService } from '../../../services/feature.service';

/**
 * Listens to the canonical order/refunded Inngest event (fired by
 * OrderService.applyRefundEffects + provider refund-webhook handlers) and
 * posts the GL adjustment:
 *
 *   - FULL refund: mirror entries with debits/credits swapped, linked via
 *     reversedById (postRefundJournal — also backs out any prior partial
 *     adjustment entries so the ledger nets to zero, the GL equivalent of
 *     the fanout's already-restored-quantity subtraction).
 *   - PARTIAL return or backorder single-line cancel (item-level `partial`
 *     payload): a pro-rata adjustment reversing only those lines'
 *     revenue/tax/COGS (postPartialReturnJournal), keyed on
 *     `partial.refundKey` (the Return id, or `backorder:<lineId>`) so an
 *     at-least-once redelivery never posts twice.
 *   - PARTIAL refund made outside a return (`partial.amountOnly`, refundKey
 *     `refund:<providerRefundId>`): a revenue refund for exactly
 *     `partial.refundAmount`, no stock or COGS (postAmountOnlyRefundJournal,
 *     owner decision 2026-10-01).
 *
 * Idempotent — postRefundJournal skips already-reversed entries;
 * postPartialReturnJournal posts one entry set per refundKey.
 */
export const accountingPostRefundJournal: JobDef = inngest.createFunction(
  {
    id: 'accounting-post-refund-journal',
    name: 'Accounting — post journal reversal on refund',
    retries: 3,
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'order/refunded' }],
  },
  async ({ event, step }) => {
    // NOTE: no `refundReason` read — no producer of order/refunded sets one
    // (issue 1191). The partial path reads the merchant-entered reason off
    // the Return row named by refundKey; the full path uses reverseEntry's
    // default memo.
    const { orderId, storeId, partial } = (event.data ?? {}) as {
      orderId?: string;
      storeId?: string;
      partial?: {
        items?: Array<{ orderItemId: string; quantity: number }>;
        refundKey?: string;
        refundAmount?: number;
        amountOnly?: boolean;
      };
    };
    if (!orderId || !storeId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostRefundJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
    }
    // Feature gate — skip any GL posting when accounting.basic is disabled.
    // In a step: on a Workflow only step bodies hold a database connection.
    const accountingEnabled = await step.run('check-feature', () =>
      featureService.isFeatureEnabled(storeId, 'accounting.basic')
    );
    if (!accountingEnabled) {
      logger.info(
        { storeId, orderId },
        'accountingPostRefundJournal: accounting.basic disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', feature: 'accounting.basic' };
    }
    // A partial refund made outside a return carries no lines, only an
    // amount. It must never reach the whole-sale reversal below.
    if (partial?.amountOnly) {
      const refundKey = partial.refundKey;
      const amount = partial.refundAmount;
      if (!refundKey || typeof amount !== 'number') {
        logger.error(
          { storeId, orderId, refundKey, amount },
          'accountingPostRefundJournal: amount-only refund event missing refundKey/amount — skipping'
        );
        return { skipped: 'amount-only-missing-fields' };
      }
      return step.run('post-amount-only-refund', () =>
        postAmountOnlyRefundJournal({ orderId, storeId, refundKey, amount })
      );
    }
    // Partial-return events carry an item-level payload; postRefundJournal
    // reverses the WHOLE sale journal, which would erase revenue the merchant
    // still keeps. Post the pro-rata adjustment for the returned lines
    // instead, keyed on refundKey (the Return id) for at-least-once safety —
    // mirrors the fanout's refusal of a keyless partial event.
    if (partial && Array.isArray(partial.items) && partial.items.length > 0) {
      const refundKey = partial.refundKey;
      const partialItems = partial.items;
      if (!refundKey) {
        logger.error(
          { storeId, orderId },
          'accountingPostRefundJournal: partial event missing refundKey — skipping'
        );
        return { skipped: 'partial-missing-refund-key' };
      }
      const partialResult = await step.run('post-partial-return-adjustment', () =>
        postPartialReturnJournal({
          orderId,
          storeId,
          refundKey,
          items: partialItems,
        })
      );
      logger.info(
        { orderId, storeId, refundKey, ...partialResult },
        'accountingPostRefundJournal: partial adjustment done'
      );
      return partialResult;
    }
    const result = await step.run('reverse-journal', () => postRefundJournal({ orderId, storeId }));
    logger.info(
      { orderId, storeId, reversed: result.reversed },
      'accountingPostRefundJournal: done'
    );
    return result;
  }
);
