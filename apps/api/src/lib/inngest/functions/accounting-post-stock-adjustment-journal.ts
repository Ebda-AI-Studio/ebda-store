import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { postStockAdjustmentJournal } from '../../../services/accounting/posting/stock-adjustment-posting';
import { featureService } from '../../../services/feature.service';

/**
 * Listens to `stock/adjustment-posted` (fired by stock-adjustment.service.postAdjustment)
 * and posts the double-entry GL journal:
 *   - impact > 0: DR Inventory (1200) / CR Counterpart (type-mapped account)
 *   - impact < 0: DR Counterpart / CR Inventory (1200)
 *
 * Idempotent via journal.service's (source, sourceId) lookup.
 * Concurrency keyed per-store (limit 5) to prevent sequence races.
 */
export const accountingPostStockAdjustmentJournal: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-post-stock-adjustment-journal',
    name: 'Accounting — post journal on stock adjustment',
    retries: 3,
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'stock/adjustment-posted' }],
  },
  async ({ event, step }) => {
    const { storeId, adjustmentId } = (event.data ?? {}) as {
      storeId?: string;
      adjustmentId?: string;
    };
    if (!storeId || !adjustmentId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostStockAdjustmentJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
    }
    // Feature gate — skip GL posting when inventory.bulk_adjustments is disabled.
    const enabled = await featureService.isFeatureEnabled(storeId, 'inventory.bulk_adjustments');
    if (!enabled) {
      logger.info(
        { storeId, adjustmentId },
        'accountingPostStockAdjustmentJournal: inventory.bulk_adjustments disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', feature: 'inventory.bulk_adjustments' };
    }
    await step.run('post-journal', () => postStockAdjustmentJournal({ storeId, adjustmentId }));
    logger.info({ adjustmentId, storeId }, 'accountingPostStockAdjustmentJournal: posted');
    return { posted: true, adjustmentId };
  }
);
