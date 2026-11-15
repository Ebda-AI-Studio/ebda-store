/**
 * Phase E2 (plan 4): the operations tools of the Store assistant: the order refund, InstaPay receipt review, customer block / erase, backorders,
 * warehouses and warehouse stock, purchase orders and suppliers, shipment booking, gold rates, wholesale decisions, Customer Intelligence switches and
 * two free reads (payment abandonments, a payment's event log). Every write is a `change()` whose gate mirrors the admin route line for line (cited per
 * tool) and whose `run` calls the SAME service the route calls. Money, deletion and anything that reaches a shopper is confirm class with an honest
 * undo class; amounts shown on a card are read from the store in `state()`, never typed by the model.
 */
import { z } from 'zod/v3';
import { withStore } from '@ebda/database';
import { ToolForbidden, type ToolSpec, type TurnCtx } from '@ebda/shared/smart-layer';
import { storeDb } from '../../lib/repo-factory';
import { readInStoreContext } from '../../lib/store-scoped-read';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';
import { invalidateCustomersCache } from '../../lib/public-cache';
import { customerRow } from '../../lib/customer-directory';
import { assertStoreCustomer, storeCustomerWhere } from '../../lib/store-customer';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';
import { featureService } from '../../services/feature.service';
import { AuthService } from '../../services/auth.service';
import { OrderService } from '../../services/order.service';
import { ProductService } from '../../services/product.service';
import { WarehouseService } from '../../services/warehouse.service';
import { GoldRateService } from '../../services/gold-rate/gold-rate.service';
import { setCiSharing } from '../../services/ci-hints.service';
import { shippingCarrierService } from '../../services/shipping-carrier.service';
import { CARRIER_CODES } from '../../services/carriers/types';
import { WholesaleApplicationService } from '../../services/wholesale-application.service';
import { listOpenBackorders, cancelBackorder } from '../../services/accounting/backorder.service';
import {
  createSupplier,
  getSupplier,
  listSuppliers,
} from '../../services/accounting/supplier.service';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  receivePurchaseOrder,
} from '../../services/accounting/purchase-order.service';
import { InstapayService } from '../../services/payment-providers/instapay.service';
import { InstapayReceiptService } from '../../services/payment-providers/instapay-receipt.service';
import {
  lookupRefundTarget,
  refundThroughProvider,
} from '../../services/order-provider-refund.service';
import { change, egp, f, pair, row, shape } from './kit';

type Rec = Record<string, unknown>;
const OWNER = ['store_admin'] as const; // the routes' `authorize('store_admin', 'super_admin')`: a super admin never acts through the assistant
const OWNER_OR_STAFF = ['store_admin', 'staff'] as const;
const orderRefs = (a: { orderId: string }) => [{ kind: 'order', id: a.orderId }];
const untrusted = (r: ReturnType<typeof row>) => ({ ...r, source: 'untrusted' as const });
const toPiasters = (egpValue: number) => Math.round(egpValue * 100);
const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

// ======================================================================================================================================
// Free reads
// ======================================================================================================================================
const readBase = { policy: 'free' as const, undo: 'none' as const };

const abandonments: ToolSpec = {
  ...readBase,
  name: 'payment_abandonments_list',
  // payment-abandonments.routes.ts GET /: authorize('store_admin','super_admin','staff') + requireFeature('payment_abandonment'). No contact data is returned.
  capabilityId: 'payment.abandonments',
  description:
    'Who started paying online and left without finishing (abandoned payments): the count, the total value and the 10 latest orders with their order number, amount, payment method and when they left. Use for "who started paying and did not complete", "payment abandonment", "الدفع اللي ماكملش", "مين بدأ يدفع وسابه". Contact details are not included.',
  resultTrust: 'store-data',
  args: z.object({ days: z.number().int().min(1).max(90).optional() }).strict(),
  jsonSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 90,
        description: 'Look back this many days (default 30).',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async read(ctx: TurnCtx, a: unknown) {
    if (!(OWNER_OR_STAFF as readonly string[]).includes(ctx.role)) throw new ToolForbidden();
    if (!(await featureService.isFeatureEnabled(ctx.storeId, 'payment_abandonment')))
      throw new ToolForbidden();
    const days = (a as { days?: number }).days ?? 30;
    const since = new Date(ctx.now - days * 86_400_000);
    return readInStoreContext(ctx.storeId, async () => {
      const db = await storeDb(ctx.storeId);
      const where = {
        storeId: ctx.storeId,
        deletedAt: null,
        paymentGatewayAbandonedAt: { gte: since },
      };
      const [count, rows] = await Promise.all([
        db.order.count({ where }),
        db.order.findMany({
          where,
          orderBy: { paymentGatewayAbandonedAt: 'desc' },
          take: 10,
          select: {
            orderNumber: true,
            status: true,
            paymentStatus: true,
            total: true,
            currency: true,
            paymentGatewayAbandonedAt: true,
            payments: { select: { provider: true }, take: 1, orderBy: { createdAt: 'desc' } },
          },
        }),
      ]);
      return {
        days,
        abandonedCount: count,
        latest: rows.map(r => ({
          orderNumber: r.orderNumber,
          status: String(r.status),
          paymentStatus: String(r.paymentStatus),
          totalEgp: egp(r.total as number),
          provider: r.payments[0]?.provider ?? null,
          leftAt: iso(r.paymentGatewayAbandonedAt),
        })),
      };
    });
  },
};

