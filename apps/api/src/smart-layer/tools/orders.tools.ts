/**
 * Wave 2 (plan 4 C2): order tools, confirm class where an order's status notifies the shopper, an order is cancelled or money is recorded.
 * Each tool is declared with `change()` from ./kit and calls the SAME service method the admin route (and the Merchant MCP) calls.
 *
 * Not here: `order.invoice-packing`. Both generators (InvoiceService.generateInvoice, PackingSlipService.generateDetailed) only render HTML for the
 * browser on request; they write no document row and send nothing, so there is no change to preview, apply or undo. The merchant opens the screen.
 */
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import { assertValidTransition, OrderService } from '../../services/order.service';
import { AppError } from '../../middleware/error-handler';
import { ANONYMOUS_BUYER } from '../../lib/buyer-identity';
import { storeDb } from '../../lib/repo-factory';
import { change, egp, f, pair, row, shape } from './kit';

type Rec = Record<string, unknown>;
// order.routes.ts PUT /:id/status, POST /:orderId/mark-paid, POST /admin: authorize('store_admin', 'staff') + (orders:manage). ORDER-MONEY-SUPERADMIN.
const ORDER_ROLES = ['store_admin', 'staff'] as const;
const FORWARD = ['confirmed', 'processing', 'shipped', 'delivered'] as [string, ...string[]];
const STATUS_AR: Record<string, string> = {
  pending: 'قيد الانتظار',
  confirmed: 'مؤكد',
  processing: 'قيد التجهيز',
  shipped: 'اتشحن',
  delivered: 'اتسلّم',
  cancelled: 'ملغي',
  refunded: 'مسترد',
};
const ar = (s: unknown) => STATUS_AR[String(s)] ?? String(s);

const orderRefs = (a: { orderId: string }) => [{ kind: 'order', id: a.orderId }];

/** What a status/cancel/mark-paid decision depends on (target id only): the status fields and the stamp a hand edit moves. */
async function readOrder(ctx: TurnCtx, orderId: string) {
  const o = await OrderService.getById(ctx.storeId, orderId);
  const cod = (o.payments ?? []).find(p => p.provider === 'cod');
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    status: String(o.status),
    paymentStatus: String(o.paymentStatus),
    total: o.total as number,
    isCod: !!cod,
    /** What OrderService.markCodPaid books: the COD payment row's amount, not the order total. */
    codAmount: (cod?.amount ?? null) as number | null,
    updatedAt: o.updatedAt ? new Date(o.updatedAt).toISOString() : null,
  };
}
type OrderState = Awaited<ReturnType<typeof readOrder>>;

