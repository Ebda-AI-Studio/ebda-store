import crypto from 'crypto';
import { normalizePhoneForStorage } from '@ebda/shared';
import { customerRow, customerRows, isLiveCustomer, pickSelected } from '../lib/customer-directory';
import { prisma, Prisma, ReturnStatus, ReturnType, withStore } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { socketService } from './socket.service';
import { OrderService } from './order.service';
import {
  PaymentService,
  findOutstandingRefundClaims,
  reconcileOutstandingRefundClaims,
} from './payment-providers/payment.factory';
import { refundMayHaveExecuted } from './payment-providers/refund-outcome';
import logger from '../lib/logger';
import {
  allocatePartialReturn,
  splitByPaymentMix,
  type AllocationLine,
} from './accounting/posting/partial-return-allocation';
import { GATEWAY_REFUND_METHODS, REFUND_METHODS } from '../lib/refund-methods';
import {
  loadBackorderCancelledQty,
  loadPriorReversedQty,
} from './accounting/posting/prior-reversed-qty';
import { featureService } from './feature.service';
import { WalletService } from './wallet.service';
import { evaluateReturnWindow } from '../lib/return-window';
import { opKey } from '../lib/money-idempotency';
import { storeDb, storeMoney, type MoneyClient } from '../lib/repo-factory';

import {
  minorToDecimalString,
  productReturnAdjustment,
  type ReturnLineInput,
  type SnapshotRung,
  type TierLadderSnapshot,
} from '@ebda/shared';
interface CreateReturnItemInput {
  orderItemId: string;
  productId: string;
  productName: string;
  quantity: number;
  reason?: string;
  condition?: string;
}

interface CreateReturnData {
  orderId: string;
  /** null = a GUEST return (Ruling GUEST-RET-1, `createForGuest`): the order has no customer row. */
  customerId: string | null;
  type: 'return' | 'exchange' | 'refund';
  reason: string;
  reasonDetail?: string;
  customerNotes?: string;
  /**
   * Individual (non-bundle) order lines to return. An entry naming a line
   * that belongs to a bundle box (`OrderItem.bundleGroupId` set) is refused
   * with `bundle_returns_are_atomic` — `bundleGroupIds` below is the only
   * way to return a bundle's components.
   */
  items?: CreateReturnItemInput[];
  /**
   * Bundle boxes to return as complete, atomic units (product-bundles design
   * doc, "Returns — atomic"). Every component of the named group returns at
   * its FULL ordered quantity — restocking every component — and the refund
   * is the sum of the group's allocated line totals, which by Task 6's
   * invariant (`Σ(line.total) === bundlePrice` per group) is exactly the
   * bundle price the customer paid, never any component's shelf price. One
   * id per BOX (Task 6 writes one `bundleGroupId` per box, not per bundle),
   * so returning one box out of an order with several leaves the others
   * untouched. Itemized (partial-box) bundle returns are out of scope — the
   * allocated share is already stored per line so enabling them later is a
   * UI + validation change, not a migration.
   */
  bundleGroupIds?: string[];
}

interface ListReturnsOptions {
  page?: number;
  limit?: number;
  status?: string;
  type?: string;
}

// The refund-method sets live in lib/refund-methods.ts so the GL poster reads
// the same set this service branches on; re-exported for the route.
export { GATEWAY_REFUND_METHODS, REFUND_METHODS };

/** Gateway refusals meaning the customer already has the money on the original method. */
const ALREADY_PAID_TO_CUSTOMER = new Set(['REFUND_ALREADY_ISSUED', 'PAYMENT_FULLY_REFUNDED']);

/** One return item as the merchant is shown it before confirming, and as it is persisted (B2B Task 8b). */
export interface ReturnLineAdjustment {
  returnItemId: string;
  orderItemId: string;
  productName: string;
  quantity: number;
  keptQty: number;
  tierMinQty: number | null;
  /** The paid unit price x quantity returned. */
  standardRefund: number;
  /** Signed piastres the refund is reduced by AFTER the floor and any override (what is persisted). */
  adjustment: number;
  adjustedRefund: number;
  /** What the floor at 0 swallowed (never charged to the buyer), carried to the product's next return (Ruling B2B-20). */
  shortfall: number;
  /** The shortfall earlier returns of this product carried forward and this return collects first (B2B-20). */
  carriedIn: number;
  /** Signed change to the product's carry, persisted as `return_items.tier_carry` (+ carried, - consumed or waived). */
  carryDelta: number;
  /** What an override on this product's items waived of the carry (B2B-20; audit-logged with the override). */
  carryWaived: number;
  keptUnitMinor: number;
  reason: 'none' | 'kept_below_tier' | 'released';
  overridden: boolean;
  overrideReason: string | null;
}

export type RefundOverrides = Record<string, { amountMinor: number; reason: string }>;

/**
 * The persisted entitlement snapshot (Json, written by `priceSnapshot`), or null when absent or malformed: then the line is
 * never repriced (Ruling B2B-14, "a missing snapshot never adjusts"). A rung array in the pre-B2B-17 shape (no scope or
 * audience) is treated as malformed rather than guessed at; no such row exists outside development databases.
 */
function ladderOf(raw: unknown): TierLadderSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { rungs?: unknown; groupPercentMinor?: unknown };
  if (!Array.isArray(o.rungs)) return null;
  const g = o.groupPercentMinor;
  if (g !== null && !Number.isInteger(g)) return null;
  const rungs: SnapshotRung[] = [];
  for (const r of o.rungs) {
    const x = r as { minQty?: unknown; priceMinor?: unknown; variant?: unknown; group?: unknown };
    if (
      !Number.isInteger(x?.minQty) ||
      !Number.isInteger(x?.priceMinor) ||
      typeof x.variant !== 'boolean' ||
      typeof x.group !== 'boolean'
    ) {
      return null;
    }
    rungs.push({
      minQty: x.minQty as number,
      priceMinor: x.priceMinor as number,
      variant: x.variant,
      group: x.group,
    });
  }
  return { rungs, groupPercentMinor: g as number | null };
}

/** The order-line columns a partial-return repricing reads (snapshots only; never a live price). */
const ADJUSTMENT_LINE_SELECT = {
  id: true,
  productId: true,
  variantId: true,
  bundleGroupId: true,
  quantity: true,
  price: true,
  listPrice: true,
  priceSource: true,
  priceTierMinQty: true,
  tierLadder: true,
} as const;
type AdjustmentLine = {
  id: string;
  productId: string;
  variantId: string | null;
  bundleGroupId: string | null;
  quantity: number;
  price: number;
  listPrice: number | null;
  priceSource: string | null;
  priceTierMinQty: number | null;
  tierLadder: unknown;
};

/** This return's share of the order's money — see ReturnService.allocateThisReturn. */
interface PartialAllocation {
  /** Net amount owed for the lines this return actually takes back. */
  cashCredit: number;
  /** Lines this return takes back after clamping; 0 = all already returned. */
  returnedLineCount: number;
  /** After this return, has every unit of every line come back? */
  allLinesNowReturned: boolean;
  /**
   * `cashCredit` split by how the order was paid (#1956): the part that goes
   * back to the customer wallet because the order was partly paid from it,
   * and the part refunded at the gateway. `walletShare` is 0 for every order
   * that did not use the wallet, so `gatewayShare === cashCredit` there.
   */
  walletShare: number;
  gatewayShare: number;
}

/** Piastres as a 2-decimal EGP string, for merchant-facing error text. */
function formatMajor(piastres: number): string {
  return minorToDecimalString(piastres);
}

/**
 * Serialise the return writes that read an order's claimed or returned
 * quantities and then act on them — `create()`'s over-claim check and
 * `complete()`'s allocation (#1393). Two of them on the same order would
 * otherwise each read the other's work as not there yet.
 *
 * A transaction-scoped ADVISORY lock, not `SELECT … FOR UPDATE` on the order
 * row like the inventory fanout takes. `complete()` holds this for the whole
 * request, provider call included, and PaymentService.refund commits the
 * order's `refunded` flip on a transaction of its own — which would wait
 * forever on a row lock this request holds, while this request waits for it.
 * The advisory key locks no row, so nothing else that touches the order is
 * blocked by it. Released when the request transaction ends; outside one
 * (scripts, tests) it is released at once and is a no-op.
 */
async function lockOrderReturns(orderId: string): Promise<void> {
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`return-order:${orderId}`}, 0))`;
}

/**
 * The same lock, for the CUSTOMER-facing `create()` — bounded (issues 2004 /
 * 2030). `complete()` holds this key across the provider refund round-trip
 * (a gateway refund can take several seconds), and a storefront return submission
 * must not sit on a pooled connection behind a merchant's refund until its own
 * 30s transaction times out as a P2028 500. It polls the non-blocking
 * `pg_try_advisory_xact_lock` for a short window — long enough for a racing
 * create or a quick completion to finish — then answers a clean 409 the
 * shopper can retry. Same key, so the serialisation #1393 needs is unchanged.
 */
const CREATE_LOCK_WAIT_MS = 3_000;
const CREATE_LOCK_POLL_MS = 100;
async function lockOrderReturnsBounded(orderId: string): Promise<void> {
  const deadline = Date.now() + CREATE_LOCK_WAIT_MS;
  for (;;) {
    const rows = await prisma.$queryRaw<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`return-order:${orderId}`}, 0)) AS locked`;
    if (rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new AppError(
        409,
        'RETURN_ORDER_BUSY',
        'Another return on this order is being processed. Please try again in a moment.'
      );
    }
    await new Promise(resolve => setTimeout(resolve, CREATE_LOCK_POLL_MS));
  }
}

/**
 * A store's customers are User rows in the identity/Postgres side, not in its Durable Object: a DO read cannot `include`
 * them (prisma-lite refuses a cross-database relation), so the DO paths read the return without `customer` and attach it here.
 */
async function withCustomer<T extends { customerId: string | null }>(
  storeId: string,
  rows: T[],
  select: Prisma.UserSelect
): Promise<Array<T & { customer: unknown }>> {
  // a guest return (GUEST-RET-1) has a null (PG) or '' (DO) customer: nothing to look up
  const ids = Array.from(new Set(rows.map(r => r.customerId).filter((id): id is string => !!id)));
  const doRows = await customerRows(storeId, ids);
  const users: Array<{ id: string }> = doRows
    ? doRows.map(u => pickSelected(u, select as Record<string, unknown>) as { id: string })
    : ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids }, storeId },
          select: { id: true, ...select },
        })
      : [];
  const byId = new Map(users.map(u => [u.id, u]));
  return rows.map(r => {
    const u = (r.customerId ? byId.get(r.customerId) : undefined) as
      | ({ id: string } & Record<string, unknown>)
      | undefined;
    if (!u) return { ...r, customer: null };
    const { id: _id, ...rest } = u;
    const keep = Object.fromEntries(Object.keys(select).map(k => [k, rest[k]]));
    return { ...r, customer: { ...(select.id ? { id: u.id } : {}), ...keep } };
  });
}

/**
 * Constant-time compare of a guest's second factor: both sides are hashed first so the buffers are equal length
 * and the time does not depend on where they differ. An empty factor never matches (nothing on the order to prove).
 */
// pq-allow(unused-export): test seam, imported by tests/unit/guest-return-request.test.ts
export function guestFactorEquals(onOrder: string, given: string): boolean {
  const h = (v: string) => crypto.createHash('sha256').update(v).digest();
  const equal = crypto.timingSafeEqual(h(onOrder), h(given));
  return equal && onOrder.length > 0 && given.length > 0;
}

/** The contact a guest left on the order (`shipping_address` JSON): the only identity a guest return has. */
function contactOfOrder(order: { shippingAddress?: unknown }): { email: string; name: string } {
  const a =
    order.shippingAddress && typeof order.shippingAddress === 'object'
      ? (order.shippingAddress as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    email: str(a.email),
    name: `${str(a.firstName)} ${str(a.lastName)}`.trim(),
  };
}

/**
 * A guest return (Ruling GUEST-RET-1) has no customer row: give the merchant's views (list, detail) the contact the
 * guest left on the order in the same `customer` shape, so the returns list and drawer render it like any other.
 * One order read for the whole page, and only when a row is a guest return.
 */
