import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { postPoReceiveJournal } from '../../../services/accounting/posting/po-receive-posting';

/**
 * Listens to `stock/po-received` (fired by purchase-order.service.receivePurchaseOrder)
 * and posts the double-entry GL journal:
 *   - Main AP entry: DR Inventory (1200) / CR AP (po.apAccountId or 2000)
 *   - Per cleared backorder: DR COGS (5000) / CR Inventory (1200) ± variance lines (5010)
 *
 * Idempotent via journal.service's (source, sourceId) lookup.
 * Concurrency keyed per-store (limit 5) to prevent sequence races.
 */
export const accountingPostPoReceiveJournal: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-post-po-receive-journal',
    name: 'Accounting — post journal on PO receipt',
    retries: 3,
    concurrency: { limit: 5, key: 'event.data.storeId' },
    triggers: [{ event: 'stock/po-received' }],
  },
  async ({ event, step }) => {
    const { storeId, poId, clearedBackorders } = (event.data ?? {}) as {
      storeId?: string;
      poId?: string;
      clearedBackorders?: any[];
    };
    if (!storeId || !poId) {
      logger.warn(
        { event: event.name, data: event.data },
        'accountingPostPoReceiveJournal: missing ids'
      );
      return { skipped: 'missing-ids' };
    }
    await step.run('post-journal', () =>
      postPoReceiveJournal({ storeId, poId, clearedBackorders: clearedBackorders ?? [] })
    );
    logger.info(
      { poId, storeId, clearedCount: clearedBackorders?.length ?? 0 },
      'accountingPostPoReceiveJournal: posted'
    );
    return { posted: true, poId };
  }
);