const setStatus = change<{ orderId: string; status: string }>({
  name: 'order_set_status',
  capabilityId: 'order.update-status',
  description:
    'Move an order forward to confirmed, processing, shipped or delivered. It can notify the customer, and it cannot be undone from here. It cannot cancel or refund.',
  schema: shape({ orderId: f.id('The order id.'), status: f.enum(FORWARD, 'The new status.') }, [
    'orderId',
    'status',
  ]),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  gate: { roles: ORDER_ROLES, permission: 'orders:manage' },
  audit: { action: 'order.status_updated', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: (ctx, a) => readOrder(ctx, a.orderId),
  describe: (_ctx, a, st) => {
    const s = st as OrderState;
    assertValidTransition(s.status as never, a.status as never); // the route's own state machine: refused at preview, not at apply
    return {
      summary: pair(
        `هغيّر حالة الأوردر ${s.orderNumber} من «${ar(s.status)}» إلى «${ar(a.status)}». ممكن العميل يوصله إشعار بالتغيير.`,
        `Change order ${s.orderNumber} from ${s.status} to ${a.status}. The customer may be notified.`
      ),
      rows: [
        row('رقم الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('الحالة', 'Status', s.status, a.status),
        row('إشعار للعميل', 'Customer notice', null, 'ممكن يتبعت / may be sent'),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const o = await OrderService.updateStatus(ctx.storeId, a.orderId, a.status as never);
    return { orderId: o.id, orderNumber: o.orderNumber, status: o.status };
  },
});

const cancel = change<{ orderId: string }>({
  name: 'order_cancel',
  capabilityId: 'order.cancel',
  description:
    'Cancel an unpaid order and put its stock back. It cannot be undone and the customer may be notified. It refuses an order that is already paid: a paid order must go through the refund or returns flow, because cancelling it would tell the customer a refund was issued while no money moves.',
  schema: shape({ orderId: f.id('The order id.') }, ['orderId']),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  gate: { roles: ORDER_ROLES, permission: 'orders:manage' },
  audit: { action: 'order.cancelled', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: (ctx, a) => readOrder(ctx, a.orderId),
  describe: (_ctx, _a, st) => {
    const s = st as OrderState;
    // A cancel runs the refund effects and sends the "refund issued" notice; on a paid order that would be a lie (no money moves).
    if (s.paymentStatus === 'paid' || s.paymentStatus === 'disputed')
      throw new AppError(
        409,
        'ORDER_PAID_USE_REFUND',
        `Order ${s.orderNumber} is already paid. Cancelling it would tell the customer a refund was issued while no money moves. Use the refund or returns flow instead.`
      );
    assertValidTransition(s.status as never, 'cancelled');
    return {
      summary: pair(
        `هلغي الأوردر ${s.orderNumber} (${egp(s.total)} ج.م) وأرجّع المخزون. العميل ممكن يوصله إشعار بإلغاء الأوردر، والإلغاء مينفعش يترجع.`,
        `Cancel order ${s.orderNumber} (${egp(s.total)} EGP) and put its stock back. The customer may get a cancellation notice; a cancel cannot be undone.`
      ),
      rows: [
        row('رقم الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('الحالة', 'Status', s.status, 'cancelled'),
        row('إجمالي الأوردر (ج.م)', 'Order total (EGP)', egp(s.total), egp(s.total)),
        row('حالة الدفع', 'Payment', s.paymentStatus, s.paymentStatus),
        row('رجوع المخزون', 'Stock goes back', null, true),
        row(
          'إشعار للعميل',
          'Customer notice',
          null,
          'إشعار إلغاء الأوردر / order cancelled notice'
        ),
      ],
      affectedCount: 1,
    };
  },
  // The route (PUT /:id/status) passes no options: stock always goes back.
  run: async (ctx, a) => {
    const o = await OrderService.updateStatus(ctx.storeId, a.orderId, 'cancelled');
    return { orderId: o.id, orderNumber: o.orderNumber, status: o.status };
  },
});

const markPaid = change<{ orderId: string }>({
  name: 'order_mark_paid',
  capabilityId: 'order.mark-paid',
  description:
    'Record that a cash-on-delivery order was paid (the courier or you collected the cash). It books the sale and cannot be undone. The amount is the cash-on-delivery amount recorded on the order.',
  schema: shape({ orderId: f.id('The cash-on-delivery order id.') }, ['orderId']),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  gate: { roles: ORDER_ROLES, permission: 'orders:manage' },
  audit: { action: 'order.cod_marked_paid', resourceType: 'order', resourceId: a => a.orderId },
  refs: orderRefs,
  state: (ctx, a) => readOrder(ctx, a.orderId),
  describe: (_ctx, _a, st) => {
    const s = st as OrderState;
    // The same refusals OrderService.markCodPaid makes, shown before the card exists.
    if (!s.isCod) throw new AppError(400, 'NOT_COD', 'This order is not a Cash on Delivery order');
    if (s.paymentStatus === 'paid')
      throw new AppError(400, 'ALREADY_PAID', 'Order is already marked as paid');
    if (s.status === 'cancelled' || s.status === 'refunded')
      throw new AppError(
        409,
        'ORDER_NOT_PAYABLE',
        'A cancelled or refunded order cannot be marked paid'
      );
    return {
      summary: pair(
        `هسجّل إن الأوردر ${s.orderNumber} اتدفع كاش بمبلغ ${egp(s.codAmount)} ج.م. ده بيتسجل كبيعة ومينفعش يترجع.`,
        `Record order ${s.orderNumber} as paid in cash: ${egp(s.codAmount)} EGP. This books the sale and cannot be undone.`
      ),
      rows: [
        row('رقم الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('حالة الدفع', 'Payment', s.paymentStatus, 'paid'),
        row('المبلغ المحصّل (ج.م)', 'Amount collected (EGP)', null, egp(s.codAmount)),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const r = await OrderService.markCodPaid(ctx.storeId, a.orderId, ctx.userId);
    return { orderId: a.orderId, orderNumber: r.orderNumber };
  },
});

type PhoneArgs = {
  customerName: string;
  phone: string;
  address: string;
  city: string;
  notes?: string;
  items: Array<{ productId: string; quantity: number }>;
};
const phoneOrder = change<PhoneArgs>({
  name: 'order_create_phone',
  capabilityId: 'order.create-phone',
  description:
    'Create a cash-on-delivery order for a customer who ordered by phone: name, phone, address, city and the items (product id and quantity). Prices come from the catalog; shipping and tax are added by the store. Nothing is sent to the customer. Undo cancels the new order (with its own confirmation).',
  schema: shape<PhoneArgs>(
    {
      customerName: f.str('Customer full name.', { max: 120 }),
      phone: f.str('Customer phone number.', { max: 30 }),
      address: f.str('Delivery address.', { max: 300 }),
      city: f.str('City.', { max: 100 }),
      notes: f.text('Order note.', { max: 500 }),
      items: f.list(
        f.obj(
          {
            productId: f.id('Product id.'),
            quantity: f.int('Quantity.', { min: 1, max: 999 }),
          },
          ['productId', 'quantity']
        ),
        { min: 1, max: 25, description: 'The items ordered.' }
      ),
    },
    ['customerName', 'phone', 'address', 'city', 'items']
  ),
  policy: 'preview',
  undo: 'compensating',
  gate: { roles: ORDER_ROLES }, // order.routes.ts POST /admin: authorize('store_admin', 'staff') + requireStoreAccess (no permission key)
  audit: { action: 'order.created_by_assistant', resourceType: 'order' },
  refs: a => a.items.map(i => ({ kind: 'product', id: i.productId })),
  // Depends on the product ids only: price changes move the etag.
  state: async (ctx, a) => {
    const ids = [...new Set(a.items.map(i => i.productId))].sort();
    const rows = await (
      await storeDb(ctx.storeId)
    ).product.findMany({
      where: { id: { in: ids }, storeId: ctx.storeId },
      select: { id: true, name: true, price: true },
    });
    if (rows.length !== ids.length) throw new AppError(404, 'NOT_FOUND', 'Product not found');
    return rows.sort((x, y) => (x.id < y.id ? -1 : 1));
  },
  describe: (_ctx, a, st) => {
    const prods = new Map(
      (st as Array<{ id: string; name: string; price: number }>).map(p => [p.id, p])
    );
    let subtotal = 0;
    const lines = a.items.map(i => {
      const p = prods.get(i.productId)!;
      subtotal += p.price * i.quantity;
      return row(
        `${p.name} × ${i.quantity}`,
        `${p.name} × ${i.quantity}`,
        null,
        egp(p.price * i.quantity)
      );
    });
    return {
      summary: pair(
        `هعمل أوردر تليفوني (دفع عند الاستلام) لـ ${a.customerName} بـ ${a.items.length} صنف، إجمالي الأصناف ${egp(subtotal)} ج.م. الشحن والضريبة بيتضافوا من المتجر، ومفيش رسالة هتتبعت للعميل.`,
        `Create a cash-on-delivery phone order for ${a.customerName}: ${a.items.length} item(s), items total ${egp(subtotal)} EGP. Shipping and tax are added by the store; nothing is sent to the customer.`
      ),
      rows: [
        row('الاسم', 'Customer', null, a.customerName),
        row('التليفون', 'Phone', null, a.phone),
        row('العنوان', 'Address', null, `${a.address}, ${a.city}`),
        ...lines,
        row('إجمالي الأصناف (ج.م)', 'Items total (EGP)', null, egp(subtotal)),
        row('الدفع', 'Payment', null, 'COD'),
      ],
      affectedCount: 1,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    const [firstName, ...rest] = a.customerName.split(/\s+/);
    const order = await OrderService.createAdminOrder(
      ctx.storeId,
      ctx.userId,
      {
        shippingAddress: {
          firstName,
          lastName: rest.join(' '),
          phone: a.phone,
          address1: a.address,
          city: a.city,
        } as Rec,
        items: a.items,
        paymentMethod: 'cod',
        paymentProvider: 'cod',
        ...(a.notes ? { notes: a.notes } : {}),
      },
      { role: ctx.role },
      { buyer: ANONYMOUS_BUYER }
    );
    return { orderId: order.id, orderNumber: order.orderNumber };
  },
  inverse: (_a, _restore, result) => {
    const id = (result as { orderId?: string } | undefined)?.orderId;
    return id ? { tool: 'order_cancel', args: { orderId: id } } : null;
  },
});

export function ordersTools(): ToolSpec[] {
  return [setStatus, cancel, markPaid, phoneOrder];
}