async function fillGuestCustomers<T extends { customerId: string | null; orderId: string }>(
  storeId: string,
  rows: T[]
): Promise<T[]> {
  const guests = rows.filter(r => !r.customerId && !(r as { customer?: unknown }).customer);
  if (guests.length === 0) return rows;
  const orders = await (
    await storeDb(storeId)
  ).order.findMany({
    where: { id: { in: Array.from(new Set(guests.map(g => g.orderId))) }, storeId },
    select: { id: true, shippingAddress: true },
  });
  const byId = new Map(
    orders.map(o => [o.id, (o.shippingAddress ?? {}) as Record<string, unknown>])
  );
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  for (const g of guests) {
    const a = byId.get(g.orderId) ?? {};
    (g as { customer?: unknown }).customer = {
      id: '',
      email: str(a.email),
      firstName: str(a.firstName),
      lastName: str(a.lastName),
      phone: str(a.phone),
    };
  }
  return rows;
}

type UpdatedReturn = Prisma.ReturnGetPayload<{
  include: {
    customer: { select: { email: true; firstName: true; lastName: true } };
    order: { select: { orderNumber: true; locale: true } };
    store: { select: { name: true } };
  };
}>;

export class ReturnService {
  /** updateStatus on a store's Durable Object (Ruling CF-RETURNS-1): the row write is one section there, the include is read after. */
  private static async updateStatusOnDo(
    money: MoneyClient,
    storeId: string,
    returnId: string,
    status: ReturnStatus,
    userId: string,
    notes?: string
  ): Promise<UpdatedReturn> {
    await money.returnStatus({ returnId, status, userId, notes });
    const found = await (
      await storeDb(storeId)
    ).return.findFirst({
      where: { id: returnId, storeId },
      include: { order: { select: { orderNumber: true, locale: true } } },
    });
    if (!found) throw new AppError(404, 'NOT_FOUND', 'Return request not found');
    const [row] = await withCustomer(storeId, [found], {
      email: true,
      firstName: true,
      lastName: true,
    });
    // the Store row is authoritative in D1/Postgres, not on the DO
    const store = await withStore(storeId, tx =>
      tx.store.findFirst({ where: { id: storeId }, select: { name: true } })
    );
    return { ...row, store: { name: store?.name ?? '' } } as unknown as UpdatedReturn;
  }

