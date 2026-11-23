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
/** Obviously synthetic phone for the Chat-context fixture (review M3); its HMAC under the test secret is BK_PROFILE. */
export const PROFILE_PHONE = '+201000000000';
export const BK_PROFILE = '942bf1edc6e21e31560ab5cc61e908efe24a40d1c6f262378e893ad42df6527c';
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
    orderBuyerKey: async (_s, id) =>
      orders.has(id) ? (orders.get(id)!.buyerKey ?? null) : undefined,
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
      if (
        !outcomes.has(a.idempotencyKey) &&
        o.method === 'cod' &&
        (o.status === 'pending' || o.status === 'confirmed')
      ) {
        if (a.outcome === 'confirmed' && o.status === 'pending') o.status = 'confirmed';
        if (a.outcome === 'refused') o.status = 'cancelled';
      }
      outcomes.set(a.idempotencyKey, a.outcome);
      return { orderNumber: o.orderNumber };
    },
    attachProof: async (_s, id) => orders.get(id)?.method === 'instapay',
    searchProducts: async (_s, q, o) => {
      // stands in for the Store hybrid search: meaning, not only words ("gift" finds the bracelet)
      const hit = (r: CatalogRow) =>
        q === 'هدية' ? r.retailerId === 'v2' || r.retailerId === 'v1' : r.title.includes(q);
      // 'dg' stands in for a query whose meaning leg was skipped (budget / searcher limit / outage): nothing found, but not a real negative
      if (q === 'dg') return { items: [], degraded: true };
      return {
        items: CATALOG.filter(hit)
          .filter(r => o.maxPriceMinor === undefined || r.priceMinor <= o.maxPriceMinor)
          .slice(0, o.limit),
        degraded: false,
      };
    },
    storePolicies: async () => ({
      nameAr: 'دار منى',
      shipping: {
        zones: [
          {
            name: 'Cairo',
            nameAr: 'القاهرة',
            areas: ['Maadi', 'Nasr City'],
            feeMinor: 6000,
            freeOverMinor: 100000,
            etaDaysMin: 1,
            etaDaysMax: 2,
          },
        ],
        governorates: [
          {
            governorate: 'Giza',
            governorateAr: 'الجيزة',
            feeMinor: 6000,
            feeMaxMinor: 8000,
            freeOverMinor: null,
          },
        ],
      },
      returns: { windowDays: 14, feesPaidBy: 'customer' as const },
      cod: { fixedFeeMinor: 2500, percentBps: null },
      hours: 'Sat-Thu 10am-10pm',
      location: { address: '9 Road 233, Maadi', addressAr: null, mapsUrl: null },
    }),
    customerProfile: async (_s, k) =>
      k === BK || k === BK_PROFILE
        ? {
            firstName: 'Mona',
            preferredLocale: 'ar' as const,
            defaultAddress: {
              id: 'a1',
              label: 'Home',
              area: 'Maadi',
              street: '9 Road 233',
              governorate: 'Cairo',
              buildingNumber: '4',
              notes: null,
            },
            recentOrders: [
              {
                orderNumber: 'EB-900',
                status: 'delivered' as const,
                totalMinor: 25000,
                currency: 'EGP',
                at: 1_762_000_000_000,
                items: [{ name: 'Item v1', quantity: 1 }],
              },
            ],
          }
        : null,
    addresses: async (_s, k) => addresses.get(k) ?? [],
    saveAddress: async (_s, k, a) => {
      if (!addresses.has(k)) addresses.set(k, []);
      const list = addresses.get(k)!;
      const same = list.find(
        x => x.area === a.area && x.street === a.street && x.label === (a.label ?? null)
      );
      if (same) return same;
      const saved = {
        id: `a${list.length + 1}`,
        label: a.label ?? null,
        area: a.area,
        street: a.street,
      };
      list.push(saved);
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
    orderSeedIds: async (_s, num, k) =>
      [...orders.values()].some(o => o.orderNumber === num && o.buyerKey === k) ? ['v1'] : null,
    recommend: async (_s, a) =>
      CATALOG.filter(
        r =>
          r.availability === 'in_stock' &&
          !a.seedIds.includes(r.retailerId) &&
          (a.maxPriceMinor === undefined || r.priceMinor <= a.maxPriceMinor)
      ).slice(0, a.limit),
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
