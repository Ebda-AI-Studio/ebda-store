import { prisma } from '@ebda/database';
import type { StockAdjustmentType } from '@prisma/client';
import { postEntry } from '../journal.service';
import { getSystemAccountIdByCode } from '../account.service';
import logger from '../../../lib/logger';
import { storeMoney } from '../../../lib/repo-factory';

/**
 * Counterpart account code per adjustment type.
 * cycle_count + found → Owner's Equity (3000)
 * damage / theft / loss → Operating Expense (5900 / 5910)
 * write_off → Write-off Expense (5920)
 * return_to_supplier → Accounts Payable (2000)
 * fallback → Other Expense (5990)
 */
const COUNTERPART_CODE: Record<StockAdjustmentType, string> = {
  cycle_count: '3000',
  damage: '5900',
  theft: '5910',
  loss: '5900',
  write_off: '5920',
  found: '3000',
  return_to_supplier: '2000',
};

export interface StockAdjustmentJournalInput {
  storeId: string;
  adjustmentId: string;
}

/**
 * Post the GL journal for a stock adjustment.
 *
 * Sign convention:
 *   impact > 0 (inventory went up): DR Inventory (1200) / CR Counterpart
 *   impact < 0 (inventory went down): DR Counterpart / CR Inventory (1200)
 *
 * Idempotent via postEntry's (source, sourceId) lookup.
 * Guards: skips if adjustment not found, accounting disabled, or not posted.
 */
export async function postStockAdjustmentJournal(args: StockAdjustmentJournalInput): Promise<void> {
  // A store on its Durable Object posts in one section there (Ruling CF-JOBS-4); idempotent per source row.
  const money = await storeMoney(args.storeId);
  if (money) {
    await money.journalStockAdjustment({ adjustmentId: args.adjustmentId });
    return;
  }
  const adjustment = await prisma.stockAdjustment.findFirst({
    where: { id: args.adjustmentId, storeId: args.storeId },
    include: { store: { select: { accountingEnabled: true } } },
  });

  if (!adjustment) {
    logger.warn(
      { adjustmentId: args.adjustmentId, storeId: args.storeId },
      'postStockAdjustmentJournal: adjustment not found'
    );
    return;
  }

  if (!adjustment.store?.accountingEnabled) {
    logger.info(
      { adjustmentId: args.adjustmentId, storeId: args.storeId },
      'postStockAdjustmentJournal: accounting disabled'
    );
    return;
  }

  if (adjustment.status !== 'posted') {
    logger.warn(
      { adjustmentId: args.adjustmentId, status: adjustment.status },
      'postStockAdjustmentJournal: adjustment not in posted status'
    );
    return;
  }

  const impact = adjustment.totalValueImpact;
  if (impact === 0) {
    logger.info(
      { adjustmentId: args.adjustmentId },
      'postStockAdjustmentJournal: zero impact — no journal needed'
    );
    return;
  }

  const counterpartCode = COUNTERPART_CODE[adjustment.type] ?? '5990';
  const inventoryAccountId = await getSystemAccountIdByCode(args.storeId, '1200');
  const counterpartAccountId = await getSystemAccountIdByCode(args.storeId, counterpartCode);

  const absImpact = Math.abs(impact);

  const lines =
    impact > 0
      ? [
          {
            accountId: inventoryAccountId,
            debit: absImpact,
            credit: 0,
            lineMemo: `Inventory up — ${adjustment.adjustmentNumber}`,
            refTable: 'stock_adjustments',
            refId: adjustment.id,
          },
          {
            accountId: counterpartAccountId,
            debit: 0,
            credit: absImpact,
            lineMemo: `${adjustment.type} — ${adjustment.adjustmentNumber}`,
            refTable: 'stock_adjustments',
            refId: adjustment.id,
          },
        ]
      : [
          {
            accountId: counterpartAccountId,
            debit: absImpact,
            credit: 0,
            lineMemo: `${adjustment.type} — ${adjustment.adjustmentNumber}`,
            refTable: 'stock_adjustments',
            refId: adjustment.id,
          },
          {
            accountId: inventoryAccountId,
            debit: 0,
            credit: absImpact,
            lineMemo: `Inventory down — ${adjustment.adjustmentNumber}`,
            refTable: 'stock_adjustments',
            refId: adjustment.id,
          },
        ];

  await postEntry({
    storeId: args.storeId,
    source: 'stock_adjustment',
    sourceId: adjustment.id,
    memo: `Stock adjustment — ${adjustment.adjustmentNumber}`,
    memoAr: `تسوية مخزون — ${adjustment.adjustmentNumber}`,
    lines,
  });

  logger.info(
    { adjustmentId: adjustment.id, impact, counterpartCode },
    'postStockAdjustmentJournal: posted'
  );
}
