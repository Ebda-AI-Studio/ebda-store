import { prisma } from '@ebda/database';
import { postEntry } from '../journal.service';
import { getSystemAccountIdByCode } from '../account.service';
import logger from '../../../lib/logger';
import { storeDb, storeMoney } from '../../../lib/repo-factory';

export interface PoReceiveJournalInput {
  storeId: string;
  poId: string;
  clearedBackorders: Array<{
    backorderLineId: string;
    orderItemId: string;
    qty: number;
    actualUnitCost: number;
    estimateUnitCost: number;
    variance: number;
  }>;
}

/**
 * Post the GL journal for a PO receipt + any cleared backorder COGS entries.
 *
 * Posts up to N+1 entries (one main, optionally N variance-aware deferred-COGS):
 *   1. PO receive (sourceId = `<poId>:recv:<cumulative>`)
 *      DR Inventory  = sum(item.qtyReceived * item.unitCost) newly received since the last pass
 *      CR Accounts Payable  = same total
 *   2. For each cleared backorder line (sourceId = `bo:<backorderLineId>:cogs`):
 *      DR COGS                actualUnitCost * qty
 *      CR Inventory           same
 *      (and if variance != 0: DR/CR COGS Variance + opposite Inventory)
 *
 * Idempotent via postEntry's (source, sourceId) lookup.
 *
 * Each receive pass posts only the delta since the last pass, keyed
 * `<poId>:recv:<cumulative received value>` (ACCT-AUDIT-1); a replay posts nothing.
 */
export async function postPoReceiveJournal(args: PoReceiveJournalInput): Promise<void> {
  // A store on its Durable Object posts in one section there (Ruling CF-JOBS-4); idempotent per source row.
  const money = await storeMoney(args.storeId);
  if (money) {
    await money.journalPoReceive({ poId: args.poId, clearedBackorders: args.clearedBackorders });
    return;
  }
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: args.poId, storeId: args.storeId },
    include: { items: true, store: { select: { accountingEnabled: true } } },
  });
  if (!po) {
    logger.warn({ poId: args.poId }, 'postPoReceiveJournal: PO not found');
    return;
  }
  if (!po.store?.accountingEnabled) {
    logger.info(
      { poId: args.poId, storeId: args.storeId },
      'postPoReceiveJournal: accounting disabled'
    );
    return;
  }

  const inventoryAccountId = await getSystemAccountIdByCode(args.storeId, '1200');
  const apAccountId = po.apAccountId ?? (await getSystemAccountIdByCode(args.storeId, '2000'));
  const cogsAccountId = await getSystemAccountIdByCode(args.storeId, '5000');
  const cogsVarianceAccountId = await getSystemAccountIdByCode(args.storeId, '5010');

  // === 1. PO receive — DR Inventory / CR AP ===
  // Sum all received line values. For v1 single-shot receives this equals the
  // full PO receipt. Idempotency via sourceId=poId prevents double-posting.
  const receivedTotal = po.items.reduce((s, i) => s + i.qtyReceived * i.unitCost, 0);
  // ACCT-AUDIT-1: post only the DELTA over what this PO already booked to Inventory (old `poId` entry + per-pass
  // `poId:recv:<cumulative>` entries), keyed by the cumulative value, so a later partial receipt is never dropped.
  const bookedAgg = await (
    await storeDb(args.storeId)
  ).journalLine.aggregate({
    _sum: { debit: true },
    where: {
      accountId: inventoryAccountId,
      refTable: 'purchase_orders',
      refId: po.id,
      entry: {
        storeId: args.storeId,
        source: 'purchase_order',
        status: 'posted',
        OR: [{ sourceId: args.poId }, { sourceId: { startsWith: `${args.poId}:recv:` } }],
      },
    },
  });
  const delta = receivedTotal - (bookedAgg._sum.debit ?? 0);
  if (delta > 0) {
    await postEntry({
      storeId: args.storeId,
      source: 'purchase_order',
      sourceId: `${args.poId}:recv:${receivedTotal}`,
      // ACCT-AUDIT-3: keeps the date the goods were received on
      postedAt: po.receivedAt && po.receivedAt < new Date() ? po.receivedAt : undefined,
      memo: `PO receive — ${po.poNumber}`,
      memoAr: `استلام أمر شراء — ${po.poNumber}`,
      lines: [
        {
          accountId: inventoryAccountId,
          debit: delta,
          credit: 0,
          lineMemo: `Inventory in (PO ${po.poNumber})`,
          refTable: 'purchase_orders',
          refId: po.id,
        },
        {
          accountId: apAccountId,
          debit: 0,
          credit: delta,
          lineMemo: `AP — supplier`,
          refTable: 'purchase_orders',
          refId: po.id,
        },
      ],
    });
  }

  // === 2. Deferred-COGS for cleared backorders ===
  for (const cleared of args.clearedBackorders) {
    const cogsAmount = cleared.actualUnitCost * cleared.qty;
    if (cogsAmount <= 0) continue;

    const cogsLines: Array<{
      accountId: string;
      debit: number;
      credit: number;
      lineMemo?: string;
      refTable?: string;
      refId?: string;
    }> = [
      {
        accountId: cogsAccountId,
        debit: cogsAmount,
        credit: 0,
        lineMemo: `Deferred COGS (backorder ${cleared.backorderLineId.slice(0, 8)})`,
        refTable: 'backorder_lines',
        refId: cleared.backorderLineId,
      },
      {
        accountId: inventoryAccountId,
        debit: 0,
        credit: cogsAmount,
        lineMemo: 'Inventory out (deferred)',
        refTable: 'backorder_lines',
        refId: cleared.backorderLineId,
      },
    ];

    // Variance correction when actual cost differs from sale-time estimate.
    // variance = (actualUnitCost - estimateUnitCost) * qty
    //   > 0 → actual > estimate → we under-recognized COGS: DR COGS Variance / CR Inventory
    //   < 0 → actual < estimate → we over-recognized COGS: DR Inventory / CR COGS Variance
    if (cleared.variance !== 0) {
      if (cleared.variance > 0) {
        cogsLines.push({
          accountId: cogsVarianceAccountId,
          debit: cleared.variance,
          credit: 0,
          lineMemo: 'COGS variance (actual > estimate)',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
        cogsLines.push({
          accountId: inventoryAccountId,
          debit: 0,
          credit: cleared.variance,
          lineMemo: 'Variance contra-inventory',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
      } else {
        const positive = Math.abs(cleared.variance);
        cogsLines.push({
          accountId: inventoryAccountId,
          debit: positive,
          credit: 0,
          lineMemo: 'Variance contra-inventory',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
        cogsLines.push({
          accountId: cogsVarianceAccountId,
          debit: 0,
          credit: positive,
          lineMemo: 'COGS variance (actual < estimate)',
          refTable: 'backorder_lines',
          refId: cleared.backorderLineId,
        });
      }
    }

    await postEntry({
      storeId: args.storeId,
      source: 'purchase_order',
      sourceId: `bo:${cleared.backorderLineId}:cogs`,
      memo: `Deferred COGS — backorder fulfilled by ${po.poNumber}`,
      memoAr: `تكلفة بضاعة مؤجلة — تم تنفيذ الطلب المعلق بـ ${po.poNumber}`,
      lines: cogsLines,
    });
  }
}