const paymentEvents: ToolSpec = {
  ...readBase,
  name: 'payment_events_for_order',
  // payment.routes.ts GET /order/:orderId + GET /:id/events: the store's owner (or its staff) reads the payment and its append-only event log.
  capabilityId: 'payment.events',
  description:
    'The payments of one order and what happened to each (created, paid, failed, refunded...), newest first. Use when a customer says "I paid but the order shows unpaid", "what is the payment status of this order", "العميل بيقول دفع وماوصلنيش", "حالة الدفع". The raw provider payload is never returned.',
  resultTrust: 'store-data',
  args: z.object({ orderId: z.string().trim().min(1).max(64) }).strict(),
  jsonSchema: {
    type: 'object',
    properties: { orderId: { type: 'string', maxLength: 64, description: 'The order id.' } },
    required: ['orderId'],
    additionalProperties: false,
  },
  refs: (a: unknown) => [{ kind: 'order', id: (a as { orderId: string }).orderId }],
  async read(ctx: TurnCtx, a: unknown) {
    if (!(OWNER_OR_STAFF as readonly string[]).includes(ctx.role)) throw new ToolForbidden();
    const { orderId } = a as { orderId: string };
    return readInStoreContext(ctx.storeId, async () => {
      const db = await storeDb(ctx.storeId);
      const payments = await db.payment.findMany({
        where: { orderId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          provider: true,
          method: true,
          status: true,
          amount: true,
          refundedAmount: true,
          createdAt: true,
        },
      });
      const out = [];
      for (const p of payments) {
        const events = await db.paymentEvent.findMany({
          where: { storeId: ctx.storeId, paymentId: p.id },
          orderBy: { occurredAt: 'desc' },
          take: 10,
          select: {
            eventType: true,
            fromStatus: true,
            toStatus: true,
            provider: true,
            occurredAt: true,
          },
        });
        out.push({
          provider: p.provider,
          method: p.method,
          status: String(p.status),
          amountEgp: egp(p.amount),
          refundedEgp: egp(p.refundedAmount),
          createdAt: iso(p.createdAt),
          events: events.map(e => ({
            type: e.eventType,
            from: e.fromStatus,
            to: e.toStatus,
            at: iso(e.occurredAt),
          })),
        });
      }
      return { payments: out };
    });
  },
};

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
// customers.erase-block
// ======================================================================================================================================
async function readShopper(storeId: string, customerId: string) {
  await assertStoreCustomer(storeId, customerId); // 404 for no such id, a staff id and another store's shopper alike
  const d = await customerRow(storeId, customerId);
  if (d)
    return {
      customerId,
      name: `${d.firstName} ${d.lastName}`.trim(),
      status: d.status,
      deleted: d.deletedAt !== null,
    };
  const u = await withStore(storeId, tx =>
    tx.user.findFirst({
      where: storeCustomerWhere(storeId, customerId),
      select: { status: true, firstName: true, lastName: true, deletedAt: true },
    })
  );
  if (!u) throw notFound('Customer');
  return {
    customerId,
    name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
    status: String(u.status),
    deleted: u.deletedAt !== null,
  };
}
type ShopperState = Awaited<ReturnType<typeof readShopper>>;
const STATUS_AR: Record<string, string> = { active: 'شغال', inactive: 'متوقف', suspended: 'محظور' };

