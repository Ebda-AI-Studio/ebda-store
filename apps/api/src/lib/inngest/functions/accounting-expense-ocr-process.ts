import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { processExpenseReceipt } from '../../../services/accounting/expense-ocr.service';

/**
 * Inngest function — OCR-process an uploaded expense receipt.
 *
 * Triggered by `accounting/expense-ocr-process` after the upload route
 * stores the image in R2 and wants async OCR extraction.
 *
 * Concurrency is keyed per-store (5 concurrent per store) so a burst
 * of uploads from one merchant doesn't starve others.
 *
 * retries: 2 — Gemini transient errors are retriable; permanent failures
 * (malformed image, unsupported format) are caught inside the service and
 * create a draft with a note instead of throwing.
 */
export const accountingExpenseOcrProcess: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-expense-ocr-process',
    name: 'Accounting — OCR-process uploaded expense receipt',
    retries: 2,
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'accounting/expense-ocr-process' }],
  },
  async ({ event, step }) => {
    const { storeId, receiptUrl, uploadedBy } = (event.data ?? {}) as {
      storeId?: string;
      receiptUrl?: string;
      uploadedBy?: string;
    };

    if (!storeId || !receiptUrl) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingExpenseOcrProcess: missing ids'
      );
      return { skipped: 'missing-ids' };
    }

    const result = await step.run('process-ocr', () =>
      processExpenseReceipt({ storeId, receiptUrl, uploadedBy })
    );

    logger.info({ storeId, expenseId: result.expenseId }, 'accountingExpenseOcrProcess: done');
    return result;
  }
);
