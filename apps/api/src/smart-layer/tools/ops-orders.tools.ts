/**
 * Phase E2 ops tools, orders side: refund, InstaPay receipt review, backorder cancel, shipment booking, invoice e-mail and ETA e-receipt retry.
 * Every write mirrors its admin route gate and calls the same service as the route.
 */
import { type TurnCtx, type ToolSpec } from '@ebda/shared/smart-layer';
import { AppError } from '../../middleware/error-handler';
import { OrderService } from '../../services/order.service';
import { shippingCarrierService } from '../../services/shipping-carrier.service';
import { CARRIER_CODES } from '../../services/carriers/types';
import { listOpenBackorders, cancelBackorder } from '../../services/accounting/backorder.service';
import { InstapayService } from '../../services/payment-providers/instapay.service';
import { InstapayReceiptService } from '../../services/payment-providers/instapay-receipt.service';
import {
  lookupRefundTarget,
  refundThroughProvider,
} from '../../services/order-provider-refund.service';
import { change, egp, f, pair, row, shape } from './kit';
import { EtaReceiptService } from '../../services/eta-receipt.service';
import {
  invoiceEmailSubject,
  invoiceRecipient,
  queueInvoiceEmail,
} from '../../services/order-invoice-email.service';
import { OWNER, OWNER_OR_STAFF, iso, notFound, untrusted, type Rec } from './ops-shared';

const orderRefs = (a: { orderId: string }) => [{ kind: 'order', id: a.orderId }];