const setCustomerStatus = change<{ customerId: string; status: string }>({
  name: 'customer_set_status',
  capabilityId: 'customers.erase-block',
  description:
    'Block (suspend), deactivate or re-activate a customer account of this store: a blocked customer is signed out at once and cannot log in. Use for "block this customer", "ابلوك عميل", "فك الحظر". To reverse it, run it again with status active.',
  schema: shape(
    {
      customerId: f.id('The customer (shopper account) id.'),
      status: f.enum(
        ['active', 'inactive', 'suspended'],
        'active = allowed, suspended = blocked, inactive = switched off.'
      ),
    },
    ['customerId', 'status']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  // customers.routes.ts PUT /customers/:customerId/status: authorize('store_admin','super_admin') + requirePermission('users:write'), never staff.
  gate: { roles: OWNER, permission: 'users:write' },
  audit: {
    action: 'customer.status.changed_by_merchant',
    resourceType: 'user',
    resourceId: a => a.customerId,
  },
  state: (ctx, a) => readShopper(ctx.storeId, a.customerId),
  describe: (_ctx, a, st) => {
    const s = st as ShopperState;
    if (s.deleted)
      throw new AppError(409, 'CUSTOMER_DELETED', 'This customer account was already deleted.');
    return {
      summary: pair(
        `هغيّر حالة حساب العميل ${s.name || s.customerId} من «${STATUS_AR[s.status] ?? s.status}» إلى «${STATUS_AR[a.status] ?? a.status}». لو اتحظر هيتفصل فورًا.`,
        `Change the account of ${s.name || s.customerId} from ${s.status} to ${a.status}. A blocked customer is signed out at once.`
      ),
      rows: [
        row('العميل', 'Customer', s.name, s.name),
        row('الحالة', 'Status', s.status, a.status),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    await AuthService.setCustomerStatus(
      a.customerId,
      ctx.storeId,
      a.status as 'active' | 'inactive' | 'suspended'
    );
    return { customerId: a.customerId, status: a.status };
  },
});

const eraseCustomer = change<{ customerId: string }>({
  name: 'customer_erase',
  capabilityId: 'customers.erase-block',
  description:
    'Erase a customer\'s personal data (right to erasure) when they ask to be forgotten: name, contact details and addresses are anonymised, orders stay for the accounts. Deletes data, cannot be undone. Use for "this customer asked me to delete their data", "امسح بيانات العميل".',
  schema: shape({ customerId: f.id('The customer (shopper account) id.') }, ['customerId']),
  policy: 'confirm',
  undo: 'irreversible',
  deletes: true,
  // customers.routes.ts POST /customers/:customerId/erase: authorize('store_admin','super_admin'), never staff, never while impersonating (privacyMiddleware).
  gate: { roles: OWNER },
  audit: {
    action: 'customer.account.erased_by_merchant',
    resourceType: 'user',
    resourceId: a => a.customerId,
  },
  state: (ctx, a) => readShopper(ctx.storeId, a.customerId),
  describe: (_ctx, _a, st) => {
    const s = st as ShopperState;
    return {
      summary: pair(
        `هامسح بيانات العميل ${s.name || s.customerId} نهائيًا (الاسم والتليفون والإيميل والعناوين). الأوردرات هتفضل للحسابات من غير بياناته. مينفعش يترجع.`,
        `Permanently erase the personal data of ${s.name || s.customerId} (name, phone, email, addresses). Orders stay for the accounts without their details. This cannot be undone.`
      ),
      rows: [
        row('العميل', 'Customer', s.name, null),
        row('البيانات الشخصية', 'Personal data', 'موجودة / present', 'هتتمسح / erased'),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const outcome = await AuthService.eraseAccount(a.customerId, {
      scopeStoreId: ctx.storeId,
      actorId: ctx.userId,
      storeHint: ctx.storeId,
    });
    // after COMMIT, never inside the request transaction (the customers list must not re-cache the pre-erasure PII)
    void deferAfterTenantCommit('customers.erase.invalidateCache', () =>
      invalidateCustomersCache(ctx.storeId)
    ).catch(err =>
      logger.warn(
        { err, storeId: ctx.storeId },
        '[assistant.customer_erase] cache invalidation failed'
      )
    );
    return { crmReviewNeeded: outcome.crmChecked && outcome.crmAmbiguous };
  },
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
// inventory.warehouses
// ======================================================================================================================================
// warehouse.routes.ts: authorize('store_admin','super_admin') + requireFeature('inventory.multi_warehouse') on every route.
const WAREHOUSE_GATE = { roles: OWNER, feature: 'inventory.multi_warehouse' } as const;
const WH_FIELDS = ['name', 'nameAr', 'priority', 'address', 'isActive', 'isDefault'] as const;
const WH_LABELS: Record<string, [string, string]> = {
  name: ['اسم المخزن', 'Name'],
  nameAr: ['الاسم بالعربي', 'Arabic name'],
  priority: ['الأولوية', 'Priority'],
  address: ['العنوان', 'Address'],
  isActive: ['شغال', 'Active'],
  isDefault: ['المخزن الافتراضي', 'Default warehouse'],
};
type WhArgs = {
  warehouseId: string;
  name?: string;
  nameAr?: string | null;
  priority?: number;
  address?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
};
const warehouseUpdate = change<WhArgs>({
  name: 'warehouse_update',
  capabilityId: 'inventory.warehouses',
  description:
    'Edit a warehouse: rename it, change its priority or address, make it the default, or switch it off (a soft switch-off, the stock stays). Send only what changes. Use for "rename the warehouse", "عدّل المخزن", "وقف المخزن ده".',
  schema: shape(
    {
      warehouseId: f.id('The warehouse id.'),
      name: f.str('New name.', { max: 200 }),
      nameAr: f.nullable(f.str('Arabic name (null clears).', { max: 200 })),
      priority: f.int('Higher priority is picked first.', { max: 9999 }),
      address: f.nullable(f.str('Address (null clears).', { max: 500 })),
      isActive: f.bool('false switches the warehouse off.'),
      isDefault: f.bool('true makes it the default warehouse.'),
    },
    ['warehouseId']
  ),
  undo: 'reversible',
  gate: WAREHOUSE_GATE,
  audit: { action: 'warehouse.updated', resourceType: 'warehouse', resourceId: a => a.warehouseId },
  state: async (ctx, a) => {
    const w = await WarehouseService.getWarehouse(ctx.storeId, a.warehouseId);
    return {
      ...Object.fromEntries(WH_FIELDS.map(k => [k, (w as unknown as Rec)[k] ?? null])),
      updatedAt: iso(w.updatedAt),
    };
  },
  describe: (_ctx, a, st) => {
    const cur = st as Rec;
    const keys = WH_FIELDS.filter(k => a[k] !== undefined);
    if (keys.length === 0)
      throw new AppError(400, 'NOTHING_TO_CHANGE', 'Send at least one field to change.');
    return {
      summary: pair(
        `هعدّل المخزن (${keys.length} حقل)`,
        `Update the warehouse (${keys.length} field(s))`
      ),
      rows: keys.map(k => row(WH_LABELS[k]![0], WH_LABELS[k]![1], cur[k] ?? null, a[k])),
      affectedCount: 1,
      restore: Object.fromEntries(keys.map(k => [k, cur[k] ?? null])),
    };
  },
  run: (ctx, a) => {
    const { warehouseId, ...patch } = a;
    return WarehouseService.updateWarehouse(ctx.storeId, warehouseId, patch as never);
  },
  inverse: (a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'warehouse_update', args: { warehouseId: a.warehouseId, ...(restore as Rec) } }
      : null,
});

const warehouseCreate = change<{
  name: string;
  nameAr?: string;
  code: string;
  priority?: number;
  address?: string;
  isDefault?: boolean;
}>({
  name: 'warehouse_create',
  capabilityId: 'inventory.warehouses',
  description:
    'Add a new warehouse (name, a short code like CAI or ALX, optional Arabic name, priority, address). Use for "I have a second warehouse", "ضيف مخزن جديد". Undo switches the new warehouse off.',
  schema: shape(
    {
      name: f.str('Warehouse name.', { max: 200 }),
      nameAr: f.str('Arabic name.', { max: 200 }),
      code: f.str('Short code: letters, digits, - and _ only.', { max: 20 }),
      priority: f.int('Higher priority is picked first.', { max: 9999 }),
      address: f.str('Address.', { max: 500 }),
      isDefault: f.bool('Make it the default warehouse.'),
    },
    ['name', 'code']
  ),
  undo: 'reversible',
  gate: WAREHOUSE_GATE,
  audit: { action: 'warehouse.created', resourceType: 'warehouse' },
  state: async ctx => ({
    codes: (await WarehouseService.listWarehouses(ctx.storeId)).map(w => w.code).sort(),
  }),
  describe: (_ctx, a, st) => {
    if (!/^[A-Za-z0-9_-]+$/.test(a.code))
      throw new AppError(422, 'INVALID_CODE', 'Code must be alphanumeric (A-Z, 0-9, -, _).');
    if ((st as { codes: string[] }).codes.includes(a.code))
      throw new AppError(409, 'CODE_TAKEN', `A warehouse with code ${a.code} already exists.`);
    return {
      summary: pair(
        `هضيف مخزن جديد «${a.name}» بكود ${a.code}`,
        `Add warehouse "${a.name}" with code ${a.code}`
      ),
      rows: [
        row('الاسم', 'Name', null, a.name),
        row('الكود', 'Code', null, a.code),
        ...(a.isDefault ? [row('افتراضي', 'Default', false, true)] : []),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const w = await WarehouseService.createWarehouse(ctx.storeId, a);
    return { id: w.id, code: w.code };
  },
  inverse: (_a, _restore, result) => {
    const id = (result as { id?: string } | null)?.id;
    return id ? { tool: 'warehouse_update', args: { warehouseId: id, isActive: false } } : null;
  },
});

type AdjArgs = { warehouseId: string; productId: string; delta: number; reason?: string };
const warehouseStockAdjust = change<AdjArgs>({
  name: 'warehouse_stock_adjust',
  capabilityId: 'inventory.warehouses',
  description:
    'Add or remove units of ONE simple product in ONE warehouse (+10 adds, -3 removes; never below zero). For a product with variants the merchant uses the warehouse screen. Use for "add 20 units to the Cairo warehouse", "نقّص المخزن".',
  schema: shape(
    {
      warehouseId: f.id('The warehouse id.'),
      productId: f.id('The product id.'),
      delta: f.int('Signed whole number of units.', { min: -1_000_000, max: 1_000_000 }),
      reason: f.str('Why (kept in the stock history).', { max: 500 }),
    },
    ['warehouseId', 'productId', 'delta']
  ),
  undo: 'reversible',
  gate: WAREHOUSE_GATE,
  audit: {
    action: 'warehouse.stock_adjusted',
    resourceType: 'warehouse',
    resourceId: a => a.warehouseId,
  },
  refs: a => [{ kind: 'product', id: a.productId }],
  state: async (ctx, a) => {
    const w = await WarehouseService.getWarehouse(ctx.storeId, a.warehouseId); // 404 for another store's warehouse
    const stock = await WarehouseService.getProductStock(ctx.storeId, a.productId, null);
    return {
      warehouseId: w.id,
      warehouse: w.name,
      quantity: stock.find(s => s.warehouseId === a.warehouseId)?.quantity ?? 0,
    };
  },
  describe: (_ctx, a, st) => {
    const s = st as { warehouse: string; quantity: number };
    if (a.delta === 0)
      throw new AppError(400, 'NOTHING_TO_CHANGE', 'A change of 0 units does nothing.');
    const after = Math.max(0, s.quantity + a.delta);
    return {
      summary: pair(
        `هغيّر المخزون في «${s.warehouse}» من ${s.quantity} إلى ${after}`,
        `Change stock in ${s.warehouse} from ${s.quantity} to ${after}`
      ),
      rows: [row('المخزون في المخزن', 'Stock in the warehouse', s.quantity, after)],
      affectedCount: 1,
      restore: { delta: s.quantity - after },
    };
  },
  run: (ctx, a) =>
    WarehouseService.adjustStock(ctx.storeId, a.warehouseId, {
      productId: a.productId,
      delta: a.delta,
      reason: a.reason,
    }),
  inverse: (a, restore) =>
    restore && (restore as { delta: number }).delta !== 0
      ? {
          tool: 'warehouse_stock_adjust',
          args: { ...a, delta: (restore as { delta: number }).delta },
        }
      : null,
});

// ======================================================================================================================================
// inventory.suppliers-po
// ======================================================================================================================================
// purchase-orders.routes.ts / suppliers.routes.ts: authorize('store_admin','super_admin') + requireFeature('inventory.purchase_orders' | 'accounting.basic').
const PO_GATE = { roles: OWNER, feature: 'inventory.purchase_orders' } as const;
const supplierCreate = change<{
  name: string;
  nameAr?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  paymentTerms?: string;
  leadTimeDays?: number;
}>({
  name: 'supplier_create',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Add a supplier (name, contact, phone, email, payment terms, lead time in days) so purchase orders can be made to them. Use for "add a supplier", "ضيف مورد".',
  schema: shape(
    {
      name: f.str('Supplier name.', { max: 200 }),
      nameAr: f.str('Arabic name.', { max: 200 }),
      contactName: f.str('Contact person.', { max: 200 }),
      phone: f.str('Phone.', { max: 50 }),
      email: f.str('Email.', { max: 200 }),
      paymentTerms: f.enum(['net0', 'net15', 'net30', 'net60'], 'Days to pay after receiving.'),
      leadTimeDays: f.int('Usual delivery time in days.', { min: 1, max: 365 }),
    },
    ['name']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: OWNER, feature: 'accounting.basic' },
  audit: { action: 'supplier.created', resourceType: 'supplier' },
  state: async ctx => ({
    names: (await listSuppliers(ctx.storeId, { includeInactive: true })).map(s => s.name).sort(),
  }),
  describe: (_ctx, a) => ({
    summary: pair(`هضيف المورد «${a.name}»`, `Add supplier "${a.name}"`),
    rows: [
      row('الاسم', 'Name', null, a.name),
      ...(a.phone ? [row('التليفون', 'Phone', null, a.phone)] : []),
      ...(a.email ? [row('الإيميل', 'Email', null, a.email)] : []),
      ...(a.paymentTerms ? [row('شروط الدفع', 'Payment terms', null, a.paymentTerms)] : []),
    ],
    affectedCount: 1,
  }),
  run: async (ctx, a) => {
    const s = await createSupplier({
      storeId: ctx.storeId,
      ...a,
      paymentTerms: a.paymentTerms as never,
    });
    return { id: s.id };
  },
});

async function readPo(ctx: TurnCtx, poId: string) {
  const po = (await getPurchaseOrder(ctx.storeId, poId)) as unknown as {
    id: string;
    poNumber?: string;
    status: string;
    updatedAt?: Date;
    supplier?: { name?: string } | null;
    items: Array<{
      id: string;
      qty: number;
      qtyReceived: number;
      unitCost: number;
      product?: { name?: string } | null;
    }>;
  } | null;
  if (!po) throw new AppError(404, 'PO_NOT_FOUND', 'Purchase order not found.');
  return {
    poId: po.id,
    poNumber: po.poNumber ?? po.id,
    status: String(po.status),
    supplier: po.supplier?.name ?? null,
    updatedAt: iso(po.updatedAt),
    items: po.items.map(i => ({
      id: i.id,
      product: i.product?.name ?? null,
      qty: i.qty,
      qtyReceived: i.qtyReceived,
      unitCostMinor: i.unitCost,
    })),
  };
}
type PoState = Awaited<ReturnType<typeof readPo>>;

type PoCreateArgs = {
  supplierId: string;
  items: Array<{ productId: string; variantId?: string; qty: number; unitCostEgp: number }>;
  expectedDate?: string;
  notes?: string;
};
const poCreate = change<PoCreateArgs>({
  name: 'purchase_order_create',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Create a draft purchase order to a supplier: the products, the quantity of each and the unit cost in EGP (a decimal number, not piasters). Nothing is paid or received yet. Use for "make a purchase order", "اعمل امر شراء", "اطلب من المورد".',
  schema: shape(
    {
      supplierId: f.id('The supplier id.'),
      items: f.list(
        f.obj(
          {
            productId: f.id('The product id.'),
            variantId: f.id('The variant id, if the product has variants.'),
            qty: f.int('Units to order.', { min: 1, max: 1_000_000 }),
            unitCostEgp: f.num('Cost per unit in EGP.', { max: 100_000_000 }),
          },
          ['productId', 'qty', 'unitCostEgp']
        ),
        { min: 1, max: 25 }
      ),
      expectedDate: f.str('Expected delivery date, YYYY-MM-DD.', { max: 30 }),
      notes: f.str('Notes on the order.', { max: 1000 }),
    },
    ['supplierId', 'items']
  ),
  policy: 'confirm',
  // Registry class for the capability is irreversible (a cancel or a receive cannot be taken back); a draft can still be cancelled with purchase_order_cancel.
  undo: 'irreversible',
  gate: PO_GATE,
  audit: { action: 'purchase_order.created', resourceType: 'purchase_order' },
  refs: a => a.items.map(i => ({ kind: 'product', id: i.productId })),
  state: async (ctx, a) => {
    const s = await getSupplier(ctx.storeId, a.supplierId); // another store's supplier is simply absent
    if (!s) throw notFound('Supplier');
    return { supplierId: s.id, supplier: s.name, isActive: s.isActive };
  },
  describe: async (ctx, a, st) => {
    const s = st as { supplier: string };
    const names = await Promise.all(
      a.items.map(async i => {
        try {
          return String(
            ((await ProductService.getById(ctx.storeId, i.productId)) as Rec).name ?? i.productId
          );
        } catch {
          return i.productId;
        }
      })
    );
    const totalMinor = a.items.reduce((n, i) => n + i.qty * toPiasters(i.unitCostEgp), 0);
    return {
      summary: pair(
        `هعمل أمر شراء مسودة للمورد «${s.supplier}»: ${a.items.length} صنف بإجمالي ${egp(totalMinor)} ج.م. لسه مفيش دفع ولا استلام.`,
        `Create a draft purchase order to ${s.supplier}: ${a.items.length} item(s), total ${egp(totalMinor)} EGP. Nothing is paid or received yet.`
      ),
      rows: [
        row('المورد', 'Supplier', null, s.supplier),
        ...a.items.map((i, n) =>
          row(`صنف ${n + 1}`, `Item ${n + 1}`, null, `${names[n]}: ${i.qty} × ${i.unitCostEgp} EGP`)
        ),
        row('الإجمالي (ج.م)', 'Total (EGP)', null, egp(totalMinor)),
      ],
      affectedCount: a.items.length,
    };
  },
  run: async (ctx, a) => {
    const po = await createPurchaseOrder({
      storeId: ctx.storeId,
      supplierId: a.supplierId,
      createdBy: ctx.userId,
      ...(a.expectedDate ? { expectedDate: new Date(a.expectedDate) } : {}),
      ...(a.notes ? { notes: a.notes } : {}),
      items: a.items.map(i => ({
        productId: i.productId,
        ...(i.variantId ? { variantId: i.variantId } : {}),
        qty: i.qty,
        unitCost: toPiasters(i.unitCostEgp),
      })),
    });
    return { id: po.id };
  },
});

const poCancel = change<{ poId: string }>({
  name: 'purchase_order_cancel',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Cancel a purchase order that is not fully received yet. Cannot be undone. Use for "cancel the purchase order", "الغي امر الشراء".',
  schema: shape({ poId: f.id('The purchase order id.') }, ['poId']),
  policy: 'confirm',
  undo: 'irreversible',
  gate: PO_GATE,
  audit: {
    action: 'purchase_order.cancelled',
    resourceType: 'purchase_order',
    resourceId: a => a.poId,
  },
  state: (ctx, a) => readPo(ctx, a.poId),
  describe: (_ctx, _a, st) => {
    const s = st as PoState;
    if (s.status === 'received' || s.status === 'cancelled')
      throw new AppError(
        409,
        'PO_NOT_CANCELLABLE',
        `A ${s.status} purchase order cannot be cancelled.`
      );
    return {
      summary: pair(
        `هلغي أمر الشراء ${s.poNumber} للمورد «${s.supplier}». مينفعش يترجع.`,
        `Cancel purchase order ${s.poNumber} to ${s.supplier}. This cannot be undone.`
      ),
      rows: [
        row('أمر الشراء', 'Purchase order', s.poNumber, s.poNumber),
        row('الحالة', 'Status', s.status, 'cancelled'),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) => cancelPurchaseOrder(ctx.storeId, a.poId),
});

const poReceive = change<{
  poId: string;
  receipts: Array<{ poItemId: string; qtyReceived: number }>;
}>({
  name: 'purchase_order_receive',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Record that goods of a purchase order arrived (all or part): adds the units to stock at the order\'s unit cost, clears waiting backorders first and books what is owed to the supplier. Cannot be undone. Use for "I received the shipment", "استلمت نص الشحنة".',
  schema: shape(
    {
      poId: f.id('The purchase order id.'),
      receipts: f.list(
        f.obj(
          {
            poItemId: f.id('The purchase order line id.'),
            qtyReceived: f.int('Units that arrived.', { min: 1, max: 1_000_000 }),
          },
          ['poItemId', 'qtyReceived']
        ),
        { min: 1, max: 25 }
      ),
    },
    ['poId', 'receipts']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  gate: PO_GATE,
  audit: {
    action: 'purchase_order.received',
    resourceType: 'purchase_order',
    resourceId: a => a.poId,
  },
  state: (ctx, a) => readPo(ctx, a.poId),
  describe: (_ctx, a, st) => {
    const s = st as PoState;
    if (s.status === 'received' || s.status === 'cancelled')
      throw new AppError(
        409,
        'PO_NOT_RECEIVABLE',
        `A ${s.status} purchase order cannot receive goods.`
      );
    let totalMinor = 0;
    const rows = a.receipts.map(r => {
      const line = s.items.find(i => i.id === r.poItemId);
      if (!line)
        throw new AppError(400, 'PO_ITEM_NOT_FOUND', 'That line is not on this purchase order.');
      totalMinor += r.qtyReceived * line.unitCostMinor;
      return row(
        line.product ?? line.id,
        line.product ?? line.id,
        `${line.qtyReceived}/${line.qty}`,
        `${line.qtyReceived + r.qtyReceived}/${line.qty}`
      );
    });
    return {
      summary: pair(
        `هسجّل استلام بضاعة أمر الشراء ${s.poNumber} بقيمة ${egp(totalMinor)} ج.م وهزوّد المخزون. مينفعش يترجع.`,
        `Record goods received on purchase order ${s.poNumber}, worth ${egp(totalMinor)} EGP, and add them to stock. This cannot be undone.`
      ),
      rows: [...rows, row('قيمة المستلم (ج.م)', 'Value received (EGP)', null, egp(totalMinor))],
      affectedCount: a.receipts.length,
    };
  },
  run: async (ctx, a) => {
    const r = await receivePurchaseOrder({
      storeId: ctx.storeId,
      poId: a.poId,
      receivedBy: ctx.userId,
      receipts: a.receipts,
    });
    return { status: String((r.po as { status?: string }).status ?? '') };
  },
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
// store.gold-rates
// ======================================================================================================================================
type GoldArgs = { rates: Array<{ karat: number; ratePerGramEgp: number }> };
type GoldState = { rates: Array<{ karat: number; ratePerGram: number | null }>; jumpBps: number };
const goldRates = change<GoldArgs>({
  name: 'gold_rate_set',
  capabilityId: 'store.gold-rates',
  description:
    'Set today\'s gold price per gram in EGP (a decimal number, not piasters) for 24, 21 and/or 18 karat. Every product priced by the gold rate is repriced at once, so this changes what shoppers pay. Use for "update the gold price", "حدّث سعر الدهب", "عيار 21 بقى 4000". Undo puts the previous rates back (also repricing).',
  schema: shape(
    {
      rates: f.list(
        f.obj(
          {
            karat: f.int('24, 21 or 18.', { min: 18, max: 24 }),
            ratePerGramEgp: f.num('Price of one gram in EGP.', { max: 10_000_000 }),
          },
          ['karat', 'ratePerGramEgp']
        ),
        { min: 1, max: 3 }
      ),
    },
    ['rates']
  ),
  policy: 'confirm',
  undo: 'compensating',
  money: true,
  // gold-rate.routes.ts PUT /: authorize('store_admin','super_admin','staff') + requirePermission('store:settings') (staff lack it).
  gate: { permission: 'store:settings' },
  audit: { action: 'gold_rate.set', resourceType: 'gold_rate' },
  state: async (ctx): Promise<GoldState> => {
    const g = await GoldRateService.getState(ctx.storeId);
    return {
      rates: g.rates.map(r => ({ karat: r.karat as number, ratePerGram: r.ratePerGram })),
      jumpBps: g.settings.jumpConfirmBps ?? 500,
    };
  },
  describe: (_ctx, a, st) => {
    const s = st as GoldState;
    const rows = a.rates.map(r => {
      const before = s.rates.find(x => x.karat === r.karat)?.ratePerGram ?? null;
      const afterMinor = toPiasters(r.ratePerGramEgp);
      const pct = before ? Math.round(((afterMinor - before) / before) * 1000) / 10 : null;
      return { r, before, afterMinor, pct };
    });
    const big = rows.filter(x => x.pct !== null && Math.abs(x.pct) * 100 >= s.jumpBps);
    return {
      summary: pair(
        `هحدّث سعر جرام الدهب (${rows.map(x => `عيار ${x.r.karat}: ${x.r.ratePerGramEgp} ج.م`).join('، ')}). كل المنتجات المسعّرة بالدهب هتتسعّر من جديد فورًا.`,
        `Set the gold price per gram (${rows.map(x => `${x.r.karat}k: ${x.r.ratePerGramEgp} EGP`).join(', ')}). Every gold-priced product is repriced at once.`
      ),
      rows: [
        ...rows.map(x =>
          row(
            `عيار ${x.r.karat} (ج.م/جرام)`,
            `${x.r.karat}k (EGP/gram)`,
            egp(x.before),
            egp(x.afterMinor)
          )
        ),
        ...big.map(x =>
          row(
            `تنبيه: تغيير كبير في عيار ${x.r.karat}`,
            `Warning: big jump on ${x.r.karat}k`,
            null,
            `${x.pct}%`
          )
        ),
      ],
      affectedCount: rows.length,
      changesPrice: true,
      restore: {
        rates: rows
          .filter(x => x.before !== null)
          .map(x => ({ karat: x.r.karat, ratePerGramEgp: (x.before as number) / 100 })),
      },
    };
  },
  // the merchant approved the card, which shows any jump over the store's gate: `confirm: true` is that approval (Ruling B5-20)
  run: (ctx, a) =>
    GoldRateService.applyRates(
      ctx.storeId,
      {
        rates: a.rates.map(r => ({
          karat: r.karat as 24 | 21 | 18,
          ratePerGram: toPiasters(r.ratePerGramEgp),
        })),
        confirm: true,
      },
      { userId: ctx.userId }
    ),
  inverse: (_a, restore) => {
    const rates = (restore as GoldArgs | null)?.rates ?? [];
    return rates.length ? { tool: 'gold_rate_set', args: { rates } } : null;
  },
});

// ======================================================================================================================================
// marketing.wholesale
// ======================================================================================================================================
// wholesale.routes.ts: authorize('store_admin','super_admin') + requireStoreAccess; approve / reject need requireFeature('b2b.wholesale'), revoke does not.
async function readApplication(ctx: TurnCtx, id: string) {
  const db = await storeDb(ctx.storeId);
  const app = await db.wholesaleApplication.findFirst({
    where: { id, storeId: ctx.storeId },
    select: {
      id: true,
      businessName: true,
      status: true,
      groupId: true,
      decidedAt: true,
      updatedAt: true,
    },
  });
  if (!app) throw notFound('Application');
  return {
    applicationId: app.id,
    businessName: app.businessName,
    status: String(app.status),
    groupId: app.groupId ?? null,
    updatedAt: iso(app.updatedAt),
  };
}
type AppState = Awaited<ReturnType<typeof readApplication>>;
const decide = change<{ applicationId: string; decision: string; groupId?: string; note?: string }>(
  {
    name: 'wholesale_decide',
    capabilityId: 'marketing.wholesale',
    description:
      'Approve or reject a wholesale (B2B) buyer application. Approve needs the wholesale customer group the buyer joins (it gives them that group\'s prices); the applicant is emailed either way, with your note as written, and it cannot be undone. Use for "accept the wholesale request", "اقبل طلب تاجر جملة", "ارفض طلب الجملة".',
    schema: shape(
      {
        applicationId: f.id('The wholesale application id.'),
        decision: f.enum(['approve', 'reject'], 'approve or reject.'),
        groupId: f.id('Wholesale customer group id (required to approve).'),
        note: f.str('Note emailed to the applicant (optional).', { max: 500 }),
      },
      ['applicationId', 'decision']
    ),
    policy: 'confirm',
    undo: 'irreversible',
    messagesCustomers: true,
    gate: { roles: OWNER, feature: 'b2b.wholesale' },
    audit: {
      action: 'wholesale.decided',
      resourceType: 'wholesale_application',
      resourceId: a => a.applicationId,
    },
    state: (ctx, a) => readApplication(ctx, a.applicationId),
    describe: async (ctx, a, st) => {
      const s = st as AppState;
      if (s.status !== 'pending')
        throw new AppError(409, 'NOT_PENDING', 'This application was already decided.');
      let groupName: string | null = null;
      if (a.decision === 'approve') {
        if (!a.groupId)
          throw new AppError(
            422,
            'GROUP_REQUIRED',
            'Approving needs the wholesale customer group.'
          );
        const g = await (
          await storeDb(ctx.storeId)
        ).customerGroup.findFirst({
          where: { id: a.groupId, storeId: ctx.storeId },
          select: { name: true },
        });
        if (!g) throw notFound('Customer group');
        groupName = g.name;
      }
      const word = a.decision === 'approve' ? ['هوافق على', 'Approve'] : ['هرفض', 'Reject'];
      return {
        summary: pair(
          `${word[0]} طلب الجملة بتاع «${s.businessName}»${groupName ? ` وأضيفه لمجموعة «${groupName}»` : ''}. التاجر هيوصله إيميل ومينفعش يترجع.`,
          `${word[1]} the wholesale application of "${s.businessName}"${groupName ? ` and add them to "${groupName}"` : ''}. The applicant is emailed and this cannot be undone.`
        ),
        rows: [
          untrusted(row('التاجر', 'Applicant', s.businessName, s.businessName)),
          row('القرار', 'Decision', s.status, a.decision === 'approve' ? 'approved' : 'rejected'),
          ...(groupName ? [row('مجموعة الجملة', 'Wholesale group', null, groupName)] : []),
          ...(a.note ? [row('ملاحظتك للتاجر', 'Your note to the applicant', null, a.note)] : []),
        ],
        affectedCount: 1,
      };
    },
    run: async (ctx, a) => {
      const app =
        a.decision === 'approve'
          ? await WholesaleApplicationService.approve(
              ctx.storeId,
              a.applicationId,
              a.groupId as string,
              ctx.userId
            )
          : await WholesaleApplicationService.reject(
              ctx.storeId,
              a.applicationId,
              a.note ?? null,
              ctx.userId
            );
      return { status: String((app as { status?: string }).status ?? '') };
    },
  }
);

const revoke = change<{ applicationId: string; note?: string }>({
  name: 'wholesale_revoke',
  capabilityId: 'marketing.wholesale',
  description:
    'End an approved wholesale buyer\'s access: they go back to retail prices at once. The buyer would have to apply again after the cooldown, so it cannot be undone from here. Use for "remove this wholesale buyer", "الغي تاجر الجملة ده".',
  schema: shape(
    {
      applicationId: f.id('The approved wholesale application id.'),
      note: f.str('Internal note (optional).', { max: 500 }),
    },
    ['applicationId']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: OWNER },
  audit: {
    action: 'wholesale.revoked',
    resourceType: 'wholesale_application',
    resourceId: a => a.applicationId,
  },
  state: (ctx, a) => readApplication(ctx, a.applicationId),
  describe: (_ctx, a, st) => {
    const s = st as AppState;
    if (s.status !== 'approved')
      throw new AppError(409, 'NOT_APPROVED', 'Only an approved application can be revoked.');
    return {
      summary: pair(
        `هلغي وصول تاجر الجملة «${s.businessName}»، هيرجع للسعر العادي فورًا.`,
        `Revoke wholesale access of "${s.businessName}"; they go back to retail prices at once.`
      ),
      rows: [
        untrusted(row('التاجر', 'Buyer', s.businessName, s.businessName)),
        row('الحالة', 'Status', s.status, 'revoked'),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const r = await WholesaleApplicationService.revoke(
      ctx.storeId,
      a.applicationId,
      a.note ?? null,
      ctx.userId
    );
    return { membership: r.membership };
  },
});

// ======================================================================================================================================
// shipping.customer-intelligence
// ======================================================================================================================================
type CiArgs = { hints?: boolean; sharing?: boolean };
// ci.routes.ts PUT /:storeId/ci/hints and /ci/sharing: authorize('store_admin','super_admin') + requireStoreAccess (no feature gate on the switches).
const ciSettings = change<CiArgs>({
  name: 'customer_intelligence_settings',
  capabilityId: 'shipping.customer-intelligence',
  description:
    'Turn the smart order hints on or off (cash-on-delivery risk notes and the best courier for an area) and the cross-store sharing opt-in. Use for "turn on smart hints", "فعّل التلميحات الذكية", "عميل ده خطر COD".',
  schema: shape(
    {
      hints: f.bool('true turns the smart hints on, false off.'),
      sharing: f.bool('true opts the store in to anonymous cross-store signals, false opts out.'),
    },
    []
  ),
  undo: 'reversible',
  gate: { roles: OWNER },
  audit: { action: 'store.ci_settings_changed', resourceType: 'store' },
  state: async ctx => {
    const db = await storeDb(ctx.storeId);
    const st = await db.store.findFirst({
      where: { id: ctx.storeId },
      select: { ciSharing: true },
    });
    if (!st) throw notFound('Store');
    return {
      hints: await featureService.isFeatureEnabled(ctx.storeId, 'customer_intelligence'),
      sharing: Boolean(st.ciSharing),
    };
  },
  describe: (_ctx, a, st) => {
    const cur = st as { hints: boolean; sharing: boolean };
    const keys = (['hints', 'sharing'] as const).filter(k => a[k] !== undefined);
    if (keys.length === 0)
      throw new AppError(400, 'NOTHING_TO_CHANGE', 'Send hints and/or sharing.');
    const label = {
      hints: ['التلميحات الذكية', 'Smart hints'],
      sharing: ['مشاركة الإشارات بين المتاجر', 'Cross-store sharing'],
    } as const;
    return {
      summary: pair('هعدّل إعدادات التلميحات الذكية', 'Update the smart hints settings'),
      rows: keys.map(k => row(label[k][0], label[k][1], cur[k], a[k])),
      affectedCount: 1,
      restore: Object.fromEntries(keys.map(k => [k, cur[k]])),
    };
  },
  run: async (ctx, a) => {
    if (a.hints !== undefined)
      await featureService.setFeature(ctx.storeId, 'customer_intelligence', a.hints, ctx.userId);
    if (a.sharing !== undefined) await setCiSharing(ctx.storeId, a.sharing);
    return {};
  },
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'customer_intelligence_settings', args: restore }
      : null,
});

// pq-allow(unused-export): wired into changeTools() by the controller after phase E
export function opsTools(): ToolSpec[] {
  return [
    abandonments,
    paymentEvents,
    refundOrder,
    instapayConfirm,
    instapayReject,
    setCustomerStatus,
    eraseCustomer,
    cancelBackorderTool,
    warehouseUpdate,
    warehouseCreate,
    warehouseStockAdjust,
    supplierCreate,
    poCreate,
    poCancel,
    poReceive,
    bookShipment,
    cancelShipment,
    goldRates,
    decide,
    revoke,
    ciSettings,
  ];
}