  /** create on a store's Durable Object: the whole validation and both row sets are one section; the email/socket tail is the Postgres path's. */
  private static async createOnDo(money: MoneyClient, storeId: string, data: CreateReturnData) {
    const { returnId } = await money.returnCreate({
      orderId: data.orderId,
      customerId: data.customerId,
      type: data.type,
      reason: data.reason,
      reasonDetail: data.reasonDetail,
      customerNotes: data.customerNotes,
      items: data.items,
      bundleGroupIds: data.bundleGroupIds,
    });
    const db = await storeDb(storeId);
    const returnRequest = await db.return.findFirst({
      where: { id: returnId, storeId },
      include: { items: true },
    });
    if (!returnRequest) throw new AppError(404, 'NOT_FOUND', 'Return request not found');
    const orderRow = await db.order.findFirst({
      where: { id: data.orderId, storeId },
      select: { orderNumber: true, locale: true },
    });
    const doCustomer = data.customerId ? await customerRow(storeId, data.customerId) : null;
    // a deleted / erased / suspended customer is not mailed (N-9); a guest has no customer row at all
    const customer = !data.customerId
      ? null
      : doCustomer !== undefined
        ? doCustomer && isLiveCustomer(doCustomer)
          ? doCustomer
          : null
        : await prisma.user.findFirst({
            where: { id: data.customerId, storeId },
            select: { email: true, firstName: true, lastName: true },
          });
    const order = orderRow ? { ...orderRow, customer } : null;
    const store = await withStore(storeId, tx =>
      tx.store.findFirst({ where: { id: storeId }, select: { name: true } })
    );
    const orderLocale = (order?.locale ?? undefined) as 'en' | 'ar' | undefined;
    const customerName =
      `${order?.customer?.firstName || ''} ${order?.customer?.lastName || ''}`.trim() || 'Customer';
    void deferAfterTenantCommit('email.returnConfirmation', () =>
      EmailService.sendReturnConfirmation(
        storeId,
        {
          email: order?.customer?.email || '',
          customerName,
          storeName: store?.name ?? '',
          returnNumber: returnRequest.returnNumber,
          orderNumber: order?.orderNumber ?? '',
          type: data.type,
        },
        orderLocale
      )
    ).catch(err => logger.error({ err }, 'Failed to send return confirmation email'));
    try {
      socketService.newReturnNotification(storeId, {
        returnId,
        returnNumber: returnRequest.returnNumber,
        orderNumber: order?.orderNumber ?? '',
        customerName,
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send return notification');
    }
    return returnRequest;
  }

  /**
   * A GUEST return request (Foundation criterion 19, Ruling GUEST-RET-1, audit S2-7).
   *
   * Identity = the order number PLUS a second factor already on the order (the phone or the email the guest typed at
   * checkout, from `shipping_address`). Only a guest order (`customer_id` null) qualifies: a signed-in shopper's order
   * answers like a missing one and the shopper signs in. Every failure of identity (no such order, a registered
   * customer's order, wrong phone, wrong email, no factor given) is ONE identical `GUEST_RETURN_NOT_FOUND` response that
   * echoes nothing and takes the same compare work, so the endpoint is no order-number or phone oracle.
   *
   * Once identity holds, the return is made by `create` itself (Postgres or the StoreDO twin): same delivered-only
   * eligibility, same return window, same items rules. A request moves NO money: the refund method is only chosen
   * at completion, by the merchant (refund-never-implicit), and a guest return can never be completed to store credit.
   */
  static async createForGuest(
    storeId: string,
    input: Omit<CreateReturnData, 'customerId' | 'orderId'> & {
      orderNumber: string;
      phone?: string;
      email?: string;
    }
  ) {
    const { orderNumber, phone, email, ...data } = input;
    const db = await storeDb(storeId);
    const order = await db.order.findFirst({
      where: { storeId, orderNumber: orderNumber.trim(), customerId: null },
      select: { id: true, shippingAddress: true },
    });
    const onOrder = (order?.shippingAddress ?? {}) as Record<string, unknown>;
    // Always run both compares (a dummy value for a missing order) so the work does not depend on the order existing.
    const phoneOk = guestFactorEquals(
      normalizePhoneForStorage(typeof onOrder.phone === 'string' ? onOrder.phone : ''),
      normalizePhoneForStorage(phone ?? '')
    );
    const emailOk = guestFactorEquals(
      typeof onOrder.email === 'string' ? onOrder.email.trim().toLowerCase() : '',
      (email ?? '').trim().toLowerCase()
    );
    // a factor that was given must match; at least one must be given
    const given = Boolean((phone ?? '').trim()) || Boolean((email ?? '').trim());
    const verified =
      !!order && given && (!(phone ?? '').trim() || phoneOk) && (!(email ?? '').trim() || emailOk);
    if (!verified) {
      throw new AppError(
        404,
        'GUEST_RETURN_NOT_FOUND',
        'We could not find an order matching those details.'
      );
    }
    // A guest cannot see order line ids, so with no lines named the request is the WHOLE order: every plain line at its
    // ordered quantity and every bundle box as one unit. The merchant reviews it like any other return.
    let { items, bundleGroupIds } = data;
    if (!items?.length && !bundleGroupIds?.length) {
      const lines = await db.orderItem.findMany({
        where: { orderId: order.id },
        select: {
          id: true,
          productId: true,
          productName: true,
          quantity: true,
          bundleGroupId: true,
        },
      });
      items = lines
        .filter(l => !l.bundleGroupId)
        .map(l => ({
          orderItemId: l.id,
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
        }));
      const groups = Array.from(
        new Set(lines.flatMap(l => (l.bundleGroupId ? [l.bundleGroupId] : [])))
      );
      bundleGroupIds = groups.length ? groups : undefined;
      if (!items.length) items = undefined;
    }
    return ReturnService.create(storeId, {
      ...data,
      items,
      bundleGroupIds,
      orderId: order.id,
      customerId: null,
    });
  }

  /**
   * Generate unique return number
   */
  private static async generateReturnNumber(_storeId: string): Promise<string> {
    const prefix = 'RET';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * List returns for a store
   */
  static async list(storeId: string, options: ListReturnsOptions = {}) {
    const { page = 1, limit = 20, status, type } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ReturnWhereInput = { storeId };

    if (status) {
      where.status = status as ReturnStatus;
    }

    if (type) {
      where.type = type as ReturnType;
    }

    const db = await storeDb(storeId);
    const onDo = !!(await storeMoney(storeId));
    const [listed, total] = await Promise.all([
      db.return.findMany({
        where,
        skip,
        take: limit,
        include: {
          order: {
            select: { orderNumber: true, total: true },
          },
          ...(onDo
            ? {}
            : {
                customer: {
                  select: { id: true, email: true, firstName: true, lastName: true },
                },
              }),
          // `orderItem` select pulls the bundle-tagging snapshot
          // (bundleGroupId/bundleName/bundleNameAr — see OrderItem in
          // schema.prisma) so the admin returns list/drawer can group a
          // bundle box's ReturnItem rows back under the box's name instead
          // of listing its components as unrelated products. `ReturnItem`
          // itself carries no bundle columns — every component of a
          // returned box is a separate row (see ReturnService.create's
          // bundleGroupIds expansion), tied together only via this join.
          items: {
            include: {
              orderItem: {
                select: { bundleGroupId: true, bundleName: true, bundleNameAr: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.return.count({ where }),
    ]);
    const returns = onDo
      ? await withCustomer(storeId, listed as never[], {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        })
      : listed;

    await fillGuestCustomers(storeId, returns as never[]);
    return {
      returns: returns as typeof listed,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get return by ID
   */
  static async getById(storeId: string, returnId: string) {
    const onDo = !!(await storeMoney(storeId));
    const found = await (
      await storeDb(storeId)
    ).return.findFirst({
      where: { id: returnId, storeId },
      include: {
        order: {
          select: {
            orderNumber: true,
            total: true,
            createdAt: true,
            shippingAddress: true,
          },
        },
        ...(onDo
          ? {}
          : {
              customer: {
                select: { id: true, email: true, firstName: true, lastName: true, phone: true },
              },
            }),
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                images: { take: 1, orderBy: { position: 'asc' } },
              },
            },
            // Same bundle-grouping join as `list()` above — kept in sync so
            // whichever surface reads a single return by id can group its
            // component rows under the bundle's name too.
            orderItem: {
              select: { bundleGroupId: true, bundleName: true, bundleNameAr: true },
            },
          },
        },
      },
    });

    if (!found) {
      throw new AppError(404, 'NOT_FOUND', 'Return request not found');
    }
    if (onDo) {
      const [withUser] = await withCustomer(storeId, [found as never], {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
      });
      await fillGuestCustomers(storeId, [withUser as never]);
      return withUser as typeof found;
    }
    await fillGuestCustomers(storeId, [found as never]);
    const returnRequest = found;

    return returnRequest;
  }

  /**
   * Create a return request
   */
  /**
   * STORE-QA-76: the MERCHANT opens a return for an order (a phone request, the admin "New return"). Durable Object stores only
   * (the Postgres path has no DO to hold the claim and is retired). The lines are validated against the order's own remaining
   * quantity; the shopper is not mailed (the merchant already knows). `restock: false` keeps a line's goods off the shelf.
   */
  static async adminCreate(
    storeId: string,
    data: {
      orderId: string;
      type: 'return' | 'refund';
      reason: string;
      reasonDetail?: string;
      items: Array<{ orderItemId: string; quantity: number; restock?: boolean }>;
    },
    idempotencyKey?: string
  ) {
    const money = await storeMoney(storeId);
    if (!money)
      throw new AppError(409, 'RETURNS_NEED_DO_STORE', 'Returns for this store are not available');
    const quote = await money.analyticsRefundQuote({ orderId: data.orderId, items: data.items });
    const byId = new Map(quote.lines.map(l => [l.orderItemId, l]));
    const { returnId } = await money.returnCreate(
      {
        orderId: data.orderId,
        type: data.type,
        reason: data.reason,
        reasonDetail: data.reasonDetail,
        byMerchant: true,
        items: data.items.map(i => ({
          orderItemId: i.orderItemId,
          productId: byId.get(i.orderItemId)!.productId,
          productName: byId.get(i.orderItemId)!.name,
          quantity: i.quantity,
          restock: i.restock,
        })),
      },
      idempotencyKey
    );
    return ReturnService.getById(storeId, returnId);
  }

  /**
   * STORE-QA-76: refund PART of an order from the order page: the chosen lines, per-line restock, one method. It IS a return
   * (type `refund`) opened by the merchant, approved, marked received and completed in one request, so the whole partial-return
   * engine applies unchanged: pro-rata discount/tax allocation, the line quantity cap, the ONE refundable balance (#624), the
   * provider refund with its claim, the partial-return journal and the restock. If completion fails BEFORE money may have moved
   * the return is rejected so its lines are free to retry; an indeterminate provider failure keeps it for reconciliation.
   */
  static async adminPartialRefund(
    storeId: string,
    userId: string,
    data: {
      orderId: string;
      reason: string;
      refundMethod: string;
      items: Array<{ orderItemId: string; quantity: number; restock?: boolean }>;
    },
    idempotencyKey: string
  ) {
    const money = await storeMoney(storeId);
    if (!money)
      throw new AppError(409, 'RETURNS_NEED_DO_STORE', 'Returns for this store are not available');
    const quote = await money.analyticsRefundQuote({ orderId: data.orderId, items: data.items });
    if (quote.refundable <= 0)
      throw new AppError(409, 'NOTHING_REFUNDABLE', 'This order has nothing left to refund.');
    if (quote.coversWholeOrder && data.items.some(i => i.restock === false))
      throw new AppError(
        409,
        'FULL_RETURN_RESTOCK_ALL',
        'Refunding every line restocks every line. Leave one unit out, or restock all lines.'
      );
    const created = await ReturnService.adminCreate(
      storeId,
      {
        orderId: data.orderId,
        type: 'refund',
        reason: data.reason,
        items: data.items,
      },
      opKey('partial-refund-create', idempotencyKey)
    );
    const returnId = created.id as string;
    try {
      if (created.status === 'pending')
        await ReturnService.updateStatusOnDo(money, storeId, returnId, 'approved', userId);
      if (created.status === 'pending' || created.status === 'approved')
        await ReturnService.updateStatusOnDo(money, storeId, returnId, 'received', userId);
      return await ReturnService.complete(storeId, returnId, userId, data.refundMethod);
    } catch (err) {
      const indeterminate =
        refundMayHaveExecuted(err) ||
        (err instanceof AppError && err.code === 'PROVIDER_REFUND_INDETERMINATE');
      // REFUND-988-REV-1 R2: once the refund is RECORDED (row completed, or the completion claim still held because the
      // provider may have paid) the return must never go back to a rejected/refundable state, or the same lines could be
      // refunded and restocked a second time. Unknown state is treated as recorded: rejecting is the unsafe direction.
      let state: { status: string; refundedAt: Date | null } | null = null;
      let stateKnown = true;
      if (!indeterminate) {
        try {
          state = await (
            await storeDb(storeId)
          ).return.findFirst({
            where: { id: returnId, storeId },
            select: { status: true, refundedAt: true },
          });
        } catch (readErr) {
          stateKnown = false;
          logger.error(
            { readErr, storeId, returnId },
            '[ReturnService] partial refund state unreadable after failure'
          );
        }
      }
      const recorded =
        indeterminate || !stateKnown || state?.status === 'completed' || state?.refundedAt != null;
      if (recorded) {
        logger.error(
          { err, storeId, returnId, status: state?.status, needsAttention: true },
          '[ReturnService] partial refund NEEDS ATTENTION: failed after the refund was recorded; return kept (not rejected) so its lines cannot be refunded again'
        );
        if (state?.status === 'completed') {
          // money + stock are committed in the DO; only the post-commit effects (accounting/notification enqueue) failed
          const row = await ReturnService.getById(storeId, returnId);
          return { ...row, needsAttention: true, attentionReason: 'post_refund_effects_failed' };
        }
        if (err instanceof AppError && err.code === 'PROVIDER_REFUND_INDETERMINATE') throw err;
        throw new AppError(
          502,
          'PROVIDER_REFUND_INDETERMINATE',
          'The refund was recorded but this return could not be finished. Do NOT refund it again: check the provider dashboard, then complete this return with "Already refunded - record only".'
        );
      }
      await ReturnService.updateStatusOnDo(
        money,
        storeId,
        returnId,
        'rejected',
        userId,
        'Partial refund did not complete'
      ).catch(rejectErr =>
        logger.error(
          { rejectErr, storeId, returnId },
          '[ReturnService] failed partial refund left a received return behind'
        )
      );
      throw err;
    }
  }

  static async create(storeId: string, data: CreateReturnData) {
    const doMoney = await storeMoney(storeId);
    if (doMoney) return ReturnService.createOnDo(doMoney, storeId, data);
    // Verify order belongs to store and customer
    const order = await prisma.order.findFirst({
      where: {
        id: data.orderId,
        storeId,
        customerId: data.customerId,
        status: 'delivered',
      },
      include: {
        items: true,
        customer: {
          select: { email: true, firstName: true, lastName: true },
        },
        store: {
          select: { name: true, returnWindowDays: true },
        },
      },
    });
    const orderContact = order ? contactOfOrder(order) : null;
    const orderLocale = (order?.locale ?? undefined) as 'en' | 'ar' | undefined;

    if (!order) {
      throw new AppError(400, 'INVALID_ORDER', 'Order not found or not eligible for return');
    }

    // The merchant's published return window binds the seller (Law 181/2018);
    // refuse a request outside it instead of letting support absorb it.
    const windowVerdict = evaluateReturnWindow({
      returnWindowDays: order.store?.returnWindowDays,
      deliveredAt: order.deliveredAt,
      updatedAt: order.updatedAt,
    });
    if (!windowVerdict.open) {
      throw new AppError(
        422,
        'RETURN_WINDOW_CLOSED',
        windowVerdict.reason === 'NOT_ACCEPTED'
          ? 'This store does not accept returns'
          : 'The return window for this order has closed',
        {
          reason: windowVerdict.reason,
          returnWindowDays: order.store?.returnWindowDays,
          closesAt: windowVerdict.closesAt?.toISOString() ?? null,
        }
      );
    }

    // Bundle groups requested as atomic units (see `bundleGroupIds` on
    // CreateReturnData) expand here into one synthesized item per component,
    // at that component's FULL ordered quantity — restocking every component
    // and refunding Σ(line.total) for the group, which by Task 6's invariant
    // is exactly the bundle price. Deduped: naming the same box twice must
    // not double the refund or the claimed quantity.
    const requestedGroupIds = Array.from(new Set(data.bundleGroupIds ?? []));
    const bundleGroupItems: CreateReturnItemInput[] = [];
    for (const groupId of requestedGroupIds) {
      const groupLines = order.items.filter(oi => oi.bundleGroupId === groupId);
      if (groupLines.length === 0) {
        throw new AppError(
          400,
          'INVALID_BUNDLE_GROUP',
          `Bundle group ${groupId} was not found on this order`
        );
      }
      for (const line of groupLines) {
        bundleGroupItems.push({
          orderItemId: line.id,
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
        });
      }
    }

    // A component line inside a bundle box is NOT independently selectable —
    // only the whole box, via `bundleGroupIds` above, can be returned.
    // Letting a single component through here would let the customer keep
    // the rest of the box while it refunds/restocks as if the whole box came
    // back, AND would refund the wrong figure: a component's allocated price
    // is only correct as part of the group's Σ, not standing alone (see the
    // shelf-price note on refundAmount below).
    for (const item of data.items ?? []) {
      const orderItem = order.items.find(oi => oi.id === item.orderItemId);
      if (orderItem?.bundleGroupId) {
        throw new AppError(
          422,
          'bundle_returns_are_atomic',
          `"${orderItem.bundleName ?? 'This bundle'}" can only be returned as a complete box. Select the bundle group instead of an individual component.`
        );
      }
    }

    // Ruling B5-19: an exchange of a gold-rate line is refused. The replacement piece would be priced at
    // TODAY's rate against a price fixed at the old one; the supported shape is a return plus a new order.
    // Refunds are unaffected: they read `order_items.price`, the price actually charged, never the rate.
    if (data.type === 'exchange') {
      const goldLine = order.items.find(
        oi =>
          (data.items ?? []).some(i => i.orderItemId === oi.id) &&
          (oi as { goldSnapshot?: unknown }).goldSnapshot != null
      );
      if (goldLine)
        throw new AppError(
          409,
          'GOLD_EXCHANGE_UNSUPPORTED',
          'A gold-priced piece cannot be exchanged. Return it and place a new order.',
          { messageAr: 'القطعة المسعّرة بالدهب مبتتبدّلش. رجّعها واعمل طلب جديد.' }
        );
    }

    const items: CreateReturnItemInput[] = [...(data.items ?? []), ...bundleGroupItems];
    if (items.length === 0) {
      throw new AppError(
        400,
        'NO_ITEMS',
        'At least one item or bundle group must be selected for return'
      );
    }

    // Cumulative quantities already claimed by this order's OTHER return
    // requests (anything not rejected/cancelled still holds its claim —
    // pending/approved requests reserve the quantity, completed ones consumed
    // it). Without this, the same item could be returned twice across two
    // requests and double-book the manual/store-credit refund side
    // (adversarial audit P1-2 blast radius).
    //
    // Read under the order's returns lock: two requests submitted together
    // (a double-tapped submit, two tabs) would otherwise both read the claims
    // as they were before either, and both reserve the same units. Bounded:
    // a merchant's in-flight gateway refund on this order holds the same key.
    await lockOrderReturnsBounded(data.orderId);
    const priorReturns = await prisma.return.findMany({
      where: {
        storeId,
        orderId: data.orderId,
        status: { notIn: ['rejected', 'cancelled'] },
      },
      select: { items: { select: { orderItemId: true, quantity: true } } },
    });
    // Units a single-line backorder cancel already took back never shipped —
    // they are not returnable either.
    const claimedQty = (await loadBackorderCancelledQty(prisma, { storeId, orderId: data.orderId }))
      .qty;
    for (const prior of priorReturns) {
      for (const it of prior.items) {
        claimedQty.set(it.orderItemId, (claimedQty.get(it.orderItemId) ?? 0) + it.quantity);
      }
    }

    // Validate items — per-line AND cumulative across prior return requests
    // (and across duplicate lines within THIS request, hence the running map).
    // `items` here is the COMBINED list: explicit non-bundle lines plus every
    // bundle group's synthesized component lines from above.
    for (const item of items) {
      const orderItem = order.items.find(oi => oi.id === item.orderItemId);
      if (!orderItem) {
        throw new AppError(400, 'INVALID_ITEM', `Order item ${item.orderItemId} not found`);
      }
      if (item.quantity < 1) {
        throw new AppError(400, 'INVALID_QUANTITY', `Quantity must be at least 1`);
      }
      const alreadyClaimed = claimedQty.get(item.orderItemId) ?? 0;
      if (alreadyClaimed + item.quantity > orderItem.quantity) {
        throw new AppError(
          400,
          'INVALID_QUANTITY',
          `Quantity exceeds remaining returnable quantity for this item`
        );
      }
      claimedQty.set(item.orderItemId, alreadyClaimed + item.quantity);
    }

    const returnNumber = await this.generateReturnNumber(storeId);

    // Calculate refund amount — from `orderItem.price`, the ALLOCATED
    // per-unit price Task 6 snapshotted onto the OrderItem row at checkout,
    // never a live Product/shelf price lookup. For a bundle group this
    // matters: a component's shelf price is its ordinary catalog price, but
    // the customer paid the box's discounted allocation, and
    // `price × quantity === total` (Task 6's invariant) at the FULL quantity
    // requested per bundle group above means this sum equals exactly
    // Σ(line.total) for the group — i.e. the bundle price — never the higher
    // shelf-price total.
    const grossRefund = items.reduce((total, item) => {
      const orderItem = order.items.find(oi => oi.id === item.orderItemId);
      if (orderItem) {
        return total + orderItem.price * item.quantity;
      }
      return total;
    }, 0);
    // B2B Task 8b: what the shopper is told to expect also reflects a tier adjustment (kept units repriced below their
    // tier), computed by the SAME helper complete() and the preview use (review P2-1): the same full-return test (this
    // return alone takes back every unit), the same product-scope repricing, the same floor and release clamp. It is an
    // ESTIMATE like the gross above (another return may complete first); the merchant confirms the exact figure.
    const thisReturnQty = new Map<string, number>();
    for (const item of items) {
      thisReturnQty.set(
        item.orderItemId,
        (thisReturnQty.get(item.orderItemId) ?? 0) + item.quantity
      );
    }
    const isFullReturnEstimate =
      order.items.length > 0 &&
      order.items.every(oi => (thisReturnQty.get(oi.id) ?? 0) >= oi.quantity);
    // Only a tier-priced line can be repriced; an order without one (every retail order) needs no lookup.
    const estimatedAdjustment =
      isFullReturnEstimate || !order.items.some(oi => oi.priceSource === 'tier')
        ? 0
        : (
            await this.computeLineAdjustments(
              storeId,
              null,
              data.orderId,
              items.map((item, i) => ({
                id: `estimate-${i}`,
                orderItemId: item.orderItemId,
                quantity: item.quantity,
                productName: item.productName,
              }))
            )
          ).total;
    const refundAmount = Math.max(0, grossRefund - estimatedAdjustment);

    const returnRequest = await prisma.return.create({
      data: {
        storeId,
        orderId: data.orderId,
        customerId: data.customerId,
        returnNumber,
        type: data.type,
        status: 'pending',
        reason: data.reason,
        reasonDetail: data.reasonDetail,
        customerNotes: data.customerNotes,
        refundAmount,
        items: {
          create: items.map(item => ({
            orderItemId: item.orderItemId,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            reason: item.reason,
            condition: item.condition,
          })),
        },
      },
      include: {
        items: true,
      },
    });

    // Return is committed — hand the confirmation email to the post-commit
    // queue so SMTP latency can't stall the API response.
    //
    // This used to be a bare `void EmailService.sendReturnConfirmation(...)`.
    // `/stores/:storeId/returns` runs under `tenantContext`, so the detached
    // promise inherited the request's tenant transaction and made its Prisma
    // reads (three of them, ending at `store-mailer.service.ts`'s
    // `prisma.store.findUnique`) AFTER that transaction committed — P2028,
    // swallowed by the `.catch` below. Every return confirmation email
    // silently failed to send. `deferAfterTenantCommit` reruns the same call
    // in a fresh tenant transaction once the request's has committed; the
    // send itself is now durable (`{ queue: true }` in email.service.ts).
    void deferAfterTenantCommit('email.returnConfirmation', () =>
      EmailService.sendReturnConfirmation(
        storeId,
        {
          email: order.customer?.email || orderContact?.email || '',
          customerName:
            `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
            orderContact?.name ||
            'Customer',
          storeName: order.store.name,
          returnNumber,
          orderNumber: order.orderNumber,
          type: data.type,
        },
        orderLocale
      )
    ).catch(err => logger.error({ err }, 'Failed to send return confirmation email'));

    // Send real-time notification to store admins
    try {
      socketService.newReturnNotification(storeId, {
        returnId: returnRequest.id,
        returnNumber,
        orderNumber: order.orderNumber,
        customerName:
          `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
          orderContact?.name ||
          'Customer',
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send return notification');
    }

    return returnRequest;
  }

  /**
   * Update return status
   */
  static async updateStatus(
    storeId: string,
    returnId: string,
    status: ReturnStatus,
    userId: string,
    notes?: string
  ) {
    // Validate the return exists (will throw if not found)
    await this.getById(storeId, returnId);

    const updateData: Prisma.ReturnUpdateInput = {
      status,
      adminNotes: notes,
    };

    // Set additional fields based on status
    switch (status) {
      case 'approved':
        updateData.approvedBy = userId;
        updateData.approvedAt = new Date();
        break;
      case 'rejected':
        updateData.rejectedBy = userId;
        updateData.rejectedAt = new Date();
        updateData.rejectionReason = notes;
        break;
      case 'shipped':
        updateData.shippedAt = new Date();
        break;
      case 'received':
        updateData.receivedAt = new Date();
        break;
      case 'completed':
        updateData.refundedAt = new Date();
        break;
    }

    const doMoney = await storeMoney(storeId);
    const updatedReturn: UpdatedReturn = doMoney
      ? await ReturnService.updateStatusOnDo(doMoney, storeId, returnId, status, userId, notes)
      : await prisma.return.update({
          where: { id: returnId, storeId },
          data: updateData,
          include: {
            customer: {
              select: { email: true, firstName: true, lastName: true },
            },
            order: {
              select: { orderNumber: true, locale: true },
            },
            store: {
              select: { name: true },
            },
          },
        });

    const returnOrderLocale = (updatedReturn.order?.locale ?? undefined) as 'en' | 'ar' | undefined;
    // A guest return (GUEST-RET-1) has no customer row: its status mail goes to the contact on the order.
    const guestContact = updatedReturn.customer
      ? null
      : contactOfOrder(
          (await (
            await storeDb(storeId)
          ).order.findFirst({
            where: { id: updatedReturn.orderId, storeId },
            select: { shippingAddress: true },
          })) ?? {}
        );

    // Status was updated — same post-commit deferral as sendReturnConfirmation
    // above; this path was broken in exactly the same way.
    void deferAfterTenantCommit('email.returnStatusUpdate', () =>
      EmailService.sendReturnStatusUpdate(
        storeId,
        {
          email: updatedReturn.customer?.email ?? guestContact?.email ?? '',
          customerName: updatedReturn.customer
            ? `${updatedReturn.customer.firstName} ${updatedReturn.customer.lastName}`
            : guestContact?.name || 'Customer',
          storeName: updatedReturn.store.name,
          returnNumber: updatedReturn.returnNumber,
          status,
          notes,
        },
        returnOrderLocale
      )
    ).catch(err => logger.error({ err }, 'Failed to send return status email'));

    // Send real-time notification to customer
    try {
      if (updatedReturn.customerId)
        socketService.returnStatusNotification(updatedReturn.customerId, {
          returnNumber: updatedReturn.returnNumber,
          status,
        });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send return status notification');
    }

    return updatedReturn;
  }

  /**
   * Approve a return request
   */
  static async approve(storeId: string, returnId: string, userId: string, notes?: string) {
    return this.updateStatus(storeId, returnId, 'approved', userId, notes);
  }

  /**
   * Reject a return request
   */
  static async reject(storeId: string, returnId: string, userId: string, reason: string) {
    return this.updateStatus(storeId, returnId, 'rejected', userId, reason);
  }

  /**
   * Mark return as received
   */
  static async markReceived(storeId: string, returnId: string, userId: string) {
    return this.updateStatus(storeId, returnId, 'received', userId);
  }

  /**
   * Complete return and process refund.
   *
   * `refundMethod` semantics — see GATEWAY_REFUND_METHODS:
   *   - a gateway method actually triggers the payment provider refund,
   *     pushing money back via the same channel the customer paid with.
   *     Provider failure aborts the return-completion (the merchant retries
   *     or switches method).
   *   - any other value (`'store_credit'`, `'bank_transfer'`, …): the
   *     merchant handles the refund off-platform; we only record the
   *     bookkeeping side here.
   *
   * The admin's own value is `'original'` ("Original payment method"). It was
   * missing from the gateway set, which matched only `'gateway'` and
   * `'original_payment'` — strings nothing in apps/ ever produces. Every
   * completion from the returns page therefore took the manual branch: no
   * provider refund was issued, the customer's card was never credited, and
   * because no gateway amount existed the Return row kept its creation-time
   * GROSS estimate and the refund email quoted it, while the journal booked
   * the NET allocation. Three different numbers, one of them zero.
   *
   * In ALL cases the refund effects are dispatched through
   * `OrderService.applyRefundEffects` — whole-order for a FULL return,
   * item-level (`partial` payload) for a partial one — so inventory
   * restoration and the whole-order reversals (coupon, affiliate, loyalty)
   * happen consistently and only when the entire order actually came back.
   */
  static async complete(
    storeId: string,
    returnId: string,
    _userId: string,
    refundMethod: string,
    /** B2B Task 8b: per return item id, the refund the merchant chose instead of the computed one (with a reason). */
    refundOverrides: RefundOverrides = {}
  ) {
    const returnRequest = await this.getById(storeId, returnId);

    const doMoney = await storeMoney(storeId);
    if (doMoney)
      return ReturnService.completeOnDo(
        doMoney,
        storeId,
        returnId,
        _userId,
        refundMethod,
        refundOverrides
      );

    if (returnRequest.status !== 'received' && returnRequest.status !== 'inspecting') {
      throw new AppError(400, 'INVALID_STATUS', 'Return must be received before completing');
    }

    // One completion per ORDER at a time (#1393). The claim below is per
    // Return row, so two DIFFERENT returns on the same order could both pass
    // it, both read prior returns without the other (neither is completed
    // yet), and both refund the same line. Held until the request commits, so
    // the second one reads the first as completed.
    if (returnRequest.orderId) await lockOrderReturns(returnRequest.orderId);

    // ATOMIC CLAIM. The check above is a read, and the flip to 'completed'
    // happens hundreds of lines later, AFTER the provider round-trip — so two
    // concurrent calls (a merchant double-clicking "Complete") both passed the
    // read and both refunded. The widened payment lookup used to mask this by
    // accident: once the first refund flipped the Payment to
    // 'partially_refunded' the second call found no payment and died on a 400.
    // That accident is gone now that a partially-refunded payment is a valid
    // refund source, so the mutex has to be real.
    //
    // `refundedAt` is the claim marker: nullable, only ever set at completion,
    // and updateMany's WHERE is evaluated atomically, so exactly one caller can
    // transition null -> now. Losing the race is a 409, not a second refund —
    // gateway refunds are terminal at the gateway with no undo API.
    //
    // The claim lives in the request transaction, so a crash or any 5xx rolls
    // it back with everything else: it cannot strand a return (#1349, #1361).
    // What stops a retry from refunding twice after money left is the refund
    // key PaymentService commits on its own (`return:<id>`), not this marker.
    const claim = await prisma.return.updateMany({
      where: {
        id: returnId,
        storeId,
        status: { in: ['received', 'inspecting'] },
        refundedAt: null,
      },
      data: { refundedAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new AppError(
        409,
        'RETURN_ALREADY_COMPLETING',
        'This return is already being completed. Refresh before retrying.'
      );
    }
    // Everything from here to the completion write is inside the claim. A throw
    // must RELEASE it, or a failure that still commits (any 4xx) leaves the
    // return unfinishable (see the catch at the end of this method) — but ONLY
    // while no money can have moved. This flag is the "money may have moved"
    // latch.
    let providerRefundExecuted = false;
    try {
      const isInventoryRestoring =
        returnRequest.type === 'return' || returnRequest.type === 'refund';

      // Full vs partial return: a return is FULL only when it covers EVERY
      // order line at its full quantity. Anything less is a partial return and
      // must apply ITEM-LEVEL effects — the whole-order `order/refunded` fanout
      // would restore inventory the customer still holds, reverse the coupon,
      // claw back the full affiliate commission and strip loyalty points earned
      // on the kept items (adversarial audit P1-2).
      let isFullReturn = false;
      let orderLines: AllocationLine[] = [];
      if (returnRequest.orderId) {
        const orderItems = await prisma.orderItem.findMany({
          where: { orderId: returnRequest.orderId },
          // `price` is for the partial allocation below, not just the
          // full/partial decision.
          select: { id: true, quantity: true, price: true, priceSource: true },
        });
        orderLines = orderItems;
        const returnedQty = new Map<string, number>();
        for (const it of returnRequest.items) {
          returnedQty.set(it.orderItemId, (returnedQty.get(it.orderItemId) ?? 0) + it.quantity);
        }
        isFullReturn =
          orderItems.length > 0 &&
          orderItems.every(oi => (returnedQty.get(oi.id) ?? 0) >= oi.quantity);
      }

      // Trigger the provider refund FIRST when the merchant chose
      // gateway-based refunds. If the provider fails we want to bail
      // out before flipping the return to 'completed' — otherwise the
      // customer sees a "refund processed" status with no money back.
      const isGatewayRefund = (GATEWAY_REFUND_METHODS as readonly string[]).includes(refundMethod);
      // Set when PaymentService.refund itself fired the FULL whole-order
      // effects internally — its own answer, never re-derived here.
      let gatewayRanFullEffects = false;
      // What the customer is owed for this return, when it is known. Hoisted so
      // the completion write below can replace the creation-time GROSS estimate
      // with it.
      let refundAmount: number | undefined;
      // An EXCHANGE must never move money. It swaps goods; the customer is not
      // refunded, which is why `isInventoryRestoring` excludes it and why none
      // of the downstream effects fire for it.
      //
      // The gateway branch below was gated only on the refund METHOD, never on
      // the return type. That was harmless while the branch was unreachable —
      // it matched only 'gateway'/'original_payment', which nothing in apps/
      // produces — but adding the admin's own 'original' made it live. A
      // merchant completing a partial exchange with "Original payment method"
      // would then execute a real, irreversible refund at the provider while
      // the side-effect dispatch stayed silent: no order/refunded event, so no
      // pro-rata GL adjustment, no restock of the returned unit, no refund
      // email. Revenue, tax and COGS stay fully booked against cash that has
      // left the gateway; the cash account is overstated, VAT is over-declared
      // for the period, and the trial balance still balances so nothing
      // surfaces it. A FULL exchange is worse still: it passes an absent
      // amount, so PaymentService runs the WHOLE-order effects internally and
      // reverses an exchange the type says must not be reversed.
      //
      // Refuse the combination rather than inventing accounting for it. If
      // exchanges ever need to settle a price difference, that needs its own
      // money path, not this one.
      if (isGatewayRefund && returnRequest.type === 'exchange') {
        throw new AppError(
          400,
          'EXCHANGE_CANNOT_REFUND_TO_GATEWAY',
          'An exchange swaps goods and does not refund the customer. Choose store credit or another method, or complete it as a return.'
        );
      }

      // The NET amount a PARTIAL return is worth, whatever the method (#1340).
      // `Return.refundAmount` is the creation-time GROSS estimate (no discount
      // share, no tax), and the journal books this allocation, so a manual or
      // store-credit completion that kept the estimate showed the merchant —
      // and emailed the customer — a figure the ledger never matched. The
      // method decides the channel the money moves through, not how much.
      let partial: PartialAllocation | null = null;
      // B2B Task 8b: the tier adjustment of a partial return (empty and 0 for every line that is not tier-priced).
      let tierAdj: { lines: ReturnLineAdjustment[]; total: number } = { lines: [], total: 0 };
      if (Object.keys(refundOverrides).length > 0 && (!isInventoryRestoring || isFullReturn)) {
        throw new AppError(
          400,
          'OVERRIDE_NOT_APPLICABLE',
          'Refund overrides apply to a partial return only; this return has no tier adjustment to override.'
        );
      }
      if (isInventoryRestoring && returnRequest.orderId && !isFullReturn) {
        tierAdj = await this.computeLineAdjustments(
          storeId,
          returnId,
          returnRequest.orderId,
          returnRequest.items.map(i => ({
            id: i.id,
            orderItemId: i.orderItemId,
            quantity: i.quantity,
            productName: i.productName,
          })),
          refundOverrides
        );
        partial = await this.allocateThisReturn(
          storeId,
          returnId,
          returnRequest.orderId,
          orderLines,
          returnRequest.items,
          tierAdj.total
        );
        if (partial.returnedLineCount === 0) {
          throw new AppError(
            400,
            'PARTIAL_REFUND_NOTHING_TO_REFUND',
            'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.'
          );
        }
        refundAmount = partial.cashCredit;
      }

      // A partial return on an order paid partly from the customer wallet
      // refunds the wallet's pro-rata share to the wallet and only the rest at
      // the gateway (#1956). When the whole allocation is the wallet's (an
      // order paid entirely from it, or a rounding piastres), nothing is sent.
      const walletShare = isGatewayRefund && partial ? partial.walletShare : 0;
      const skipProvider = isGatewayRefund && partial !== null && partial.gatewayShare === 0;

      if (isGatewayRefund && returnRequest.orderId && !skipProvider) {
        const plan = await this.planGatewayRefund(
          storeId,
          returnId,
          returnRequest.orderId,
          isFullReturn,
          partial
        );
        // What the customer is owed: for a partial return the whole
        // allocation (gateway + wallet share), for a full one what the gateway
        // sends.
        refundAmount = partial ? partial.cashCredit : plan.amount;

        try {
          const result = await PaymentService.refund(
            {
              transactionId: plan.transactionId,
              reason: 'Customer return',
              amount: plan.amount,
              // Committed with the claim, so a retry of THIS return after the
              // request rolled back is refused instead of paying again.
              refundKey: `return:${returnId}`,
              // A partial return that leaves lines with the customer never
              // reverses the whole order, even when its amount happens to use
              // up what is left on the payment (#1402).
              itemLevel: partial !== null && !partial.allLinesNowReturned,
            },
            undefined,
            storeId
          );
          // Money is out. Nothing below may release the completion claim.
          providerRefundExecuted = true;
          // PaymentService's OWN decision (#1473). Re-deriving it here from the
          // payment row read before the call disagreed with it whenever a
          // webhook or another refund moved the balance in between — either
          // suppressing the only dispatch, or firing a second one that
          // restored the same units twice.
          gatewayRanFullEffects = result.wholeOrderEffectsApplied === true;
        } catch (err) {
          // PaymentService says whether the request reached the provider, from
          // where it actually knows (#1359, #1431). Re-reading the balance could
          // not tell our refund from a concurrent one, and PaymentService used
          // to reset that balance on a timeout anyway.
          providerRefundExecuted = refundMayHaveExecuted(err);
          logger.error(
            { err, storeId, returnId, providerRefundExecuted },
            providerRefundExecuted
              ? '[ReturnService] Gateway refund FAILED AFTER the money may have moved — return NOT marked completed, reconcile manually'
              : '[ReturnService] Gateway refund failed — return NOT marked completed'
          );
          if (providerRefundExecuted) {
            throw new AppError(
              502,
              'PROVIDER_REFUND_INDETERMINATE',
              'The refund reached the payment provider but this return could not be completed. Do NOT refund it again: check the provider dashboard, then complete this return with "Already refunded — record only" so it is recorded without a second refund.'
            );
          }
          // Refused before anything was sent (a refund already issued for this
          // return, a payment that changed under us): the reason is the message.
          if (err instanceof AppError && err.statusCode < 500) throw err;
          throw new AppError(
            502,
            'PROVIDER_REFUND_FAILED',
            'Payment provider refund failed. Please retry or switch refund method.'
          );
        }
      }

      // A NON-gateway completion of a return whose earlier gateway refund may
      // have gone out (PROVIDER_REFUND_INDETERMINATE / REFUND_ALREADY_ISSUED
      // both tell the merchant to "complete with Already refunded — record
      // only") is the merchant settling that claim. Record it, so the claim
      // has a terminal state and the stuck-claim sweep stops alerting on it
      // (issue 2002). Same transaction as the completion below.
      if (!isGatewayRefund && returnRequest.orderId) {
        const settled = await reconcileOutstandingRefundClaims({
          storeId,
          orderId: returnRequest.orderId,
          refundKey: `return:${returnId}`,
          refundMethod,
          userId: _userId,
        });
        if (settled.length > 0) {
          logger.info(
            { storeId, returnId, claims: settled, refundMethod },
            '[ReturnService] merchant settled outstanding refund claim(s) on completion'
          );
        }
      }

      // STORE CREDIT → CUSTOMER WALLET (D1). Only when the store has the
      // `customer_wallet` feature: with it OFF, `store_credit` keeps its old
      // meaning (the merchant settles it off-platform) and nothing below runs.
      // Only a return/refund moves money — an exchange never does, the same
      // rule the gateway branch enforces above. The credit is written after
      // the completion row, on the same (request) transaction, so the two
      // commit or roll back together; the idempotency key (the return id)
      // makes a replayed completion a no-op rather than a second credit.
      let walletCreditAmount: number | undefined;
      // GUEST-RET-1: a guest return has no wallet; store credit would be money into nowhere.
      if (
        refundMethod === 'store_credit' &&
        !returnRequest.customerId &&
        (await featureService.isFeatureEnabled(storeId, 'customer_wallet'))
      ) {
        throw new AppError(
          400,
          'GUEST_RETURN_NO_WALLET',
          'A guest return has no wallet. Refund it to the original method or by bank transfer instead.'
        );
      }
      if (
        refundMethod === 'store_credit' &&
        isInventoryRestoring &&
        returnRequest.orderId &&
        (await featureService.isFeatureEnabled(storeId, 'customer_wallet'))
      ) {
        walletCreditAmount = await this.computeStoreCreditAmount(
          storeId,
          returnId,
          returnRequest.orderId,
          orderLines,
          returnRequest.items,
          isFullReturn,
          tierAdj.total
        );
        if (!isFullReturn && walletCreditAmount <= 0) {
          throw new AppError(
            400,
            'PARTIAL_REFUND_NOTHING_TO_REFUND',
            'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.'
          );
        }
      }

      const updatedReturn = await prisma.return.update({
        where: { id: returnId, storeId },
        data: {
          status: 'completed',
          refundMethod,
          refundedAt: new Date(),
          // Replace the creation-time GROSS estimate with what the customer is
          // actually owed: what left the gateway, or — for any other method —
          // the same net allocation the journal books. A FULL return on a
          // manual method keeps the estimate; nothing in this system decides
          // what the merchant hands back for a whole order off-platform.
          ...(refundAmount != null ? { refundAmount } : {}),
          // Same, for store credit that actually landed in the wallet.
          ...(walletCreditAmount != null ? { refundAmount: walletCreditAmount } : {}),
        },
      });

      // B2B Task 8b: persist what each item's refund was reduced by (and any override, with who and why) in the SAME request
      // transaction as the completion row. The GL posting and every later return's cumulative allocation read these values,
      // never re-derive them.
      for (const l of tierAdj.lines) {
        await prisma.returnItem.update({
          where: { id: l.returnItemId },
          data: {
            tierAdjustment: l.adjustment,
            tierCarry: l.carryDelta,
            adjustmentOverridden: l.overridden,
            adjustmentOverrideReason: l.overrideReason,
            adjustmentOverrideBy: l.overridden ? _userId : null,
          },
        });
      }

      if (
        walletCreditAmount != null &&
        walletCreditAmount > 0 &&
        returnRequest.orderId &&
        returnRequest.customerId
      ) {
        await WalletService.creditForReturn({
          storeId,
          customerId: returnRequest.customerId,
          returnId,
          orderId: returnRequest.orderId,
          amount: walletCreditAmount,
        });
      }

      // The wallet's share of a gateway refund (#1956), on the same request
      // transaction as the completion row. Keyed on the return, so a replayed
      // completion credits nothing more. The GL reads this ledger row to book
      // the share against the wallet liability (resolveReturnRefundLegs).
      if (walletShare > 0 && returnRequest.orderId && returnRequest.customerId) {
        await WalletService.creditReturnWalletShare({
          storeId,
          customerId: returnRequest.customerId,
          returnId,
          orderId: returnRequest.orderId,
          amount: walletShare,
        });
      }

      // Side-effects (inventory + coupon + commission + loyalty) routing:
      //
      //   - FULL return, gateway FULL refund: PaymentService.refund already
      //     dispatched the whole-order fanout internally — don't double-fire.
      //   - FULL return, manual method (or a gateway refund the provider
      //     treated as partial): fire the whole-order fanout here.
      //   - PARTIAL return, ANY method: fire the ITEM-LEVEL event. The old
      //     code's premise ("gateway refunds already ran applyRefundEffects,
      //     calling it here would double up") only held for FULL refunds —
      //     PaymentService.refund applies NO effects for a partial provider
      //     refund, so partial gateway returns never restocked the returned
      //     goods at all, and partial manual returns reversed the WHOLE order.
      //
      // Edge: the FINAL piece of a piecewise return (every line now returned)
      // whose amount uses up the payment makes the gateway run FULL effects
      // internally; skipping the local partial event then avoids restoring the
      // returned lines twice. The full run subtracts quantities already
      // restored by completed partial returns, so it restores exactly this
      // piece's lines.
      if (isInventoryRestoring && returnRequest.orderId && !gatewayRanFullEffects) {
        if (isFullReturn) {
          await OrderService.applyRefundEffects(storeId, returnRequest.orderId);
        } else {
          await OrderService.applyRefundEffects(storeId, returnRequest.orderId, {
            partial: {
              items: returnRequest.items.map(i => ({
                orderItemId: i.orderItemId,
                quantity: i.quantity,
              })),
              refundKey: returnRequest.id,
              // The NET amount (what left the gateway, or the allocation for any
              // other method). This figure reaches the customer's refund
              // notification, so it must never be absent: the consumer falls
              // back to `order.total` when a partial payload carries no amount,
              // which emails a full-order "Refund issued" figure for a single
              // returned item — the exact bug that fallback's comment records.
              // Store credit that landed in the customer wallet is the figure
              // for that method (the same allocation — see
              // computeStoreCreditAmount).
              refundAmount:
                refundAmount ?? walletCreditAmount ?? returnRequest.refundAmount ?? undefined,
            },
          });
        }
      }

      // Ruling B2B-20: what an override waived of a carried shortfall, for the route's audit log (0 when nothing was waived).
      return {
        ...updatedReturn,
        tierCarryWaived: tierAdj.lines.reduce((n, l) => n + l.carryWaived, 0),
      };
    } catch (err) {
      // RELEASE the claim so a failure does not strand the return — but ONLY
      // when no money can have moved. Once the provider refund has (or may
      // have) executed, keep it: a caller outside a request transaction must
      // not be handed a retryable return. (Inside one, the 5xx this becomes
      // rolls the claim back regardless, and PaymentService's committed refund
      // key is what refuses the retry.)
      if (providerRefundExecuted) {
        logger.error(
          { storeId, returnId },
          '[ReturnService] completion failed AFTER the provider refund executed — claim not released so a retry cannot refund twice; reconcile manually'
        );
        throw err;
      }
      // Scoped to the un-completed statuses, so it is also a no-op once the
      // completion write above has flipped the row to 'completed' — a throw
      // from the side-effects AFTER that point must not un-claim a return
      // whose money already moved. Swallowing the release error is deliberate:
      // the original failure is the one worth surfacing.
      await prisma.return
        .updateMany({
          where: { id: returnId, storeId, status: { in: ['received', 'inspecting'] } },
          data: { refundedAt: null },
        })
        .catch(releaseErr =>
          logger.error(
            { releaseErr, storeId, returnId },
            '[ReturnService] failed to release the completion claim — return may be stuck'
          )
        );
      throw err;
    }
  }

  /**
   * complete() on a store's Durable Object (Ruling CF-RETURNS-1). Three steps, the money moving only in the middle one:
   *   returnClaim   status + order busy gate + the atomic claim + the plan        (one DO section)
   *   provider      PaymentService.refund (itself DO-aware)                        (outside any section)
   *   returnFinish  the completion row, tier items, STORE CREDIT / wallet share and stock effects (ONE DO section)
   * The wallet credit is never issued apart from the completion row: they commit together or not at all, and a retry of a
   * request whose Postgres transaction rolled back replays (`replayed: true`, wallet keyed on the return id), so it can
   * not credit twice (security review: wallet credit inside an open Postgres transaction).
   */
  private static async completeOnDo(
    money: MoneyClient,
    storeId: string,
    returnId: string,
    userId: string,
    refundMethod: string,
    refundOverrides: RefundOverrides
  ) {
    const walletFeature =
      refundMethod === 'store_credit' &&
      (await featureService.isFeatureEnabled(storeId, 'customer_wallet'));
    const claimArgs = { returnId, refundMethod, refundOverrides, walletFeature };
    const plan = await money.returnClaim(claimArgs);
    let providerRefundExecuted = false;
    try {
      let gatewayRanFullEffects = false;
      let gatewayAmount: number | undefined;
      if (plan.isGatewayRefund && plan.orderId && !plan.skipProvider) {
        const gw = await this.planGatewayRefund(
          storeId,
          returnId,
          plan.orderId,
          plan.isFullReturn,
          plan.partial,
          plan.outstandingClaims
        );
        gatewayAmount = plan.partial ? undefined : gw.amount;
        try {
          const result = await PaymentService.refund(
            {
              transactionId: gw.transactionId,
              reason: 'Customer return',
              amount: gw.amount,
              refundKey: `return:${returnId}`,
              itemLevel: plan.partial !== null && !plan.partial.allLinesNowReturned,
            },
            undefined,
            storeId
          );
          providerRefundExecuted = true;
          gatewayRanFullEffects = result.wholeOrderEffectsApplied === true;
        } catch (err) {
          providerRefundExecuted = refundMayHaveExecuted(err);
          logger.error(
            { err, storeId, returnId, providerRefundExecuted },
            providerRefundExecuted
              ? '[ReturnService] Gateway refund FAILED AFTER the money may have moved — return NOT marked completed, reconcile manually'
              : '[ReturnService] Gateway refund failed — return NOT marked completed'
          );
          if (providerRefundExecuted)
            throw new AppError(
              502,
              'PROVIDER_REFUND_INDETERMINATE',
              'The refund reached the payment provider but this return could not be completed. Do NOT refund it again: check the provider dashboard, then complete this return with "Already refunded — record only" so it is recorded without a second refund.'
            );
          if (err instanceof AppError && err.statusCode < 500) throw err;
          throw new AppError(
            502,
            'PROVIDER_REFUND_FAILED',
            'Payment provider refund failed. Please retry or switch refund method.'
          );
        }
      }
      const done = await money.returnFinish(
        { ...claimArgs, userId, gatewayAmount, gatewayRanFullEffects },
        `return-finish:${returnId}`
      );
      if (plan.isInventoryRestoring && plan.orderId && !gatewayRanFullEffects) {
        if (plan.isFullReturn) {
          await OrderService.applyRefundEffects(storeId, plan.orderId);
        } else {
          await OrderService.applyRefundEffects(storeId, plan.orderId, {
            partial: {
              items: plan.items,
              refundKey: returnId,
              refundAmount: done.refundAmount,
            },
          });
        }
      }
      const row = await (
        await storeDb(storeId)
      ).return.findFirst({
        where: { id: returnId, storeId },
      });
      return { ...row!, tierCarryWaived: done.tierCarryWaived };
    } catch (err) {
      if (providerRefundExecuted) {
        logger.error(
          { storeId, returnId },
          '[ReturnService] completion failed AFTER the provider refund executed — claim not released so a retry cannot refund twice; reconcile manually'
        );
        throw err;
      }
      await money
        .returnRelease({ returnId })
        .catch(releaseErr =>
          logger.error(
            { releaseErr, storeId, returnId },
            '[ReturnService] failed to release the completion claim — return may be stuck'
          )
        );
      throw err;
    }
  }

  /**
   * What completing this return would refund, per method — for the admin's
   * confirmation step (#1485, #1474), so the merchant sees the amount and
   * whether the original payment method can take it BEFORE anything moves.
   *
   * Read-only, and computed by the same helpers `complete()` uses, so the
   * figure shown is the figure sent. It can still change if another return or
   * refund on the order lands before the merchant confirms; `complete()`
   * recomputes under the order lock and refuses rather than overshooting.
   */
  static async refundPreview(
    storeId: string,
    returnId: string,
    /** Optional: preview a merchant override before confirming it. */
    refundOverrides: RefundOverrides = {}
  ) {
    const returnRequest = await this.getById(storeId, returnId);
    const isInventoryRestoring = returnRequest.type === 'return' || returnRequest.type === 'refund';

    let isFullReturn = false;
    let orderLines: AllocationLine[] = [];
    if (returnRequest.orderId) {
      orderLines = await (
        await storeDb(storeId)
      ).orderItem.findMany({
        where: { orderId: returnRequest.orderId },
        select: { id: true, quantity: true, price: true, priceSource: true },
      });
      const returnedQty = new Map<string, number>();
      for (const it of returnRequest.items) {
        returnedQty.set(it.orderItemId, (returnedQty.get(it.orderItemId) ?? 0) + it.quantity);
      }
      isFullReturn =
        orderLines.length > 0 &&
        orderLines.every(oi => (returnedQty.get(oi.id) ?? 0) >= oi.quantity);
    }

    let partial: PartialAllocation | null = null;
    // B2B Task 8b: the same helper complete() uses, so the figure shown is the figure sent.
    let tierAdj: { lines: ReturnLineAdjustment[]; total: number } = { lines: [], total: 0 };
    if (isInventoryRestoring && returnRequest.orderId && !isFullReturn) {
      tierAdj = await this.computeLineAdjustments(
        storeId,
        returnId,
        returnRequest.orderId,
        returnRequest.items.map(i => ({
          id: i.id,
          orderItemId: i.orderItemId,
          quantity: i.quantity,
          productName: i.productName,
        })),
        refundOverrides
      );
      partial = await this.allocateThisReturn(
        storeId,
        returnId,
        returnRequest.orderId,
        orderLines,
        returnRequest.items,
        tierAdj.total
      );
    }

    // What a non-gateway completion records: the net allocation for a partial
    // return, the existing figure for a full one (see complete()).
    const recordedAmount = partial ? partial.cashCredit : returnRequest.refundAmount;

    // With the customer wallet on, `store_credit` is real money into the
    // customer's wallet, and for a FULL return it is NOT `recordedAmount`
    // (shipping is added, the wallet-paid part is left to the order/refunded
    // fanout). Computed by the same helper complete() credits with, so the
    // merchant confirms the figure the wallet actually receives. Null = the
    // wallet is off (or the return cannot credit it) and store credit keeps
    // its off-platform meaning.
    const storeCreditToWallet =
      isInventoryRestoring &&
      returnRequest.orderId &&
      (await featureService.isFeatureEnabled(storeId, 'customer_wallet'))
        ? await this.computeStoreCreditAmount(
            storeId,
            returnId,
            returnRequest.orderId,
            orderLines,
            returnRequest.items,
            isFullReturn,
            tierAdj.total
          )
        : null;

    let gateway: {
      available: boolean;
      amount: number | null;
      /**
       * Part of the refund that goes back to the customer wallet instead of
       * the gateway, because the order was partly paid from it (#1956).
       * `amount` is then only the gateway's part. 0 for every other order.
       */
      walletShare: number;
      refundableRemaining: number | null;
      unavailableReason: string | null;
      /**
       * The customer already has money back on the original method — so
       * "Already refunded — record only" is an honest completion. Decided here,
       * not by string-matching reason codes in the client (issue 2003).
       */
      alreadyPaidToCustomer: boolean;
    } = {
      available: false,
      amount: null,
      walletShare: 0,
      refundableRemaining: null,
      unavailableReason: null,
      alreadyPaidToCustomer: false,
    };
    if (!isInventoryRestoring) {
      gateway.unavailableReason = 'EXCHANGE_CANNOT_REFUND_TO_GATEWAY';
    } else if (!returnRequest.orderId) {
      gateway.unavailableReason = 'NO_COMPLETED_PAYMENT';
    } else if (partial && partial.returnedLineCount === 0) {
      gateway.unavailableReason = 'PARTIAL_REFUND_NOTHING_TO_REFUND';
    } else if (partial && partial.gatewayShare === 0) {
      // All of it is the wallet's share — complete() sends nothing to the
      // provider and puts the whole allocation back in the wallet.
      gateway = {
        available: true,
        amount: 0,
        walletShare: partial.walletShare,
        refundableRemaining: null,
        unavailableReason: null,
        alreadyPaidToCustomer: false,
      };
    } else {
      try {
        const plan = await this.planGatewayRefund(
          storeId,
          returnId,
          returnRequest.orderId,
          isFullReturn,
          partial
        );
        gateway = {
          available: true,
          // Absent means "the whole remaining payment" to PaymentService.
          amount: plan.amount ?? plan.refundableRemaining,
          walletShare: partial?.walletShare ?? 0,
          refundableRemaining: plan.refundableRemaining,
          unavailableReason: null,
          alreadyPaidToCustomer: false,
        };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        gateway.unavailableReason = err.code;
        // REFUND_ALREADY_ISSUED: this return's refund went out. PAYMENT_FULLY_
        // REFUNDED: the whole payment went back by a path with no refundKey (the
        // order page's refund-via-provider, or the provider's own dashboard).
        // PARTIAL_REFUND_EXCEEDS_PAYMENT stays out: part of the money is still
        // owed, and its copy directs the merchant to store credit.
        gateway.alreadyPaidToCustomer = ALREADY_PAID_TO_CUSTOMER.has(err.code);
      }
    }

    return {
      returnId,
      status: returnRequest.status,
      type: returnRequest.type,
      isFullReturn,
      recordedAmount,
      storeCreditToWallet,
      gateway,
      /** Per item: standard refund, the tier adjustment with its reason, the adjusted refund (empty unless a line is tier-priced). */
      lines: tierAdj.lines,
      tierAdjustmentTotal: tierAdj.total,
    };
  }

  /**
   * B2B Task 8b: per return item, what a partial return of tier-priced units costs the buyer. Reads ONLY the snapshots on
   * the order lines (paid price, list price, source, threshold, entitlement ladder) and the quantities already taken back:
   * it never re-resolves a price. Judged per PRODUCT across every loose line of it, the way the tier was awarded (Ruling
   * B2B-17), at the buyer's full sale-time entitlement (B2B-18). A merchant override (0..standardRefund, with a reason)
   * replaces the computed refund for that item (B2B-15).
   *
   * `returnId` null = the return does not exist yet (the shopper's estimate at creation): nothing to exclude.
   */
  static async computeLineAdjustments(
    storeId: string,
    returnId: string | null,
    orderId: string,
    items: Array<{ id: string; orderItemId: string; quantity: number; productName: string }>,
    overrides: RefundOverrides = {}
  ): Promise<{ lines: ReturnLineAdjustment[]; total: number }> {
    const db = await storeDb(storeId);
    const [orderItems, { prevQty }, retainedRows] = await Promise.all([
      db.orderItem.findMany({ where: { orderId }, select: ADJUSTMENT_LINE_SELECT }),
      loadPriorReversedQty(db as never, { storeId, orderId, excludeKey: returnId ?? undefined }),
      // What earlier COMPLETED returns actually retained (floor and overrides included): a later release can never hand back
      // more than was kept, or the sum of refunds could exceed what the buyer paid for those units.
      db.returnItem.findMany({
        where: {
          return: {
            storeId,
            orderId,
            status: 'completed',
            ...(returnId ? { id: { not: returnId } } : {}),
          },
        },
        select: { orderItemId: true, tierAdjustment: true, tierCarry: true },
      }),
    ]);
    return ReturnService.lineAdjustmentsFrom(orderItems, prevQty, retainedRows, items, overrides);
  }

  /** The pure half of computeLineAdjustments (exported for the unit suite). */
  static lineAdjustmentsFrom(
    orderItems: readonly AdjustmentLine[],
    prevQty: ReadonlyMap<string, number>,
    retainedRows: ReadonlyArray<{ orderItemId: string; tierAdjustment: number; tierCarry: number }>,
    items: Array<{ id: string; orderItemId: string; quantity: number; productName: string }>,
    overrides: RefundOverrides = {}
  ): { lines: ReturnLineAdjustment[]; total: number } {
    for (const key of Object.keys(overrides)) {
      if (!items.some(i => i.id === key)) {
        throw new AppError(
          400,
          'OVERRIDE_UNKNOWN_ITEM',
          'A refund override names an item that is not on this return.'
        );
      }
    }
    const lineById = new Map(orderItems.map(o => [o.id, o]));
    // Tier quantity is summed over LOOSE lines only (Ruling B2B-8b): a bundle component never counts and is never repriced.
    const scopeOf = (o: AdjustmentLine): string | null =>
      o.bundleGroupId === null ? o.productId : null;

    // Units each item really takes back, clamped to what its line has left (duplicates within one return included).
    const running = new Map(prevQty);
    const returningOf = new Map<string, number>();
    for (const it of items) {
      const oi = lineById.get(it.orderItemId);
      if (!oi) continue;
      const before = Math.min(running.get(oi.id) ?? 0, oi.quantity);
      const returning = Math.max(0, Math.min(it.quantity, oi.quantity - before));
      running.set(oi.id, before + returning);
      returningOf.set(it.id, returning);
    }

    const retainedByProduct = new Map<string, number>();
    // Ruling B2B-20: the shortfall earlier returns carried forward, net of what later ones consumed or an override waived.
    const carriedByProduct = new Map<string, number>();
    for (const r of retainedRows) {
      const oi = lineById.get(r.orderItemId);
      const scope = oi ? scopeOf(oi) : null;
      if (scope !== null) {
        retainedByProduct.set(scope, (retainedByProduct.get(scope) ?? 0) + r.tierAdjustment);
        carriedByProduct.set(scope, (carriedByProduct.get(scope) ?? 0) + r.tierCarry);
      }
    }

    // One product-scope computation per product on this return.
    const perItem = new Map<
      string,
      {
        adjustment: number;
        keptUnitMinor: number;
        keptQty: number;
        shortfall: number;
        carriedIn: number;
        carryDelta: number;
        carryWaived: number;
      }
    >();
    const products = new Set<string>();
    for (const it of items) {
      const oi = lineById.get(it.orderItemId);
      const scope = oi ? scopeOf(oi) : null;
      if (scope !== null && returningOf.has(it.id)) products.add(scope);
    }
    for (const productId of products) {
      const scopeLines = orderItems.filter(o => scopeOf(o) === productId);
      const scopeItems = items.filter(
        it => returningOf.has(it.id) && lineById.get(it.orderItemId)?.productId === productId
      );
      const res = productReturnAdjustment(
        scopeLines.map(
          (o): ReturnLineInput => ({
            key: o.id,
            variantId: o.variantId,
            quantity: o.quantity,
            paidUnitMinor: o.price,
            listMinor: o.listPrice,
            priceSource: (o.priceSource as ReturnLineInput['priceSource']) ?? null,
            tierMinQty: o.priceTierMinQty,
            ladder: ladderOf(o.tierLadder),
            returnedBefore: Math.min(prevQty.get(o.id) ?? 0, o.quantity),
            returning: scopeItems
              .filter(it => it.orderItemId === o.id)
              .reduce((n, it) => n + returningOf.get(it.id)!, 0),
          })
        ),
        scopeItems
          .filter(it => lineById.get(it.orderItemId)!.bundleGroupId === null)
          .map(it => ({ key: it.id, lineKey: it.orderItemId, returning: returningOf.get(it.id)! })),
        retainedByProduct.get(productId) ?? 0,
        Math.max(0, carriedByProduct.get(productId) ?? 0)
      );
      // An override on any of this product's items replaces the computed refund, the carry included: the carry is
      // WAIVED, never re-claimed by a later return (Rulings B2B-15, B2B-20).
      const waived = scopeItems.some(it => overrides[it.id] !== undefined);
      const carryOut = waived ? 0 : res.shortfall;
      res.items.forEach((r, i) =>
        perItem.set(r.key, {
          adjustment: r.adjustment,
          keptUnitMinor: r.keptUnitMinor,
          keptQty: res.keptQty,
          // Reported and persisted once per product (on its first item), so a sum over the items never doubles it.
          shortfall: i === 0 ? carryOut : 0,
          carriedIn: i === 0 ? res.carriedIn : 0,
          carryDelta: i === 0 ? carryOut - res.carriedIn : 0,
          carryWaived: i === 0 && waived ? res.shortfall : 0,
        })
      );
    }

    const lines: ReturnLineAdjustment[] = [];
    let total = 0;
    for (const it of items) {
      const oi = lineById.get(it.orderItemId);
      if (!oi || !returningOf.has(it.id)) continue;
      const returning = returningOf.get(it.id)!;
      const standardRefund = oi.price * returning;
      const computed = perItem.get(it.id) ?? {
        adjustment: 0,
        keptUnitMinor: oi.price,
        keptQty: oi.quantity - (running.get(oi.id) ?? 0),
        shortfall: 0,
        carriedIn: 0,
        carryDelta: 0,
        carryWaived: 0,
      };
      let adjustment = computed.adjustment;
      let overridden = false;
      let overrideReason: string | null = null;
      const ov = overrides[it.id];
      if (ov) {
        if (
          !Number.isInteger(ov.amountMinor) ||
          ov.amountMinor < 0 ||
          ov.amountMinor > standardRefund
        ) {
          throw new AppError(
            400,
            'OVERRIDE_OUT_OF_RANGE',
            'A refund override must be between 0 and the standard refund for that item.'
          );
        }
        adjustment = standardRefund - ov.amountMinor;
        overridden = true;
        overrideReason = ov.reason;
      }
      total += adjustment;
      lines.push({
        returnItemId: it.id,
        orderItemId: oi.id,
        productName: it.productName,
        quantity: returning,
        keptQty: computed.keptQty,
        tierMinQty: oi.priceSource === 'tier' ? oi.priceTierMinQty : null,
        standardRefund,
        adjustment,
        adjustedRefund: standardRefund - adjustment,
        shortfall: computed.shortfall,
        carriedIn: computed.carriedIn,
        carryDelta: computed.carryDelta,
        carryWaived: computed.carryWaived,
        keptUnitMinor: computed.keptUnitMinor,
        // From the APPLIED adjustment (review minor 3): a release clamped to nothing is not reported as "released".
        reason: adjustment > 0 ? 'kept_below_tier' : adjustment < 0 ? 'released' : 'none',
        overridden,
        overrideReason,
      });
    }
    return { lines, total };
  }

  /**
   * This return's share of the order's money, net of prior completed returns —
   * the same allocation partial-return-posting books (see
   * partial-return-allocation.ts for why the two must be one function).
   */
  private static async allocateThisReturn(
    storeId: string,
    returnId: string,
    orderId: string,
    orderLines: AllocationLine[],
    items: Array<{ orderItemId: string; quantity: number }>,
    /** B2B Task 8b: signed piastres this return's tier adjustment (0 for every non-B2B line). */
    thisAdjustment = 0
  ): Promise<PartialAllocation> {
    // Prior completed returns AND single-line backorder cancellations — the
    // same reader the GL posting uses, so the two cannot disagree.
    const db = await storeDb(storeId);
    const { prevQty, prevAdjustment } = await loadPriorReversedQty(db as never, {
      storeId,
      orderId,
      excludeKey: returnId,
    });
    const order = await db.order.findFirst({
      where: { id: orderId, storeId },
      select: {
        subtotal: true,
        discount: true,
        tax: true,
        taxIncludedInPrice: true,
        total: true,
        walletAmount: true,
      },
    });
    const alloc = allocatePartialReturn({
      subtotal: order?.subtotal ?? 0,
      discount: order?.discount ?? 0,
      tax: order?.tax ?? 0,
      taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
      lines: orderLines,
      prevQty,
      requested: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      prevAdjustment,
      thisAdjustment,
    });
    const thisQty = new Map<string, number>();
    for (const { line, qty } of alloc.returnedLines) {
      thisQty.set(line.id, (thisQty.get(line.id) ?? 0) + qty);
    }
    // Split by the order's payment mix (#1956), cumulatively over the order's
    // earlier item-level reversals — their cash value is the same allocation
    // taken over the prior quantities as one block (the allocator telescopes).
    let split = { walletShare: 0, gatewayShare: alloc.cashCredit };
    if ((order?.walletAmount ?? 0) > 0) {
      const prior = allocatePartialReturn({
        subtotal: order?.subtotal ?? 0,
        discount: order?.discount ?? 0,
        tax: order?.tax ?? 0,
        taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
        lines: orderLines,
        prevQty: new Map(),
        requested: [...prevQty].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
        thisAdjustment: prevAdjustment,
      });
      split = splitByPaymentMix({
        cashCredit: alloc.cashCredit,
        prevCash: prior.cashCredit,
        total: order?.total ?? 0,
        walletAmount: order?.walletAmount ?? 0,
      });
    }
    return {
      ...split,
      cashCredit: alloc.cashCredit,
      returnedLineCount: alloc.returnedLines.length,
      // After this return, is nothing left with the customer? Counted in LINES,
      // never inferred from money: the payment's balance also moves for refunds
      // that have no Return row (#1402).
      allLinesNowReturned: orderLines.every(
        l => (prevQty.get(l.id) ?? 0) + (thisQty.get(l.id) ?? 0) >= l.quantity
      ),
    };
  }

  /**
   * A refund for this return already went to the provider — its completion
   * then failed and rolled back, leaving the return 'received' while the money
   * stands. Sending it again pays the customer twice; recording it is what is
   * left to do. PaymentService refuses the same key again under the payment
   * lock; this names it before any other check can give a misleading reason.
   */
  private static async refuseIfRefundAlreadyIssued(
    storeId: string,
    paymentId: string,
    returnId: string,
    doOutstanding?: string[]
  ) {
    // a DO store's claims live in its own payment_events: the claim section (`returnClaim`) read them
    const outstanding =
      doOutstanding ??
      (await findOutstandingRefundClaims(paymentId, `return:${returnId}`, storeId));
    if (outstanding.length > 0) {
      throw new AppError(
        409,
        'REFUND_ALREADY_ISSUED',
        'A refund for this return was already sent to the payment provider. Check the provider dashboard, then complete this return with "Already refunded — record only" so it is recorded without refunding again.'
      );
    }
  }

  /**
   * Which payment a gateway refund for this return goes against, and how much
   * to send. Throws the merchant-facing reason when the gateway cannot take it.
   */
  private static async planGatewayRefund(
    storeId: string,
    returnId: string,
    orderId: string,
    isFullReturn: boolean,
    partial: PartialAllocation | null,
    doOutstanding?: string[]
  ): Promise<{
    paymentId: string;
    transactionId: string;
    /** Undefined = the whole payment (a full return on a never-refunded payment). */
    amount: number | undefined;
    refundableRemaining: number;
  }> {
    // NOT `status: 'completed'` alone. PaymentService.refund atomically
    // claims the payment as 'partially_refunded' on the FIRST partial refund
    // and commits that before returning — the same transition
    // partial-return-posting documents. A 'completed'-only filter therefore
    // matches nothing on the SECOND partial return of an order (the exact
    // sequence the telescoping allocator exists for) and on any full return
    // following a partial, so both died on a 400 and could never be
    // completed through the gateway. A fully 'refunded' payment stays
    // excluded — there is nothing left on it to send back.
    const db = await storeDb(storeId);
    const payment = await db.payment.findFirst({
      where: {
        orderId,
        status: { in: ['completed', 'partially_refunded'] },
        // A gateway refund needs a provider transaction to refund AGAINST.
        // COD payments reach 'completed' with a NULL transactionId — they
        // are created without one and the mark-COD-paid route never sets
        // one — and passing that through made PaymentService's lookup an
        // empty WHERE, which selects an arbitrary payment and refunds a
        // completely unrelated order. Filter them out here so the error
        // below names the real problem instead.
        transactionId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      // Say which: an online payment with nothing left on it is not a COD
      // order, and telling the merchant it is sends them looking for the
      // wrong problem.
      const spent = await db.payment.findFirst({
        where: { orderId, status: 'refunded', transactionId: { not: null } },
        select: { id: true },
      });
      if (spent) {
        await this.refuseIfRefundAlreadyIssued(storeId, spent.id, returnId, doOutstanding);
        throw new AppError(
          409,
          'PAYMENT_FULLY_REFUNDED',
          'Cannot trigger gateway refund: this payment has already been refunded in full.'
        );
      }
      throw new AppError(
        400,
        'NO_COMPLETED_PAYMENT',
        'Cannot trigger gateway refund: no refundable payment on this order. A cash-on-delivery order has no provider transaction — use a manual refund method.'
      );
    }
    // Unreachable given the filter above, and deliberately an explicit
    // check rather than a non-null assertion. The `!` that used to stand
    // here asserted something the schema does not guarantee
    // (transactionId is String?), which is exactly how a null reached
    // PaymentService and turned its lookup into an empty WHERE.
    if (!payment.transactionId) {
      throw new AppError(
        400,
        'PAYMENT_NOT_REFUNDABLE',
        'This payment has no provider transaction and cannot be refunded at the gateway.'
      );
    }
    // Before any amount check: if THIS return already sent a refund, every
    // other reason to refuse is a distraction — the balance is short because
    // of that very refund.
    await this.refuseIfRefundAlreadyIssued(storeId, payment.id, returnId, doOutstanding);
    // Everything below budgets against what is LEFT on the payment, not its
    // original amount — a prior partial refund already sent part of it back.
    const alreadyRefunded = payment.refundedAmount ?? 0;
    const refundableRemaining = payment.amount - alreadyRefunded;
    if (refundableRemaining <= 0) {
      throw new AppError(
        409,
        'PAYMENT_FULLY_REFUNDED',
        'Cannot trigger gateway refund: this payment has already been refunded in full.'
      );
    }
    // `Return.refundAmount` is NOT a money instruction. It is auto-computed
    // at creation as the gross line value — sum(price x qty), with no
    // order-level discount or tax applied (see create(), above). Refunding it
    // hands the customer the pre-discount price while the journal credits the
    // discounted one: on the integration fixture (subtotal 9000, discount
    // 1000, tax 900, returning one 2000-piastre line) that is 2000 out the door
    // against 1978 booked, and the gap widens with the discount.
    //
    // So the amount is DERIVED for a partial return, from the same allocator
    // partial-return-posting books, and left ABSENT for a full one on a
    // never-refunded payment. Absent is what PaymentService reads as "the
    // whole payment", which also avoids the gross-vs-total mismatch on that
    // branch: refundAmount excludes tax and shipping, so a genuinely full
    // return could otherwise fail the `>= payment.amount` test and be
    // mistaken for a partial one.
    //
    // A full return AFTER a prior partial refund must NOT be absent, though:
    // absent means the WHOLE original payment.amount at the provider, so the
    // already-refunded portion would go out a second time. Send the remaining
    // balance explicitly instead — PaymentService still reads that as a full
    // refund (it compares against the remaining, not the original, amount),
    // so the whole-order fanout it owns still fires exactly once.
    if (!isFullReturn && partial) {
      // Only the gateway's share goes to the provider; on an order paid partly
      // from the customer wallet the rest goes back to the wallet (#1956).
      const toGateway = partial.gatewayShare;
      if (partial.cashCredit <= 0) {
        throw new AppError(
          400,
          'PARTIAL_REFUND_NOTHING_TO_REFUND',
          'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.'
        );
      }
      if (toGateway > refundableRemaining) {
        // STRICTLY greater. Equality is not a contradiction, it is the normal
        // final piece: the allocator telescopes, so every return's cashCredit
        // over an order sums to exactly the goods the customer paid for
        // (subtotal - discount + tax, or just subtotal - discount when the tax
        // was already inside the listed prices), while payment.amount is that
        // plus shipping — the relation holds under either tax convention
        // (ruling M3-7). Before the last piece,
        // refundableRemaining is therefore shipping + cashCredit_final, and
        // `>=` reduces to rejecting whenever shipping <= 0. Order.shipping
        // defaults to 0 and free delivery / store pickup is the norm for
        // Egypt merchants, so `>=` hard-blocked the second half of every
        // two-line piecewise return. Only refunding MORE than is left is the
        // real error.
        //
        // It happens when something else already took money off this payment —
        // a refund from the order page or the provider's dashboard has no
        // Return row, so the allocator cannot see it. Say so, and name the way
        // out (#1403): the merchant cannot edit the amount, and a one-line
        // return can never be completed as a full one.
        throw new AppError(
          409,
          'PARTIAL_REFUND_EXCEEDS_PAYMENT',
          `This return is worth ${formatMajor(toGateway)} EGP at the gateway but only ${formatMajor(refundableRemaining)} EGP is left on the payment, because part of it was already refunded outside this return. Complete it with store credit or bank transfer instead, and settle the difference with the customer directly.`,
          { refundAmount: toGateway, refundableRemaining }
        );
      }
      return {
        paymentId: payment.id,
        transactionId: payment.transactionId,
        amount: toGateway,
        refundableRemaining,
      };
    }
    // Full return, but an earlier partial already sent money back: refund the
    // balance explicitly rather than leaving the amount absent (see above).
    return {
      paymentId: payment.id,
      transactionId: payment.transactionId,
      amount: alreadyRefunded > 0 ? refundableRemaining : undefined,
      refundableRemaining,
    };
  }

  /**
   * How much store credit a completed return puts in the customer's wallet.
   *
   * The SAME allocation the gateway branch refunds and the GL books
   * (`allocatePartialReturn`, prior completed returns subtracted), so the
   * wallet, the card and the journal can never quote three different numbers
   * for one return:
   *
   *   - partial return → `cashCredit` (goods net of the discount share, plus
   *     the tax share). Shipping is not refunded on a partial, as on the
   *     gateway path.
   *   - full return → `cashCredit + shipping − order.walletAmount`, floored at
   *     0. The whole-order `order/refunded` fanout separately puts the part of
   *     the order that was PAID from the wallet back (`reverse-wallet-payment`),
   *     so subtracting it here is what makes the customer end up with exactly
   *     what the order cost, once.
   */
  private static async computeStoreCreditAmount(
    storeId: string,
    returnId: string,
    orderId: string,
    orderLines: AllocationLine[],
    items: Array<{ orderItemId: string; quantity: number }>,
    isFullReturn: boolean,
    thisAdjustment = 0
  ): Promise<number> {
    const db = await storeDb(storeId);
    const [{ prevQty, prevAdjustment }, order] = await Promise.all([
      loadPriorReversedQty(db as never, { storeId, orderId, excludeKey: returnId }),
      db.order.findFirst({
        where: { id: orderId, storeId },
        select: {
          subtotal: true,
          discount: true,
          tax: true,
          taxIncludedInPrice: true,
          shipping: true,
          walletAmount: true,
        },
      }),
    ]);
    const alloc = allocatePartialReturn({
      subtotal: order?.subtotal ?? 0,
      discount: order?.discount ?? 0,
      tax: order?.tax ?? 0,
      taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
      lines: orderLines,
      prevQty,
      requested: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      prevAdjustment,
      thisAdjustment,
    });
    if (!isFullReturn) return alloc.cashCredit;
    return Math.max(0, alloc.cashCredit + (order?.shipping ?? 0) - (order?.walletAmount ?? 0));
  }

  /**
   * Update tracking number
   */
  static async updateTracking(storeId: string, returnId: string, trackingNumber: string) {
    await this.getById(storeId, returnId);

    const money = await storeMoney(storeId);
    if (money) {
      await money.returnTracking({ returnId, trackingNumber });
      return (await (
        await storeDb(storeId)
      ).return.findFirst({
        where: { id: returnId, storeId },
      }))!;
    }
    return prisma.return.update({
      where: { id: returnId, storeId },
      data: { trackingNumber },
    });
  }

  /**
   * Get customer returns
   */
  static async getCustomerReturns(
    storeId: string,
    customerId: string,
    options: ListReturnsOptions = {}
  ) {
    const { page = 1, limit = 20, status } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ReturnWhereInput = { storeId, customerId };

    if (status) {
      where.status = status as ReturnStatus;
    }

    const db = await storeDb(storeId);
    const [returns, total] = await Promise.all([
      db.return.findMany({
        where,
        skip,
        take: limit,
        include: {
          order: {
            select: { orderNumber: true },
          },
          items: {
            include: {
              product: {
                select: {
                  name: true,
                  images: { take: 1, orderBy: { position: 'asc' } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.return.count({ where }),
    ]);

    return {
      returns,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get return statistics for a store
   */
  static async getStats(storeId: string) {
    const db = await storeDb(storeId);
    const [total, pending, approved, completed, byReason] = await Promise.all([
      db.return.count({ where: { storeId } }),
      db.return.count({ where: { storeId, status: 'pending' } }),
      db.return.count({ where: { storeId, status: 'approved' } }),
      db.return.count({ where: { storeId, status: 'completed' } }),
      db.return.groupBy({
        by: ['reason'],
        where: { storeId },
        _count: true,
      }),
    ]);

    return {
      total,
      pending,
      approved,
      completed,
      byReason: byReason.map(r => ({
        reason: r.reason,
        count: r._count,
      })),
    };
  }
}
