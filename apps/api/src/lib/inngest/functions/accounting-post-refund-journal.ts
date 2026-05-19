import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { postRefundJournal } from '../../../services/accounting/posting/refund-posting';

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
    const { orderId, storeId, refundReason } = (event.data ?? {}) as {
      orderId?: string;
      storeId?: string;
      refundReason?: string;
    };
    if (!orderId || !storeId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostRefundJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
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
