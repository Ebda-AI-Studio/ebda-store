import {
  PortError,
  type BridgePort,
  type StoreProfile,
  type CatalogRow,
} from '../../../apps/api/src/lib/wa/bridge/service';

export const S = '11111111-1111-4111-8111-111111111111';
export const S_UNLINKED = '22222222-2222-4222-8222-222222222222';
export const S_UNKNOWN = '33333333-3333-4333-8333-333333333333';
export const BK = 'e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd';
export const BK_OTHER = '6ceb45953633dabff779c18ba4035a9fe58480c8383c822f93684a541a5c7cf5';
export const BUYER = {
  buyerKey: BK,
  phoneE164: '+201001234567',
  name: 'Mona Adel',
  locale: 'ar' as const,
};

const profile: StoreProfile = {
  name: 'Dar Mona',
  logoUrl: 'https://cdn.example/logo.png',
  locale: 'ar',
  currency: 'EGP',
  paymentMethods: ['cod', 'link', 'instapay'],
  codEnabled: true,
  instapay: { ipa: 'dar-mona@instapay', displayName: 'Dar Mona' },
};
const row = (id: string, price: number, inStock: boolean): CatalogRow => ({
  retailerId: id,
  productId: `p-${id}`,
  title: `Item ${id}`,
  titleAr: null,
  description: null,
  priceMinor: price,
  currency: 'EGP',
  availability: inStock ? 'in_stock' : 'out_of_stock',
  imageUrl: null,
  link: `https://dar-mona.ebda.app/products/${id}`,
  brand: null,
});
const CATALOG = [row('v1', 25000, true), row('v2', 40000, true), row('v3', 9900, false)];

/** In-memory world with the real replay semantics (an idempotency key replays the first answer; COD transitions are one-way). */
export function makeFakePort() {
  const orders = new Map<
    string,
    {
      orderId: string;
      orderNumber: string;
      totalMinor: number;
      paymentStatus: 'unpaid' | 'paid';
      status: string;
      method: string;
      buyerKey: string;
    }
  >();
  const byKey = new Map<string, string>();
  const outcomes = new Map<string, string>();
  const addresses = new Map<
    string,
    Array<{ id: string; label: string | null; area: string; street: string }>
  >([[BK, [{ id: 'a1', label: 'Home', area: 'Maadi', street: '9 Road 233' }]]]);
  let n = 1000;
  const port: BridgePort = {
    storeProfile: async s => (s === S || s === S_UNLINKED ? profile : null),
    isLinked: async s => s === S,
    catalogPage: async (_s, cursor, limit) => {
      const start = cursor ? CATALOG.findIndex(r => r.retailerId === cursor) + 1 : 0;
      const items = CATALOG.slice(start, start + limit);
      return {
        items,
        nextCursor: start + limit < CATALOG.length ? items[items.length - 1]!.retailerId : null,
      };
    },
    catalogByIds: async (_s, ids) => CATALOG.filter(r => ids.includes(r.retailerId)),
    placeOrder: async (_s, a) => {
      const prior = byKey.get(a.idempotencyKey);
      if (prior) return { ...orders.get(prior)!, currency: 'EGP', replayed: true };
      const bad = a.items
        .filter(i => CATALOG.find(r => r.retailerId === i.variantId)?.availability !== 'in_stock')
        .map(i => i.variantId);
      if (bad.length) throw new PortError('out_of_stock', 'insufficient stock', bad);
      if (a.addressId && !addresses.get(a.buyer.buyerKey)?.some(x => x.id === a.addressId))
        throw new PortError('not_found', 'address');
      const totalMinor =
        a.items.reduce(
          (t, i) => t + CATALOG.find(r => r.retailerId === i.variantId)!.priceMinor * i.quantity,
          0
        ) + (a.paymentMethod === 'cod' ? 2500 : 0);
      const o = {
        orderId: `o-${++n}`,
        orderNumber: `EB-${n}`,
        totalMinor,
        paymentStatus: 'unpaid' as const,
        status: 'pending',
        method: a.paymentMethod,
        buyerKey: a.buyer.buyerKey,
      };
      orders.set(o.orderId, o);
      byKey.set(a.idempotencyKey, o.orderId);
      return { ...o, currency: 'EGP', replayed: false };
    },
    orderPayable: async (_s, id) => {
      const o = orders.get(id);
      return o
        ? {
            orderNumber: o.orderNumber,
            paymentStatus: o.paymentStatus,
            status: o.status,
            method: o.method,
          }
        : null;
    },
    issuePaymentLink: async (_s, id) => ({
      url: `https://pay.example/i/${id}`,
      expiresAt: '2026-11-12T10:00:00.000Z',
    }),
    codOutcome: async (_s, a) => {
      const o = orders.get(a.orderId);
      if (!o) return null;
      if (!outcomes.has(a.idempotencyKey) && o.method === 'cod' && o.status === 'pending') {
        if (a.outcome === 'confirmed') o.status = 'confirmed';
        if (a.outcome === 'refused') o.status = 'cancelled';
      }
      outcomes.set(a.idempotencyKey, a.outcome);
      return { orderNumber: o.orderNumber };
    },
    attachProof: async (_s, id) => orders.get(id)?.method === 'instapay',
    addresses: async (_s, k) => addresses.get(k) ?? [],
    saveAddress: async (_s, k, a) => {
      if (!addresses.has(k)) return null;
      const saved = {
        id: `a${addresses.get(k)!.length + 1}`,
        label: a.label ?? null,
        area: a.area,
        street: a.street,
      };
      addresses.get(k)!.push(saved);
      return saved;
    },
    orderStatus: async (_s, num, k) => {
      const o = [...orders.values()].find(x => x.orderNumber === num && x.buyerKey === k);
      return o
        ? {
            orderNumber: o.orderNumber,
            status: o.status === 'pending' ? 'pending_confirmation' : (o.status as never),
            paymentMethod: o.method as never,
            shipment: null,
          }
        : null;
    },
    customerOrders: async (_s, k) =>
      [...orders.values()]
        .filter(o => o.buyerKey === k)
        .map(o => ({
          orderId: o.orderId,
          orderNumber: o.orderNumber,
          status: 'pending_confirmation' as const,
          totalMinor: o.totalMinor,
          currency: 'EGP',
          paymentMethod: o.method as never,
          itemsCount: 1,
          at: 1_762_800_000_000,
        })),
  };
  return { port, orders };
}