// ======================================================================================================================================
// order.refund
// ======================================================================================================================================
type RefundState = {
  orderId: string;
  orderNumber: string;
  provider: string;
  paymentStatus: string;
  transactionId: string;
  paidMinor: number;
  refundedMinor: number;
};
const refundOrder = change<{ orderId: string; reason?: string }>({
  name: 'order_refund',
  capabilityId: 'order.refund',
  description:
    'Refund an online-paid order back to the customer through the payment provider (Paymob, Kashier, Fawry...): the whole remaining balance of the payment. Moves real money, emails the customer and cannot be undone. The amount is read from the order, you cannot type one; for a partial refund the merchant uses the order screen. Cash-on-delivery and InstaPay orders cannot be refunded here. Use for "refund this order", "رجّع فلوس العميل", "ريفند".',
  schema: shape(
    {
      orderId: f.id('The order id.'),
      reason: f.text('Why (kept on the payment, optional).', { max: 500 }),
    },
    ['orderId']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  messagesCustomers: true,
  // order.routes.ts POST /:orderId/refund-via-provider: authorize('store_admin','staff') + requirePermission('orders:refund') (staff lack it). Owner only in practice.
  gate: { roles: OWNER_OR_STAFF, permission: 'orders:refund' },
  audit: { action: 'order.refund_via_provider', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: async (ctx, a): Promise<RefundState> => {
    const t = await lookupRefundTarget(ctx.storeId, a.orderId);
    if (t.kind === 'not_found') throw notFound('Order');
    if (t.kind === 'no_payment')
      throw new AppError(
        400,
        'NO_COMPLETED_PAYMENT',
        'No refundable online payment found for this order. Cash on delivery orders cannot be refunded through a provider.'
      );
    if (t.kind === 'already_refunded')
      throw new AppError(400, 'ALREADY_REFUNDED', 'This order has already been fully refunded.');
    return {
      orderId: t.order.id,
      orderNumber: t.order.orderNumber,
      provider: t.payment.provider,
      paymentStatus: t.order.paymentStatus,
      transactionId: t.payment.transactionId,
      paidMinor: t.payment.amount ?? 0,
      refundedMinor: t.payment.refundedAmount ?? 0,
    };
  },
  describe: (_ctx, a, st) => {
    const s = st as RefundState;
    if (s.provider === 'instapay' || s.provider === 'cod')
      throw new AppError(
        409,
        'REFUND_NOT_VIA_PROVIDER',
        'This order was not paid through an online gateway; record the refund on the order screen.'
      );
    const balance = s.paidMinor - s.refundedMinor;
    if (balance <= 0) throw new AppError(409, 'NOTHING_TO_REFUND', 'Nothing is left to refund.');
    return {
      summary: pair(
        `هرجّع ${egp(balance)} ج.م للعميل عن الأوردر ${s.orderNumber} عن طريق ${s.provider}. دي فلوس حقيقية، العميل هيوصله إيميل، والعملية مينفعش تترجع.`,
        `Refund ${egp(balance)} EGP on order ${s.orderNumber} through ${s.provider}. This moves real money, the customer is emailed and it cannot be undone.`
      ),
      rows: [
        row('الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('بوابة الدفع', 'Payment provider', s.provider, s.provider),
        row('اتدفع (ج.م)', 'Paid (EGP)', egp(s.paidMinor), egp(s.paidMinor)),
        row(
          'اترجّع قبل كده (ج.م)',
          'Already refunded (EGP)',
          egp(s.refundedMinor),
          egp(s.refundedMinor)
        ),
        row('هيترجّع دلوقتي (ج.م)', 'Refunded now (EGP)', null, egp(balance)),
        ...(a.reason ? [row('السبب', 'Reason', null, a.reason)] : []),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a, st) => {
    const s = st as RefundState;
    const balance = s.paidMinor - s.refundedMinor;
    // one key per (conversation, order, refunded-so-far): a retried apply replays the first answer, a later partial balance is a new attempt
    const key = `assistant:${ctx.conversationId}:${s.orderId}:${s.refundedMinor}`
      .replace(/[^A-Za-z0-9._:-]/g, '_')
      .slice(0, 128);
    const r = await refundThroughProvider({
      storeId: ctx.storeId,
      orderId: s.orderId,
      orderNumber: s.orderNumber,
      payment: { transactionId: s.transactionId, provider: s.provider },
      amount: balance,
      reason: a.reason,
      idempotencyKey: key,
    });
    return { refundId: r.refundId, amountMinor: r.amount, status: r.status };
  },
});

// ======================================================================================================================================
// order.instapay-review
// ======================================================================================================================================
async function readInstapayOrder(ctx: TurnCtx, orderId: string) {
  const o = await OrderService.getById(ctx.storeId, orderId);
  const receipts = await InstapayReceiptService.listForOrder(ctx.storeId, orderId);
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    status: String(o.status),
    dueMinor:
      Number(o.total) - Number((o as unknown as { walletAmount?: number }).walletAmount ?? 0),
    updatedAt: iso(o.updatedAt),
    receipts: receipts.map(r => ({
      id: r.id,
      status: r.status,
      amountMinor: r.fields.amountMinor,
      flags: r.flags,
      payerName: r.fields.payerName,
      reference: r.fields.reference,
    })),
  };
}
type InstapayState = Awaited<ReturnType<typeof readInstapayOrder>>;
const AWAITING = 'awaiting_payment_confirmation';
const mustAwait = (s: InstapayState) => {
  if (s.status !== AWAITING)
    throw new AppError(409, 'INSTAPAY_NOT_AWAITING', 'This order is not waiting for a transfer.');
};

const instapayConfirm = change<{ orderId: string }>({
  name: 'instapay_confirm_order',
  capabilityId: 'order.instapay-review',
  description:
    'Confirm that the customer\'s InstaPay transfer arrived in your account and approve their receipt: the order becomes confirmed and paid. Records the payment as money received and cannot be undone, so only after the merchant saw the money. Use for "accept the InstaPay receipt", "اقبل الايصال", "وصلت التحويلة".',
  schema: shape({ orderId: f.id('The order id waiting for an InstaPay transfer.') }, ['orderId']),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  messagesCustomers: true,
  // order.routes.ts POST /:orderId/confirm-instapay: authorize('store_admin','staff') + requirePermission('orders:manage'); Ebda's super admin may not.
  gate: { roles: OWNER_OR_STAFF, permission: 'orders:manage' },
  audit: { action: 'order.instapay_confirmed', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: (ctx, a) => readInstapayOrder(ctx, a.orderId),
  describe: (_ctx, _a, st) => {
    const s = st as InstapayState;
    mustAwait(s);
    return {
      summary: pair(
        `هأكّد إن تحويل InstaPay للأوردر ${s.orderNumber} وصل (${egp(s.dueMinor)} ج.م) وأقبل الإيصال. الأوردر هيتأكد ويتسجل مدفوع، ومينفعش يترجع.`,
        `Confirm that the InstaPay transfer for order ${s.orderNumber} arrived (${egp(s.dueMinor)} EGP) and approve the receipt. The order becomes confirmed and paid; this cannot be undone.`
      ),
      rows: [
        row('الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('المبلغ المطلوب (ج.م)', 'Amount due (EGP)', null, egp(s.dueMinor)),
        row('الحالة', 'Status', s.status, 'confirmed'),
        ...s.receipts.flatMap(r => [
          untrusted(
            row(`إيصال (${r.status})`, `Receipt (${r.status})`, null, `${egp(r.amountMinor)} EGP`)
          ),
          ...(r.flags.length
            ? [untrusted(row('تنبيهات على الإيصال', 'Receipt flags', null, r.flags.join(', ')))]
            : []),
        ]),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const out = await InstapayService.confirm({
      storeId: ctx.storeId,
      orderId: a.orderId,
      actorUserId: ctx.userId,
    });
    return { orderId: out.orderId, changed: out.changed, status: out.status };
  },
  resultTrust: 'untrusted',
});

const instapayReject = change<{ orderId: string; receiptId: string; note: string }>({
  name: 'instapay_reject_receipt',
  capabilityId: 'order.instapay-review',
  description:
    'Reject a customer\'s InstaPay receipt with a reason (wrong amount, wrong account, unreadable, a repeated reference). The order keeps waiting so the customer can send the right one; the reason is shown to the customer exactly as written and it cannot be undone. Use for "reject the receipt", "ارفض الايصال", "الايصال متكرر".',
  schema: shape(
    {
      orderId: f.id('The order id.'),
      receiptId: f.id("The receipt id (from the order's InstaPay receipts)."),
      note: f.str('Reason shown to the customer, at least 3 characters.', { min: 3, max: 500 }),
    },
    ['orderId', 'receiptId', 'note']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  // order.routes.ts POST /:orderId/instapay-receipts/:receiptId/reject: authorize('store_admin','staff') + requirePermission('orders:manage').
  gate: { roles: OWNER_OR_STAFF, permission: 'orders:manage' },
  audit: {
    action: 'order.instapay_receipt_rejected',
    resourceType: 'order',
    resourceId: a => a.orderId,
  },
  refs: orderRefs,
  state: (ctx, a) => readInstapayOrder(ctx, a.orderId),
  describe: (_ctx, a, st) => {
    const s = st as InstapayState;
    mustAwait(s);
    const r = s.receipts.find(x => x.id === a.receiptId);
    if (!r) throw notFound('Receipt');
    return {
      summary: pair(
        `هرفض إيصال InstaPay للأوردر ${s.orderNumber}. السبب هيظهر للعميل بالنص ده بالظبط، والأوردر هيفضل مستني تحويل صح. مينفعش يترجع.`,
        `Reject the InstaPay receipt on order ${s.orderNumber}. The customer sees the reason as written and the order keeps waiting for a correct transfer. This cannot be undone.`
      ),
      rows: [
        row('الأوردر', 'Order', s.orderNumber, s.orderNumber),
        untrusted(row('الإيصال', 'Receipt', r.status, `${egp(r.amountMinor)} EGP`)),
        row('السبب اللي هيوصل للعميل', 'Reason the customer will read', null, a.note),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) =>
    InstapayService.rejectReceipt({
      storeId: ctx.storeId,
      orderId: a.orderId,
      receiptId: a.receiptId,
      note: a.note,
      actorUserId: ctx.userId,
    }),
  resultTrust: 'untrusted',
});

// ======================================================================================================================================
// inventory.backorders
// ======================================================================================================================================
async function readBackorder(ctx: TurnCtx, id: string) {
  const lines = (await listOpenBackorders(ctx.storeId)) as unknown as Array<{
    id: string;
    qty: number;
    qtyFulfilled: number;
    product?: { name?: string; nameAr?: string | null } | null;
    orderItem?: { order?: { orderNumber?: string } | null } | null;
  }>;
  const l = lines.find(x => x.id === id);
  if (!l) throw notFound('Backorder');
  return {
    backorderId: l.id,
    product: l.product?.nameAr || l.product?.name || null,
    orderNumber: l.orderItem?.order?.orderNumber ?? null,
    openQty: Math.max(0, l.qty - l.qtyFulfilled),
  };
}
type BackorderState = Awaited<ReturnType<typeof readBackorder>>;
const cancelBackorderTool = change<{ backorderId: string; reason: string }>({
  name: 'backorder_cancel',
  capabilityId: 'inventory.backorders',
  description:
    'Cancel an open backorder line (a customer ordered an item that was out of stock and you will not fulfil it): the sale for the unfulfilled units is reversed in the accounts and the customer is notified. Cannot be undone. Use for "cancel the backorder", "العميل طلب منتج خلصان وهلغيه".',
  schema: shape(
    {
      backorderId: f.id('The backorder line id.'),
      reason: f.str('Why it is cancelled.', { max: 500 }),
    },
    ['backorderId', 'reason']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  messagesCustomers: true,
  // backorders.routes.ts POST /:storeId/backorders/:id/cancel: authorize('store_admin','super_admin') + requireFeature('inventory.backorder').
  gate: { roles: OWNER, feature: 'inventory.backorder' },
  audit: {
    action: 'backorder.cancelled',
    resourceType: 'backorder_line',
    resourceId: a => a.backorderId,
  },
  state: (ctx, a) => readBackorder(ctx, a.backorderId),
  describe: (_ctx, a, st) => {
    const s = st as BackorderState;
    return {
      summary: pair(
        `هلغي الباك أوردر (${s.openQty} وحدة من ${s.product ?? 'المنتج'}) للأوردر ${s.orderNumber ?? ''}. البيعة بتاعة الوحدات دي هتتعكس في الحسابات والعميل هيتبلّغ. مينفعش يترجع.`,
        `Cancel the backorder (${s.openQty} unit(s) of ${s.product ?? 'the product'}) on order ${s.orderNumber ?? ''}. The sale for those units is reversed and the customer is notified. This cannot be undone.`
      ),
      rows: [
        row('الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('المنتج', 'Product', s.product, s.product),
        row('الوحدات اللي هتتلغي', 'Units cancelled', s.openQty, 0),
        row('السبب', 'Reason', null, a.reason),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) => cancelBackorder(ctx.storeId, a.backorderId, a.reason, ctx.userId),
});

// ======================================================================================================================================
// shipping.book-shipment
// ======================================================================================================================================
// shipping-carrier.routes.ts POST /:storeId/orders/:orderId/ship: authorize('store_admin','super_admin') + requireFeature('shipping_carriers').
const SHIP_GATE = { roles: OWNER, feature: 'shipping_carriers' } as const;
async function readShipment(ctx: TurnCtx, orderId: string) {
  const [d, o] = await Promise.all([
    shippingCarrierService.getShipmentForOrder(ctx.storeId, orderId),
    OrderService.getById(ctx.storeId, orderId),
  ]);
  const shipment = d.shipment as {
    id: string;
    status: string;
    carrier: string;
    trackingNumber?: string | null;
  } | null;
  const addr = (o.shippingAddress ?? {}) as Rec;
  return {
    orderId,
    orderNumber: o.orderNumber,
    orderStatus: d.orderStatus,
    canBook: d.canBook,
    codMinor: d.codAmount as number,
    carriers: (d.carriers as Array<{ code: string }>).map(c => c.code),
    shipmentId: shipment?.id ?? null,
    shipmentStatus: shipment?.status ?? null,
    shipmentCarrier: shipment?.carrier ?? null,
    city: (addr.city as string | undefined) ?? null,
    street: ((addr.address1 ?? addr.street) as string | undefined) ?? null,
  };
}
type ShipState = Awaited<ReturnType<typeof readShipment>>;
const REBOOKABLE = ['creation_failed', 'cancelled'];

const bookShipment = change<{
  orderId: string;
  carrier?: string;
  carrierName?: string;
  trackingNumber?: string;
}>({
  name: 'shipping_book',
  capabilityId: 'shipping.book-shipment',
  description:
    'Book a shipment for an order with a shipping company (Bosta, ShipBlu, Mylerz, Aramex) or record a manual one with the courier name and tracking number. Booking a carrier costs shipping money and the courier is told to collect it. Leave carrier empty for the store default. Use for "ship this order with Bosta", "ابعت الاوردر مع بوسطة", "احجز شحنة".',
  schema: shape(
    {
      orderId: f.id('The order id.'),
      carrier: f.enum(
        [...CARRIER_CODES] as [string, ...string[]],
        'Shipping company; empty = store default.'
      ),
      carrierName: f.str('Courier name (manual shipments only).', { max: 80 }),
      trackingNumber: f.str('Tracking number (manual shipments only).', { max: 80 }),
    },
    ['orderId']
  ),
  policy: 'confirm',
  undo: 'compensating',
  money: true,
  gate: SHIP_GATE,
  audit: { action: 'shipment.booked', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: (ctx, a) => readShipment(ctx, a.orderId),
  describe: (_ctx, a, st) => {
    const s = st as ShipState;
    if (!s.canBook)
      throw new AppError(
        409,
        'ORDER_NOT_SHIPPABLE',
        `Order ${s.orderNumber} is ${s.orderStatus} and cannot be shipped now.`
      );
    if (s.shipmentStatus && !REBOOKABLE.includes(s.shipmentStatus))
      throw new AppError(
        409,
        'ALREADY_SHIPPED',
        `Order ${s.orderNumber} already has a ${s.shipmentStatus} shipment.`
      );
    if (a.carrier && !s.carriers.includes(a.carrier))
      throw new AppError(
        422,
        'CARRIER_NOT_AVAILABLE',
        `${a.carrier} is not connected for this store.`
      );
    if (a.carrier === 'manual' && !(a.carrierName && a.trackingNumber))
      throw new AppError(
        422,
        'MANUAL_NEEDS_DETAILS',
        'A manual shipment needs the courier name and the tracking number.'
      );
    const who = a.carrier ?? 'default';
    return {
      summary: pair(
        `هحجز شحنة للأوردر ${s.orderNumber} مع ${who === 'default' ? 'شركة الشحن الافتراضية' : who}${s.codMinor ? `، والكوريير هيحصّل ${egp(s.codMinor)} ج.م` : ''}. الحجز بيتكلف رسوم شحن.`,
        `Book a shipment for order ${s.orderNumber} with ${who === 'default' ? 'the default carrier' : who}${s.codMinor ? `; the courier collects ${egp(s.codMinor)} EGP` : ''}. Booking costs a shipping fee.`
      ),
      rows: [
        row('الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('شركة الشحن', 'Carrier', null, who),
        row('تحصيل عند الاستلام (ج.م)', 'Cash to collect (EGP)', null, egp(s.codMinor)),
        untrusted(
          row(
            'عنوان التسليم',
            'Delivery address',
            null,
            [s.city, s.street].filter(Boolean).join(' - ') || null
          )
        ),
        ...(a.trackingNumber ? [row('رقم التتبع', 'Tracking number', null, a.trackingNumber)] : []),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const shipment = (await shippingCarrierService.createShipmentForOrder(
      ctx.storeId,
      a.orderId,
      a.carrier as never,
      a.carrier === 'manual' && a.carrierName && a.trackingNumber
        ? { manual: { carrierName: a.carrierName, trackingNumber: a.trackingNumber } }
        : {}
    )) as { id: string; status: string };
    return { shipmentId: shipment.id, status: shipment.status };
  },
  inverse: a => ({ tool: 'shipment_cancel', args: { orderId: a.orderId } }),
});

const cancelShipment = change<{ orderId: string }>({
  name: 'shipment_cancel',
  capabilityId: 'shipping.book-shipment',
  description:
    'Cancel the shipment booked for an order (possible until the carrier collects it). Cannot be undone; book again if needed. Use for "cancel the shipment", "الغي الشحنة".',
  schema: shape({ orderId: f.id('The order id.') }, ['orderId']),
  policy: 'confirm',
  undo: 'irreversible',
  gate: SHIP_GATE,
  audit: { action: 'shipment.cancelled', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: (ctx, a) => readShipment(ctx, a.orderId),
  describe: (_ctx, _a, st) => {
    const s = st as ShipState;
    if (!s.shipmentId) throw notFound('Shipment');
    if (['delivered', 'returned'].includes(String(s.shipmentStatus)))
      throw new AppError(
        409,
        'SHIPMENT_NOT_CANCELLABLE',
        `A ${s.shipmentStatus} shipment cannot be cancelled.`
      );
    return {
      summary: pair(
        `هلغي شحنة الأوردر ${s.orderNumber} (${s.shipmentCarrier}). مينفعش يترجع.`,
        `Cancel the shipment of order ${s.orderNumber} (${s.shipmentCarrier}). This cannot be undone.`
      ),
      rows: [
        row('الشحنة', 'Shipment', s.shipmentStatus, 'cancelled'),
        row('شركة الشحن', 'Carrier', s.shipmentCarrier, s.shipmentCarrier),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a, st) => {
    const id = (st as ShipState).shipmentId;
    if (!id) throw notFound('Shipment');
    const sh = (await shippingCarrierService.cancelShipment(id, {})) as { status: string };
    return { orderId: a.orderId, status: sh.status };
  },
});

// ======================================================================================================================================
// order.invoice-packing (the invoice e-mail)
// ======================================================================================================================================
// order.routes.ts POST /:orderId/invoice/email: authorize('store_admin','super_admin','staff') + requireFeature('accounting.invoicing').
const invoiceEmail = change<{ orderId: string }>({
  name: 'order_invoice_email',
  capabilityId: 'order.invoice-packing',
  description:
    'E-mail the invoice of an order to the customer (to the address on the order). The card shows who it goes to and the subject. An e-mail that is sent cannot be taken back. Use for "send the invoice to the customer", "ابعت الفاتورة للعميل".',
  schema: shape({ orderId: f.id('The order id.') }, ['orderId']),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  gate: { roles: OWNER_OR_STAFF, feature: 'accounting.invoicing' },
  audit: {
    action: 'order.invoice.email-queued',
    resourceType: 'order',
    resourceId: a => a.orderId,
  },
  refs: orderRefs,
  state: (ctx, a) => invoiceRecipient(ctx.storeId, a.orderId),
  describe: (_ctx, _a, st) => {
    const s = st as { to: string | null; orderNumber: string };
    if (!s.to) throw new AppError(400, 'NO_EMAIL', 'Order has no customer email on file');
    return {
      summary: pair(
        `هبعت فاتورة الأوردر ${s.orderNumber} بالإيميل إلى ${s.to}. الإيميل لو اتبعت مينفعش يترجع.`,
        `E-mail the invoice of order ${s.orderNumber} to ${s.to}. A sent e-mail cannot be taken back.`
      ),
      rows: [
        row('الأوردر', 'Order', s.orderNumber, s.orderNumber),
        untrusted(row('المستلم', 'Recipient', null, s.to)),
        row('عنوان الرسالة', 'Subject', null, invoiceEmailSubject(s.orderNumber)),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a, st) => {
    const to = (st as { to: string | null }).to;
    if (!to) throw new AppError(400, 'NO_EMAIL', 'Order has no customer email on file');
    await queueInvoiceEmail(ctx.storeId, a.orderId, to);
    return { queued: true };
  },
});

// ======================================================================================================================================
// order.eta-receipts
// ======================================================================================================================================
// eta.routes.ts POST /:storeId/eta/receipts/:id/retry: authorize('store_admin','super_admin') + requireFeature('eta_ereceipt'). Receipts are issued automatically when an order
// is paid or refunded; the one merchant action is re-issuing the latest failed or rejected one. The connection (client id, secret, key) is secret-bearing and stays on the Tax screen.
async function readEtaReceipts(ctx: TurnCtx, orderId: string) {
  const rows = (await EtaReceiptService.listForOrder(ctx.storeId, orderId)) as unknown as Array<{
    id: string;
    kind: string;
    seq: number;
    status: string;
    errorMessage?: string | null;
    totalPiastres?: number | null;
  }>;
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    seq: r.seq,
    status: r.status,
    error: r.errorMessage ?? null,
    totalMinor: r.totalPiastres ?? null,
  }));
}
const etaRetry = change<{ orderId: string; receiptId: string }>({
  name: 'eta_receipt_retry',
  capabilityId: 'order.eta-receipts',
  description:
    'Re-issue the electronic receipt (ETA, the Egyptian tax authority) of an order whose latest receipt failed or was rejected. It sends a new legal document to the tax authority and cannot be undone. The amount is the receipt\'s own total. Use for "the e-receipt failed", "الايصال فشل يتبعت للضرايب".',
  schema: shape(
    { orderId: f.id('The order id.'), receiptId: f.id('The failed or rejected receipt id.') },
    ['orderId', 'receiptId']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  gate: { roles: OWNER, feature: 'eta_ereceipt' },
  audit: { action: 'eta.receipt_retried', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: (ctx, a) => readEtaReceipts(ctx, a.orderId),
  describe: (_ctx, a, st) => {
    const all = st as Awaited<ReturnType<typeof readEtaReceipts>>;
    const r = all.find(x => x.id === a.receiptId);
    if (!r) throw notFound('Receipt');
    if (!['failed', 'rejected'].includes(r.status))
      throw new AppError(
        409,
        'ETA_RETRY_NOT_ALLOWED',
        'Only a failed or rejected receipt can be re-issued.'
      );
    if (all.some(x => x.kind === r.kind && x.seq > r.seq))
      throw new AppError(409, 'ETA_RETRY_NOT_ALLOWED', 'Only the latest receipt can be re-issued.');
    return {
      summary: pair(
        `هعيد إصدار الإيصال الإلكتروني (${r.kind}) بقيمة ${egp(r.totalMinor)} ج.م وأبعته لمصلحة الضرائب. ده مستند قانوني ومينفعش يترجع.`,
        `Re-issue the e-receipt (${r.kind}) of ${egp(r.totalMinor)} EGP and send it to the tax authority. It is a legal document and cannot be undone.`
      ),
      rows: [
        row('الإيصال', 'Receipt', r.status, 'queued'),
        row('القيمة (ج.م)', 'Amount (EGP)', null, egp(r.totalMinor)),
        ...(r.error ? [untrusted(row('سبب الفشل', 'Failure', null, r.error))] : []),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const ok = await EtaReceiptService.retry(ctx.storeId, a.receiptId);
    if (!ok)
      throw new AppError(
        409,
        'ETA_RETRY_NOT_ALLOWED',
        'Only the latest failed or rejected receipt can be re-issued.'
      );
    return { queued: true };
  },
});

export function opsOrdersTools(): ToolSpec[] {
  return [
    refundOrder,
    instapayConfirm,
    instapayReject,
    cancelBackorderTool,
    bookShipment,
    cancelShipment,
    invoiceEmail,
    etaRetry,
  ];
}
