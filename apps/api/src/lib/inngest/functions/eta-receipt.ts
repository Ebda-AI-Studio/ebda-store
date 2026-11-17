import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { EtaReceiptService, type ReturnEvent } from '../../../services/eta-receipt.service';
import { withStoreRw } from '../../jobs/store-db';

/**
 * Egypt ETA e-receipts (Ruling ETA-1, plan docs/plans/done/2026-10-07-egypt-vat-and-eta.md addendum).
 *
 *  etaReceiptEnqueue  order/created, order/refunded -> writes the eta_receipts row (flag + connection
 *                     gated, so a store without the feature costs one cached flag read) and sends
 *                     eta/receipt.submit; a failed send marks the row failed (fail fast).
 *  etaReceiptSubmit   ONE attempt per run, serialized per store (the previousUUID chain is ordered per
 *                     POS). When the row needs another attempt (retry or verdict poll) it hands the
 *                     time to etaReceiptRedrive instead of sleeping, so the per-store slot is never
 *                     held for hours.
 *  etaReceiptRedrive  durable timer: sleeps until `at`, re-sends eta/receipt.submit.
 */
export const etaReceiptEnqueue: JobDef = inngest.createFunction(
  {
    id: 'eta-receipt-enqueue',
    name: 'ETA e-receipt — queue a receipt for a created or refunded order',
    retries: 3,
    triggers: [{ event: 'order/created' }, { event: 'order/refunded' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as {
      orderId?: string;
      storeId?: string;
      partial?: unknown;
    };
    if (!orderId || !storeId) return;
    return step.run('enqueue', async () => {
      if (event.name === 'order/refunded') {
        if (!(await EtaReceiptService.isEnabledForStore(storeId))) return 'skipped';
        return EtaReceiptService.enqueueReturn(
          storeId,
          orderId,
          (event.data as { partial?: ReturnEvent }).partial ?? null
        );
      }
      return EtaReceiptService.enqueueSale(storeId, orderId);
    });
  }
);

export const etaReceiptSubmit: JobDef = inngest.createFunction(
  {
    id: 'eta-receipt-submit',
    name: 'ETA e-receipt — submit one receipt / poll its verdict',
    retries: 3,
    concurrency: { key: 'event.data.storeId', limit: 1 },
    triggers: [{ event: 'eta/receipt.submit' }],
    onFailure: async ({ event }: { event: { data: unknown } }) => {
      const d = (event.data as { event?: { data?: { storeId?: string; receiptId?: string } } })
        .event?.data;
      if (d?.storeId && d?.receiptId)
        await EtaReceiptService.markJobCrashed(d.storeId, d.receiptId);
    },
  },
  async ({ event, step }) => {
    const { storeId, receiptId } = event.data as { storeId?: string; receiptId?: string };
    if (!storeId || !receiptId) return;
    const out = await step.run('attempt', async () => {
      const status = await EtaReceiptService.processReceipt(storeId, receiptId);
      const next =
        status === 'retrying' || status === 'submitted'
          ? await withStoreRw(storeId, db =>
              db.etaReceipt.findFirst({
                where: { id: receiptId, storeId },
                select: { nextAttemptAt: true },
              })
            )
          : null;
      return {
        status,
        at: next?.nextAttemptAt ? new Date(next.nextAttemptAt).toISOString() : null,
      };
    });
    if (out.at) {
      await step.sendEvent('schedule-next', {
        name: 'eta/receipt.scheduled',
        data: { storeId, receiptId, at: out.at },
      });
    }
    logger.info({ storeId, receiptId, status: out.status }, '[eta] attempt done');
    return out.status;
  }
);

export const etaReceiptRedrive: JobDef = inngest.createFunction(
  {
    id: 'eta-receipt-redrive',
    name: 'ETA e-receipt — wait, then attempt again',
    retries: 3,
    triggers: [{ event: 'eta/receipt.scheduled' }],
  },
  async ({ event, step }) => {
    const { storeId, receiptId, at } = event.data as {
      storeId: string;
      receiptId: string;
      at: string;
    };
    await step.sleepUntil('wait-until-due', new Date(at));
    await step.sendEvent('submit-again', {
      name: 'eta/receipt.submit',
      data: { storeId, receiptId },
    });
  }
);
