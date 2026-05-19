import { prisma } from '@force/database';
import type { Prisma } from '@prisma/client';
import { getSystemAccountIdByCode } from '../account.service';
import { postEntry } from '../journal.service';
import logger from '../../../lib/logger';

/**
 * Maps a Payment.provider value to the COA system account code that should
 * be debited when that provider's payment is received. KNET = 1000,
 * Card (Tap/Hesabe/UPayments) = 1010, COD = 1020.
 */
const PROVIDER_TO_CASH_CODE: Record<string, string> = {
  myfatoorah: '1000',
  tap: '1010',
  hesabe: '1010',
  upayments: '1010',
  cod: '1020',
};

/**
 * Post the GL journal for an Order that has transitioned to paymentStatus='paid'.
 *
 * Posts TWO entries (atomic per-entry, separate idempotency keys):
 *   1. Cash/revenue entry  (sourceId = orderId)
 *      DR Cash[provider]          total
 *      CR Sales Revenue (net)     subtotal - discount
 *      CR Tax Payable             tax (if > 0)
 *      CR Shipping Income         shipping (if > 0)
 *
 *   2. COGS entry  (sourceId = `${orderId}:cogs`)
 *      DR COGS                    sum(item.qty * item.costPrice) for eligible items
 *      CR Inventory               same total
 *      (costPriceDeferred ships in Batch 2 — for Batch 1, no items are deferred.)
 *
 * Idempotent via postEntry's (source, sourceId) lookup. Safe to fire multiple
 * times (webhook retries, refresh-payment safety net, Inngest retries).
 *
 * Returns silently if:
 *   - Order not found (logged as warn)
 *   - Order.paymentStatus is not 'paid' (logged as info)
 *   - Order.store.accountingEnabled is false (logged as info)
 *   - Order.store has no seeded COA — postEntry throws via getSystemAccountIdByCode
 */
export async function postOrderPaymentJournal(args: {
  orderId: string;
  tx?: Prisma.TransactionClient;
}): Promise<void> {
  const { orderId, tx } = args;
  const client: Prisma.TransactionClient | typeof prisma = tx ?? prisma;

  const order = await client.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      payments: { where: { status: 'completed' } },
      store: { select: { id: true, accountingEnabled: true } },
    },
  });
  if (!order) {
    logger.warn({ orderId }, 'postOrderPaymentJournal: order not found');
    return;
  }
  if (order.paymentStatus !== 'paid') {
    logger.info(
      { orderId, paymentStatus: order.paymentStatus },
      'postOrderPaymentJournal: skipping non-paid order'
    );
    return;
  }
  if (!order.store?.accountingEnabled) {
    logger.info(
      { orderId, storeId: order.storeId },
      'postOrderPaymentJournal: accounting disabled'
    );
    return;
  }

  const completedPayment = order.payments[0];
  const provider = completedPayment?.provider ?? 'cod';
  const cashCode = PROVIDER_TO_CASH_CODE[provider] ?? '1000';

  const cashAccountId = await getSystemAccountIdByCode(order.storeId, cashCode, client);
  const revenueAccountId = await getSystemAccountIdByCode(order.storeId, '4000', client);
  const taxPayableAccountId = await getSystemAccountIdByCode(order.storeId, '2100', client);
  const shippingIncomeId = await getSystemAccountIdByCode(order.storeId, '4010', client);
  const cogsAccountId = await getSystemAccountIdByCode(order.storeId, '5000', client);
  const inventoryAccountId = await getSystemAccountIdByCode(order.storeId, '1200', client);

  // --- Cash / revenue entry ---
  const netRevenue = order.subtotal - order.discount;
  const cashLines: Array<{
    accountId: string;
    debit: number;
    credit: number;
    lineMemo?: string;
    refTable?: string;
    refId?: string;
  }> = [
    {
      accountId: cashAccountId,
      debit: order.total,
      credit: 0,
      lineMemo: `Order ${order.orderNumber} payment`,
      refTable: 'orders',
      refId: order.id,
    },
  ];
  if (netRevenue > 0)
    cashLines.push({
      accountId: revenueAccountId,
      debit: 0,
      credit: netRevenue,
      lineMemo: 'Sales revenue (net of discount)',
      refTable: 'orders',
      refId: order.id,
    });
  if (order.tax > 0)
    cashLines.push({
      accountId: taxPayableAccountId,
      debit: 0,
      credit: order.tax,
      lineMemo: 'Tax collected',
      refTable: 'orders',
      refId: order.id,
    });
  if (order.shipping > 0)
    cashLines.push({
      accountId: shippingIncomeId,
      debit: 0,
      credit: order.shipping,
      lineMemo: 'Shipping fee',
      refTable: 'orders',
      refId: order.id,
    });

  await postEntry({
    storeId: order.storeId,
    source: 'order',
    sourceId: order.id,
    memo: `Sale — Order ${order.orderNumber}`,
    memoAr: `بيع — طلب ${order.orderNumber}`,
    lines: cashLines,
    tx,
  });

  // --- COGS entry (only if any item has a costPrice) ---
  // costPriceDeferred ships in Batch 2 (backorder support); for Batch 1, no items are deferred.
  // if (item.costPriceDeferred) continue;
  let totalCogs = 0;
  const cogsLines: Array<{
    accountId: string;
    debit: number;
    credit: number;
    lineMemo?: string;
    refTable?: string;
    refId?: string;
  }> = [];
  for (const item of order.items) {
    if (!item.costPrice || item.costPrice <= 0) continue;
    const itemCogs = item.costPrice * item.quantity;
    totalCogs += itemCogs;
    cogsLines.push({
      accountId: cogsAccountId,
      debit: itemCogs,
      credit: 0,
      lineMemo: `COGS — ${item.productName} × ${item.quantity}`,
      refTable: 'order_items',
      refId: item.id,
    });
    cogsLines.push({
      accountId: inventoryAccountId,
      debit: 0,
      credit: itemCogs,
      lineMemo: `Inventory out — ${item.productName} × ${item.quantity}`,
      refTable: 'order_items',
      refId: item.id,
    });
  }
  if (totalCogs > 0) {
    await postEntry({
      storeId: order.storeId,
      source: 'order',
      sourceId: `${order.id}:cogs`,
      memo: `COGS — Order ${order.orderNumber}`,
      memoAr: `تكلفة البضاعة — طلب ${order.orderNumber}`,
      lines: cogsLines,
      tx,
    });
  }
}
