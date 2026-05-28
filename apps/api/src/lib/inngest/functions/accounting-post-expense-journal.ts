import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { postExpenseJournal } from '../../../services/accounting/posting/expense-posting';
import { featureService } from '../../../services/feature.service';

/**
 * Listens to `accounting/expense-posted` (fired by expense.service.postExpense)
 * and posts the double-entry GL journal:
 *   DR expenseAccount (total)
 *   CR paidFromAccount (total)
 *
 * v1 simplification: tax recovery is rolled into the expense account line.
 * This will be split out when Kuwait VAT activates (Batch 3+).
 *
 * Idempotent via journal.service's (source, sourceId) lookup.
 * Concurrency keyed per-store (limit 5) to prevent sequence races.
 */
export const accountingPostExpenseJournal: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-post-expense-journal',
    name: 'Accounting — post journal on expense',
    retries: 3,
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'accounting/expense-posted' }],
  },
  async ({ event, step }) => {
    const { storeId, expenseId } = (event.data ?? {}) as {
      storeId?: string;
      expenseId?: string;
    };
    if (!storeId || !expenseId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostExpenseJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
    }
    // Feature gate — skip journal posting when accounting.expenses is disabled.
    const enabled = await featureService.isFeatureEnabled(storeId, 'accounting.expenses');
    if (!enabled) {
      logger.info({ storeId, expenseId }, 'accountingPostExpenseJournal: accounting.expenses disabled, skipping');
      return { skipped: true, reason: 'feature_disabled', feature: 'accounting.expenses' };
    }
    await step.run('post-journal', () => postExpenseJournal({ storeId, expenseId }));
    logger.info({ expenseId, storeId }, 'accountingPostExpenseJournal: posted');
    return { posted: true, expenseId };
  }
);
