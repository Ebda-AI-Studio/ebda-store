/**
 * `WhatsAppBridge` commerce RPC: the gate, validation and result mapping (contract section 5, Rulings WA-RPC-1..4).
 *
 * Pure over a `BridgePort`, so the same logic runs against the real DO port and against the fake the contract tests use.
 *  - Every method takes `storeId` first. A malformed id is `invalid`; a store that does not resolve is `not_found` (NEVER a default
 *    store); a store with no Ebda Chat link / entitlement is `not_linked`. All three are checked BEFORE anything else is read.
 *  - Expected failures are DATA (`{ ok: false, reason }`), exactly the shape ebda-whatsapp's `bridgeResultSchema` parses. An
 *    unexpected error is logged and rethrown: the caller turns a throw into `unavailable` and retries, so nothing is lost silently.
 *  - Prices, totals and stock come from the Store only; the caller sends variant ids and quantities, never an amount.
 *  - Writes (`createOrderFromChat`, `recordCodOutcome`) require an idempotency key and are replay-safe in the port.
 */
import { timingSafeEqual } from 'node:crypto';
import type { z } from 'zod/v3';
import { args } from './schemas';
import { buyerKeyFor } from '@ebda/shared';
import { signCheckoutToken, storeBuyerId } from './checkout-token';

export type ChatPaymentMethod = 'cod' | 'link' | 'instapay';
export type BridgeFailure =
  | 'not_found'
  | 'not_linked'
  | 'out_of_stock'
  | 'payment_method_disabled'
  | 'invalid'
  | 'unavailable';
export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BridgeFailure; message?: string; outOfStock?: string[]; code?: string };

export interface StoreProfile {
  name: string;
  logoUrl: string | null;
  locale: 'ar' | 'en';
  currency: string;
  paymentMethods: ChatPaymentMethod[];
  codEnabled: boolean;
  instapay: { ipa: string; displayName: string } | null;
}
export interface CatalogRow {
  retailerId: string;
  productId: string;
  title: string;
  titleAr: string | null;
  description: string | null;
  priceMinor: number;
  currency: string;
  availability: 'in_stock' | 'out_of_stock';
  imageUrl: string | null;
  link: string;
  brand: string | null;
}
export interface Address {
  id: string;
  label: string | null;
  area: string;
  street: string;
}
export type OrderStatus =
  | 'pending_confirmation'
  | 'pending_payment'
  | 'confirmed'
  | 'refused'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'returned';
export interface OrderSummary {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  paymentMethod: 'cod' | 'link' | 'card' | 'wallet' | 'instapay';
  itemsCount: number;
  at: number;
}

/** Thrown by a port for an expected refusal; the service maps it to data. */
export class PortError extends Error {
  constructor(
    readonly reason: BridgeFailure,
    message?: string,
    readonly outOfStock?: string[],
    readonly code?: string
  ) {
    super(message ?? reason);
  }
}

export interface BridgePort {
  /** null = the store does not resolve (deleted, unknown). */
  storeProfile(storeId: string): Promise<StoreProfile | null>;
  isLinked(storeId: string): Promise<boolean>;
  catalogPage(
    storeId: string,
    cursor: string | null,
    limit: number
  ): Promise<{ items: CatalogRow[]; nextCursor: string | null }>;
  catalogByIds(storeId: string, ids: string[]): Promise<CatalogRow[]>;
  /** Replay-safe on `idempotencyKey`. Throws PortError('out_of_stock' | 'invalid' | 'not_found'). */
  placeOrder(
    storeId: string,
    a: {
      items: Array<{ variantId: string; quantity: number }>;
      buyer: { buyerKey: string; phoneE164: string; name: string | null; locale: 'ar' | 'en' };
      addressId?: string;
      address?: { label?: string; area: string; street: string };
      paymentMethod: ChatPaymentMethod;
      idempotencyKey: string;
    }
  ): Promise<{
    orderId: string;
    orderNumber: string;
    totalMinor: number;
    currency: string;
    paymentStatus: 'unpaid' | 'paid';
    replayed: boolean;
  }>;
  /** The order's payment state, or null. */
  orderPayable(
    storeId: string,
    orderId: string
  ): Promise<{
    orderNumber: string;
    paymentStatus: string;
    status: string;
    method: string | null;
  } | null>;
  issuePaymentLink(storeId: string, orderId: string): Promise<{ url: string; expiresAt: string }>;
  /** Replay-safe on `idempotencyKey`; null = unknown order. */
  codOutcome(
    storeId: string,
    a: {
      orderId: string;
      outcome: 'confirmed' | 'refused' | 'no_reply';
      at: string;
      idempotencyKey: string;
    }
  ): Promise<{ orderNumber: string | null } | null>;
  attachProof(storeId: string, orderId: string, mediaUrl: string): Promise<boolean>;
  addresses(storeId: string, buyerKey: string): Promise<Address[]>;
  saveAddress(
    storeId: string,
    buyerKey: string,
    a: { label?: string; area: string; street: string }
  ): Promise<Address | null>;
  orderStatus(
    storeId: string,
    orderNumber: string,
    buyerKey: string
  ): Promise<{
    orderNumber: string;
    status: OrderStatus;
    paymentMethod: OrderSummary['paymentMethod'];
    shipment: { status: string; trackingUrl: string | null } | null;
  } | null>;
  customerOrders(storeId: string, buyerKey: string, limit: number): Promise<OrderSummary[]>;
}

