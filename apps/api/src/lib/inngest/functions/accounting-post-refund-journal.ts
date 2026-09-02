import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { postRefundJournal } from '../../../services/accounting/posting/refund-posting';
import { featureService } from '../../../services/feature.service';

/**
 * Listens to the canonical order/refunded Inngest event (fired by
 * OrderService.applyRefundEffects + provider refund-webhook handlers) and
 * posts the GL reversal: mirror entries with debits/credits swapped, linked
 * via reversedById.
 *
 * Idempotent — postRefundJournal skips already-reversed entries.
 */
export const accountingPostRefundJournal: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-post-refund-journal',
    name: 'Accounting — post journal reversal on refund',
    retries: 3,
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'order/refunded' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, refundReason, partial } = (event.data ?? {}) as {
      orderId?: string;
      storeId?: string;
      refundReason?: string;
      partial?: { items?: unknown[] };
    };
    if (!orderId || !storeId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostRefundJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
    }
    // Partial-return events carry an item-level payload; postRefundJournal
    // reverses the WHOLE sale journal, which would erase revenue the merchant
    // still keeps. Skip — the GL keeps the original sale for partial returns
    // (documented residual: no partial-return GL adjustment is posted yet).
    if (partial && Array.isArray(partial.items) && partial.items.length > 0) {
      logger.info(
        { storeId, orderId },
        'accountingPostRefundJournal: partial-return event — full journal reversal skipped'
      );
      return { skipped: true, reason: 'partial_refund' };
    }
    // Feature gate — skip reversal when accounting.basic is disabled.
    const accountingEnabled = await featureService.isFeatureEnabled(storeId, 'accounting.basic');
    if (!accountingEnabled) {
      logger.info(
        { storeId, orderId },
        'accountingPostRefundJournal: accounting.basic disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', feature: 'accounting.basic' };
    }
    const result = await step.run('reverse-journal', () =>
      postRefundJournal({ orderId, reason: refundReason })
    );
    logger.info(
      { orderId, storeId, reversed: result.reversed },
      'accountingPostRefundJournal: done'
    );
    return result;
  }
);
