import { prisma, currentStoreId } from '@ebda/database';
import type { Prisma } from '@prisma/client';
import { getSystemAccountIdByCode } from '../account.service';
import { postEntry } from '../journal.service';
import logger from '../../../lib/logger';
import { storeMoney } from '../../../lib/repo-factory';

/**
 * Maps a Payment.provider value to the COA system account code that should
 * be debited when that provider's payment is received. Multi-method / instant
 * gateways (Paymob: cards, Meeza, wallets, valU; Fawry: reference codes) = 1000
 * 'Cash Online', the card-first hosted gateway (Kashier) = 1010 'Cash Card', COD = 1020.
 * The split is inherited from the gateways it replaced (aggregator -> 1000,
 * card gateway -> 1010) and is an accounting choice the owner has not re-confirmed
 * for Egypt: it only decides WHICH asset account the receipt is booked to, never an amount.
 */
export const PROVIDER_TO_CASH_CODE: Record<string, string> = {
  paymob: '1000',
  kashier: '1010',
  fawry: '1000',
  // Geidea: a card-first hosted gateway, booked like Kashier (an accounting choice, not an amount).
  geidea: '1010',
  cod: '1020',
  // InstaPay: a bank transfer the merchant confirmed (SP6a), booked with the instant methods.
  instapay: '1000',
};

/**
 * Post the GL journal for an Order that has transitioned to paymentStatus='paid'.
 *
 * Posts TWO entries (atomic per-entry, separate idempotency keys):
 *   1. Cash/revenue entry  (sourceId = orderId)
 *      DR Cash[provider]          total
 *      CR Sales Revenue (net)     subtotal - discount [- tax, if tax-inclusive]
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
 *   - Order is already cancelled/refunded (logged as warn — no sale to book)
 *   - Order.store.accountingEnabled is false (logged as info)
 *   - Order.walletAmount > 0 (logged as warn — Ruling W-3, see below)
 *   - Order.store has no seeded COA — postEntry throws via getSystemAccountIdByCode
 */
export async function postOrderPaymentJournal(args: {
  orderId: string;
  tx?: Prisma.TransactionClient;
}): Promise<void> {
  const { orderId, tx } = args;
  // A store on its Durable Object posts its own ledger there, in one section (Ruling CF-LEDGER-1).
  const money = await storeMoney(currentStoreId());
  if (money) {
    const r = await money.journalSale({ orderId });
    if (!r.posted)
      logger.info(
        { orderId, skipped: r.skipped },
        'postOrderPaymentJournal: not posted (Durable Object)'
      );
    return;
  }
  const client: Prisma.TransactionClient | typeof prisma = tx ?? prisma;

  const order = await client.order.findUnique({
    where: { id: orderId, storeId: currentStoreId() },
    include: {
      items: true,
      payments: { where: { status: 'completed' } },
      store: { select: { id: true, accountingEnabled: true } },
      // Audit trail: names which lever (coupon code vs. automatic promotion)
      // produced the discount netted out of revenue below, so the GL memo
      // isn't a bare "net of discount" with no way to trace it back.
      appliedPromotion: { select: { name: true } },
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
  // An order that is ALREADY cancelled or refunded must not get a sale entry.
  // The refund reversal (postRefundJournal) reverses whatever sale entry
  // exists WHEN it runs; a sale posted after it has nothing left to reverse
  // it, and books revenue for money that was handed back. Production had one:
  // an order refunded by status in May (paymentStatus left at 'paid') was
  // re-swept by the 2026-07-09 order-created stuck sweep, whose fanout posted
  // its sale — revenue with no reversal (demo-shop, JE-2026-000018). A
  // cancelled order that captured money is refunded on cancel the same way,
  // so both statuses mean "no sale to book".
  if (order.status === 'cancelled' || order.status === 'refunded') {
    logger.warn(
      { orderId, storeId: order.storeId, status: order.status },
      'postOrderPaymentJournal: order already cancelled/refunded — sale NOT posted'
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
  // Customer-wallet spend (D1). The chart of accounts has no store-credit
  // liability account yet (Ruling W-3), so the cash line below — `order.total`
  // — would book the wallet portion as cash that never arrived. Wallet
  // checkout is refused while accounting is on (WalletService.
  // getCheckoutAvailability), so reaching here means accounting was switched
  // on between checkout and payment. Refuse to post a wrong entry and say so;
  // the order stays un-journaled, which the refund path already tolerates
  // (postRefundJournal no-ops when no entry exists).
  if (order.walletAmount > 0) {
    logger.warn(
      { orderId, storeId: order.storeId, walletAmount: order.walletAmount },
      'postOrderPaymentJournal: wallet-paid order NOT journaled — store-credit liability is not modelled in the GL (Ruling W-3)'
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
  // Revenue is booked NET of VAT, whichever convention the order was charged
  // under (`order.taxIncludedInPrice`, frozen at sale time — ruling M3-7):
  //   exclusive — `tax` was added on top of `subtotal`, so `subtotal - discount`
  //     is already net and DR Cash (`total`) covers revenue + tax + shipping.
  //   inclusive — `subtotal` is GROSS and `total` deliberately does NOT add
  //     `tax` again, so the VAT portion has to come OUT of revenue. Crediting
  //     the gross here would put CR over DR by exactly `order.tax` and
  //     postEntry would reject the whole entry ("Journal lines unbalanced"),
  //     dead-lettering every paid order of an inclusive-VAT store.
  const netRevenue = order.subtotal - order.discount - (order.taxIncludedInPrice ? order.tax : 0);
  // Discount lever, for the revenue lineMemo below. `order.discount` (used
  // for netRevenue above) already reconciles couponDiscount + promotionDiscount
  // + loyaltyDiscount — this only labels WHICH lever fired, it doesn't change
  // any amount.
  const discountLever = order.couponCode
    ? `coupon ${order.couponCode}`
    : order.appliedPromotion
      ? `promotion "${order.appliedPromotion.name}"`
      : null;
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
      lineMemo:
        order.discount > 0 && discountLever
          ? `Sales revenue (net of discount — ${discountLever})`
          : 'Sales revenue (net of discount)',
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
