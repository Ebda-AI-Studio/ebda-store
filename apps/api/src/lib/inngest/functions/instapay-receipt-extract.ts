import type { JobDef } from '../../jobs/types';
import { runInStoreScope } from '@ebda/database';
import logger from '../../logger';
import { inngest } from '../client';
import { InstapayReceiptService } from '../../../services/payment-providers/instapay-receipt.service';

/**
 * Read an uploaded InstaPay receipt on Workers AI (money batch A, Ruling EBDA-MONEYA-2).
 *
 * Runs under a STORE SCOPE (per-query, no transaction held across the AI call). The
 * service bounds the call with a timeout and turns every failure into
 * `extraction_status = failed`, which the payer sees as manual entry — so the function
 * itself never needs a retry to keep the payer moving (retries: 0: a retry would only
 * re-spend AI quota on an image that already failed).
 */
export const instapayReceiptExtract: JobDef = inngest.createFunction(
  {
    id: 'instapay-receipt-extract',
    name: 'InstaPay — read an uploaded transfer receipt',
    retries: 0,
    concurrency: { limit: 3, key: 'event.data.storeId' },
    triggers: [{ event: 'instapay/receipt-extract' }],
  },
  async ({ event, step }) => {
    const { storeId, receiptId } = (event.data ?? {}) as { storeId?: string; receiptId?: string };
    if (!storeId || !receiptId) {
      logger.warn({ data: event.data }, 'instapayReceiptExtract: missing ids');
      return { skipped: 'missing-ids' };
    }
    const outcome = await step.run('read-receipt', () =>
      runInStoreScope(storeId, () => InstapayReceiptService.runExtraction(storeId, receiptId))
    );
    // INSTAPAY-AUTO-1: the typed auto-confirm read (subscription receipts, mode not off), then a decision when the claim already exists.
    let auto: string | null = null;
    if (outcome === 'done') {
      auto = await step.run('auto-read', () =>
        runInStoreScope(storeId, () => InstapayReceiptService.runAutoExtraction(storeId, receiptId))
      );
      if (auto !== 'skipped') {
        await step.run('auto-enqueue', () =>
          runInStoreScope(storeId, () =>
            InstapayReceiptService.enqueueIfClaimed(storeId, receiptId)
          )
        );
      }
    }
    return { storeId, receiptId, outcome, auto };
  }
);