export interface BridgeDeps {
  port: BridgePort;
  /** Public storefront origin for a store (checkout links). */
  storefrontUrl: (storeId: string) => Promise<string>;
  /**
   * The suite buyer-key secret. REQUIRED (no default): a bridge built without it cannot bind a buyer to a phone, so
   * the two methods that take both fail closed instead of trusting the caller (WA-2). Production wires `suiteBuyerKeySecret`.
   */
  buyerKeySecret: () => string;
  now?: () => number;
  log?: (msg: string, ctx: Record<string, unknown>) => void;
}

const fail = (reason: BridgeFailure, message?: string): BridgeResult<never> => ({
  ok: false,
  reason,
  ...(message ? { message } : {}),
});
const GATE_NOTE = 'store not resolved';
const sameKey = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createBridge(deps: BridgeDeps) {
  const { port } = deps;
  const now = deps.now ?? Date.now;

  async function run<A extends z.ZodType, T>(
    method: string,
    storeId: unknown,
    schema: A,
    raw: unknown,
    body: (storeId: string, a: z.infer<A>, profile: StoreProfile) => Promise<BridgeResult<T>>
  ): Promise<BridgeResult<T>> {
    const id = args.storeId.safeParse(storeId);
    if (!id.success) return fail('invalid', 'storeId');
    const a = schema.safeParse(raw);
    if (!a.success)
      return fail(
        'invalid',
        `${method}: ${a.error.issues[0]?.path.join('.') || 'args'}`.slice(0, 120)
      );
    try {
      const profile = await port.storeProfile(id.data);
      if (!profile) return fail('not_found', GATE_NOTE);
      if (!(await port.isLinked(id.data))) return fail('not_linked');
      return await body(id.data, a.data, profile);
    } catch (err) {
      if (err instanceof PortError)
        return {
          ok: false,
          reason: err.reason,
          message: err.message,
          ...(err.outOfStock ? { outOfStock: err.outOfStock } : {}),
          ...(err.code ? { code: err.code } : {}),
        };
      deps.log?.(`wa-bridge ${method} failed`, {
        storeId: String(storeId).slice(0, 36),
        err: (err as Error).message,
      });
      throw err;
    }
  }
  /**
   * WA-2: a buyer is `{ buyerKey, phoneE164 }`, and the key is HMAC(secret, phone). The caller sends both, so the bridge
   * recomputes the key and refuses any pair that does not match: a Worker on the service binding can no longer read or write as
   * a buyer whose phone it does not hold. A throw (secret unset or short) propagates: the call fails, nothing is trusted.
   */
  async function buyerBound(b: { buyerKey: string; phoneE164: string }): Promise<boolean> {
    const want = await buyerKeyFor(deps.buyerKeySecret(), b.phoneE164);
    return want !== null && sameKey(want, b.buyerKey);
  }
  const ok = <T>(value: T): BridgeResult<T> => ({ ok: true, value });

  return {
    getStoreProfile: (storeId: string) =>
      run('getStoreProfile', storeId, args.storeId.optional(), undefined, async (_s, _a, p) =>
        ok(p)
      ),

    listCatalog: (storeId: string, cursor: string | null, limit: number) =>
      run('listCatalog', storeId, args.listCatalog, { cursor, limit }, async (s, a) =>
        ok(await port.catalogPage(s, a.cursor, a.limit))
      ),

    getProducts: (storeId: string, ids: string[]) =>
      run('getProducts', storeId, args.getProducts, { ids }, async (s, a) =>
        ok({ items: await port.catalogByIds(s, a.ids) })
      ),

    createCheckoutLink: (storeId: string, req: unknown) =>
      run('createCheckoutLink', storeId, args.createCheckoutLink, req, async (s, a, p) => {
        if (!(await buyerBound(a.buyer))) return fail('invalid', 'buyer');
        const rows = await port.catalogByIds(
          s,
          a.items.map(i => i.variantId)
        );
        const byId = new Map(rows.map(r => [r.retailerId, r]));
        let total = 0;
        let count = 0;
        const missing: string[] = [];
        for (const it of a.items) {
          const r = byId.get(it.variantId);
          if (!r) return fail('not_found', `variant ${it.variantId}`);
          if (r.availability !== 'in_stock') missing.push(it.variantId);
          total += r.priceMinor * it.quantity;
          count += it.quantity;
        }
        if (missing.length) return { ok: false, reason: 'out_of_stock', outOfStock: missing };
        const token = signCheckoutToken(
          { storeId: s, items: a.items, bk: storeBuyerId(s, a.buyer.buyerKey) },
          now()
        );
        const base = (await deps.storefrontUrl(s)).replace(/\/+$/, '');
        // Summary prices are the items' own prices; shipping, fees and tax are added at checkout. The token carries ids and
        // quantities only: the cart is re-priced by the Store when the link is redeemed.
        return ok({
          checkoutUrl: `${base}/cart/from-wa?t=${encodeURIComponent(token)}`,
          summary: { itemsCount: count, totalMinor: total, currency: p.currency },
        });
      }),

    createOrderFromChat: (storeId: string, req: unknown) =>
      run('createOrderFromChat', storeId, args.createOrderFromChat, req, async (s, a, p) => {
        if (!(await buyerBound(a.buyer))) return fail('invalid', 'buyer');
        if (!p.paymentMethods.includes(a.paymentMethod))
          return fail('payment_method_disabled', a.paymentMethod);
        const placed = await port.placeOrder(s, a);
        let paymentUrl: string | null = null;
        if (a.paymentMethod === 'link' && placed.paymentStatus !== 'paid') {
          // A gateway outage must not lose a placed order: the order exists, the caller can ask for the link again.
          paymentUrl = await port
            .issuePaymentLink(s, placed.orderId)
            .then(l => l.url)
            .catch(() => null);
        }
        const instapay =
          a.paymentMethod === 'instapay' && p.instapay
            ? { ipa: p.instapay.ipa, amountMinor: placed.totalMinor, reference: placed.orderNumber }
            : null;
        if (a.paymentMethod === 'instapay' && !p.instapay)
          return fail('payment_method_disabled', 'instapay');
        return ok({
          orderId: placed.orderId,
          orderNumber: placed.orderNumber,
          totalMinor: placed.totalMinor,
          currency: placed.currency,
          paymentUrl,
          instapay,
        });
      }),

    getPaymentLink: (storeId: string, orderId: string) =>
      run('getPaymentLink', storeId, args.getPaymentLink, { orderId }, async (s, a) => {
        const o = await port.orderPayable(s, a.orderId);
        if (!o) return fail('not_found', 'order');
        // Only an unpaid, still-open order can be paid: never mint a link for a paid, cancelled or refunded one.
        if (o.paymentStatus === 'paid' || o.status === 'cancelled' || o.status === 'refunded')
          return fail('invalid', 'order not payable');
        return ok(await port.issuePaymentLink(s, a.orderId));
      }),

    recordCodOutcome: (storeId: string, req: unknown) =>
      run('recordCodOutcome', storeId, args.recordCodOutcome, req, async (s, a) => {
        const r = await port.codOutcome(s, a);
        return r ? ok({ orderNumber: r.orderNumber }) : fail('not_found', 'order');
      }),

    attachPaymentProof: (storeId: string, orderId: string, mediaUrl: string) =>
      run(
        'attachPaymentProof',
        storeId,
        args.attachPaymentProof,
        { orderId, mediaUrl },
        async (s, a, p) => {
          if (!p.instapay) return fail('payment_method_disabled', 'instapay');
          return (await port.attachProof(s, a.orderId, a.mediaUrl))
            ? ok({})
            : fail('not_found', 'order');
        }
      ),

    getCustomerAddresses: (storeId: string, buyerKey: string) =>
      run('getCustomerAddresses', storeId, args.buyerKey, { buyerKey }, async (s, a) =>
        ok({ items: await port.addresses(s, a.buyerKey) })
      ),

    saveCustomerAddress: (storeId: string, buyerKey: string, address: unknown) =>
      run(
        'saveCustomerAddress',
        storeId,
        args.saveCustomerAddress,
        { buyerKey, address },
        async (s, a) => {
          const saved = await port.saveAddress(s, a.buyerKey, a.address);
          // Find-or-create by buyer key, idempotent (Ruling WA-RPC-4).
          return saved ? ok({ address: saved }) : fail('unavailable', 'address not saved');
        }
      ),

    getOrderStatus: (storeId: string, orderNumber: string, buyerKey: string) =>
      run(
        'getOrderStatus',
        storeId,
        args.getOrderStatus,
        { orderNumber, buyerKey },
        async (s, a) => {
          // Matched on number AND buyer key: a number alone never reveals another buyer's order.
          const o = await port.orderStatus(s, a.orderNumber, a.buyerKey);
          return o ? ok(o) : fail('not_found', 'order');
        }
      ),

    listCustomerOrders: (storeId: string, buyerKey: string, limit: number) =>
      run(
        'listCustomerOrders',
        storeId,
        args.listCustomerOrders,
        { buyerKey, limit },
        async (s, a) => ok({ items: await port.customerOrders(s, a.buyerKey, a.limit) })
      ),
  };
}
export type Bridge = ReturnType<typeof createBridge>;
