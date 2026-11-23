/**
 * The real `BridgePort`: StoreDO / D1 through the repo layer (no Postgres). Every read and write is scoped by the `storeId` the
 * service already resolved and gated; no query runs without it. Money (prices, totals, stock, COD fee) is the checkout engine's
 * (`money.createOrder`), exactly the path the storefront uses; this file only translates chat shapes into it.
 */
import { storefrontOrigin, catalogueItemId } from '@ebda/shared';
import { visibleProductWhere } from '../../visible-product';
import { storeRepo, storeMoney, storeWriter, type CreateOrderArgs } from '../../repo-factory';
import { lookupStore } from '../../definer';
import { readInStoreContext } from '../../store-scoped-read';
import { rankedSearchWithMode } from '../../../services/product-search.service';
import { queryBudgetSpent } from '../../search/embed-budget';
import { codFeeConfigFromRow } from '../../../services/payment-providers/cod.provider';
import { isWhatsAppLinked } from '../link';
import { applyCodOutcome } from '../store-events-consumer';
import { createHash } from 'crypto';
import { PaymentService } from '../../../services/payment-providers/payment.factory';
import { InstapayService } from '../../../services/payment-providers/instapay.service';
import { paymentWebhookUrl } from '../../../services/payment-providers/webhook-url';
import { buildPaymentLineItems } from '../../payment-line-items';
import { auditLog } from '../../../middleware/security';
import { inngest } from '../../inngest/client';
import { ANONYMOUS_BUYER } from '../../buyer-identity';
import logger from '../../logger';
import { config } from '../../../config';
import {
  PortError,
  type Address,
  type BridgePort,
  type CatalogRow,
  type ChatPaymentMethod,
  type CustomerProfileFacts,
  type StorePolicyFacts,
  type OrderStatus,
  type OrderSummary,
  type StoreProfile,
} from './service';
import type { Currency } from '../../../services/payment-providers/types';
import { proofRef } from './proof-ref';

type Db = any; // the repo's Prisma-shaped read/write client; rows are narrowed below by explicit selects
const LINK_TTL_MS = 24 * 3600 * 1000;

const db = async (storeId: string): Promise<Db> => (await storeRepo(storeId)).db;

function orderStatus(o: { status: string; paymentStatus: string }, method: string): OrderStatus {
  switch (o.status) {
    case 'pending':
      return method === 'cod' ? 'pending_confirmation' : 'pending_payment';
    case 'awaiting_payment_confirmation':
      return 'pending_payment';
    case 'confirmed':
    case 'processing':
      return 'confirmed';
    case 'shipped':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'returned'; // refunded
  }
}
const methodOf = (
  payments: Array<{ provider: string }> | undefined,
  walletAmount: number,
  total: number
): OrderSummary['paymentMethod'] => {
  const p = payments?.[0]?.provider;
  if (p === 'cod') return 'cod';
  if (p === 'instapay') return 'instapay';
  if (!p && walletAmount >= total && total > 0) return 'wallet';
  return 'card';
};

/** How many ranked ids the chat search expands into rows (the caller's `limit` is at most 20). */
const SEARCH_CANDIDATES = 60;

/** A product row as the chat search reads it (PRODUCT_SELECT); passed on to rowsForProducts. */
type ChatSearchProductRow = { id: string } & Record<string, unknown>;
/** One active shipping area rate, as the policy fold reads it. */
type ChatAreaRateRow = {
  governorate: string;
  governorateAr: string;
  deliveryFee: number;
  freeShippingThreshold: number | null;
};
/** One active shipping zone, as the policy answer reads it. */
type ChatZoneRow = {
  name: string;
  nameAr: string | null;
  areas: unknown;
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDays: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
};
/** One recent order for the chat customer profile (the `select` below). */
type ChatRecentOrderRow = {
  orderNumber: string;
  status: string;
  paymentStatus: string;
  total: number;
  walletAmount: number;
  currency: string;
  createdAt: Date | string;
  items: Array<{ productName: string; variantName: string | null; quantity: number }>;
  payments: Array<{ provider: string }>;
};

/** Per-governorate rates folded from the area rates: cheapest and dearest fee, and the lowest free-shipping threshold. */
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-do-port-chat-context.test.ts
export function governoratesOf(
  rates: ChatAreaRateRow[]
): StorePolicyFacts['shipping']['governorates'] {
  const by = new Map<string, StorePolicyFacts['shipping']['governorates'][number]>();
  for (const r of rates) {
    const cur = by.get(r.governorate);
    if (!cur) {
      by.set(r.governorate, {
        governorate: r.governorate,
        governorateAr: r.governorateAr,
        feeMinor: r.deliveryFee,
        feeMaxMinor: r.deliveryFee,
        freeOverMinor: r.freeShippingThreshold ?? null,
      });
      continue;
    }
    cur.feeMinor = Math.min(cur.feeMinor, r.deliveryFee);
    cur.feeMaxMinor = Math.max(cur.feeMaxMinor, r.deliveryFee);
    if (r.freeShippingThreshold != null)
      cur.freeOverMinor =
        cur.freeOverMinor === null
          ? r.freeShippingThreshold
          : Math.min(cur.freeOverMinor, r.freeShippingThreshold);
  }
  return [...by.values()].slice(0, 30);
}

const PRODUCT_SELECT = {
  id: true,
  name: true,
  nameAr: true,
  description: true,
  price: true,
  slug: true,
  inventory: true,
  trackInventory: true,
  images: { take: 1, orderBy: { position: 'asc' } },
} as const;

/** One catalog row per sellable thing: each variant of a variant product, else the simple product itself. `retailerId` is THE catalogue item id (`catalogueItemId`, @ebda/shared; Ruling FEEDS-2) - the same id the Google/Meta/TikTok feeds and the storefront pixel use. */
async function rowsForProducts(
  storeId: string,
  d: Db,
  products: any[],
  onlyIds?: Set<string>
): Promise<CatalogRow[]> {
  if (products.length === 0) return [];
  const origin = await originFor(storeId);
  const currency = await currencyOf(storeId);
  const variants: any[] = await d.productVariant.findMany({
    where: { productId: { in: products.map(p => p.id) } },
    orderBy: { position: 'asc' },
  });
  const byProduct = new Map<string, any[]>();
  for (const v of variants) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
  const out: CatalogRow[] = [];
  for (const p of products) {
    const common = {
      productId: p.id,
      titleAr: p.nameAr ?? null,
      description: p.description ?? null,
      currency,
      link: `${origin}/products/${p.slug ?? p.id}`,
      brand: null,
    };
    const vs = byProduct.get(p.id) ?? [];
    if (vs.length === 0) {
      if (onlyIds && !onlyIds.has(p.id)) continue;
      out.push({
        ...common,
        retailerId: catalogueItemId({ productId: p.id }),
        title: p.name,
        priceMinor: p.price,
        availability: p.trackInventory === false || p.inventory > 0 ? 'in_stock' : 'out_of_stock',
        imageUrl: p.images?.[0]?.url ?? null,
      });
    } else {
      for (const v of vs) {
        if (onlyIds && !onlyIds.has(v.id)) continue;
        out.push({
          ...common,
          retailerId: catalogueItemId({ productId: p.id, variantId: v.id }),
          title: v.title ? `${p.name} - ${v.title}` : p.name,
          priceMinor: v.price ?? p.price,
          availability:
            v.isActive && (v.inventory > 0 || v.allowBackorder) ? 'in_stock' : 'out_of_stock',
          imageUrl: v.imageUrl ?? p.images?.[0]?.url ?? null,
        });
      }
    }
  }
  return out;
}
const currencyOf = async (storeId: string): Promise<string> =>
  (
    await (
      await db(storeId)
    ).store.findUnique({ where: { id: storeId }, select: { currency: true } })
  )?.currency ?? 'EGP';
async function originFor(storeId: string): Promise<string> {
  const s = await (
    await db(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: { id: true, slug: true, domain: true, name: true, nameAr: true },
  });
  return s ? storefrontOrigin(s) : config.webUrl;
}
export const storefrontUrlFor = originFor;

/** Engine refusals that mean "this product / variant cannot be bought now": shown to the buyer as unavailable, with the variant ids. */
const UNAVAILABLE_CODES = new Set([
  'OUT_OF_STOCK',
  'PRODUCT_UNAVAILABLE',
  'VARIANT_UNAVAILABLE',
  'VARIANT_INACTIVE',
]);
/** Other permanent business refusals of the checkout engine (never worth retrying): shown to the buyer as a typed `invalid`. */
const BUSINESS_CODES = new Set([
  'MIN_ORDER_NOT_MET',
  'TOO_MANY_OPEN_ORDERS',
  'IDEMPOTENCY_CONFLICT',
  'VARIANT_REQUIRED',
  'EMPTY_CART',
  'BAD_LINES',
  'BAD_QUANTITY',
  'BAD_ADDRESS',
  'BAD_AMOUNT',
  'BAD_ARGS',
  'BAD_ID',
  'COUPON_EXHAUSTED',
  'COUPON_EXPIRED',
  'COUPON_INVALID',
  'COUPON_USER_LIMIT',
  'INSUFFICIENT_WALLET',
  'TOTAL_TOO_LARGE',
  'GOLD_PRICE_DRIFT',
  'GOLD_PREPAID_REQUIRED',
  'NO_STORE',
]);
/**
 * A permanent business refusal becomes a typed PortError (no retry, Chat shows the buyer, Ruling WA-RPC-8, #617); anything else
 * (a 5xx, a timeout, an unknown error) is null and propagates so the caller retries. A 4xx engine error with a string code that is not
 * listed is still permanent (the engine refuses deterministically below 500) and reported `invalid` with its code.
 */
export function refusalOf(e: unknown, variantIds: string[]): PortError | null {
  const err = e as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof err?.code === 'string' ? err.code : null;
  if (!code) return null;
  const status =
    typeof err.statusCode === 'number'
      ? err.statusCode
      : typeof err.status === 'number'
        ? err.status
        : null;
  const message = typeof err.message === 'string' ? err.message : code;
  // A 5xx is an engine BUG or outage, never a business rule (Ruling WA-RPC-9, #662): it propagates so it is logged and retried, whatever its code.
  if (status !== null && status >= 500) return null;
  if (UNAVAILABLE_CODES.has(code)) return new PortError('out_of_stock', message, variantIds, code);
  if (BUSINESS_CODES.has(code) || (status !== null && status >= 400 && status < 500))
    return new PortError('invalid', message, undefined, code);
  return null;
}

export function createDoPort(): BridgePort {
  const profile = async (storeId: string): Promise<StoreProfile | null> => {
    if (!(await lookupStore({ id: storeId }, ['active', 'inactive']))) return null;
    const d = await db(storeId);
    const s = await d.store.findUnique({
      where: { id: storeId },
      select: { name: true, nameAr: true, logo: true, currency: true, settings: true },
    });
    if (!s) return null;
    const cfgs: Array<{ provider: string; settings: Record<string, unknown> | null }> =
      await d.paymentConfig.findMany({
        where: { storeId, isEnabled: true },
        select: { provider: true, settings: true },
      });
    const cod = cfgs.some(c => c.provider === 'cod');
    const ip = cfgs.find(c => c.provider === 'instapay');
    const ipa =
      typeof ip?.settings?.handle === 'string'
        ? ip.settings.handle
        : typeof ip?.settings?.phone === 'string'
          ? ip.settings.phone
          : null;
    const online = cfgs.some(c => c.provider !== 'cod' && c.provider !== 'instapay');
    const methods: ChatPaymentMethod[] = [
      ...(cod ? ['cod' as const] : []),
      ...(online ? ['link' as const] : []),
      ...(ip && ipa ? ['instapay' as const] : []),
    ];
    const locale =
      (s.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en' ? 'en' : 'ar';
    return {
      name: s.name,
      logoUrl: s.logo ?? null,
      locale,
      currency: s.currency,
      paymentMethods: methods,
      codEnabled: cod,
      instapay:
        ip && ipa
          ? {
              ipa,
              displayName:
                typeof ip.settings?.accountName === 'string' ? ip.settings.accountName : s.name,
            }
          : null,
    };
  };

  const buyerOrders = async (
    storeId: string,
    buyerKey: string,
    take: number,
    extra: Record<string, unknown> = {}
  ) =>
    (await db(storeId)).order.findMany({
      where: { storeId, buyerKey, deletedAt: null, ...extra },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        total: true,
        walletAmount: true,
        currency: true,
        createdAt: true,
        customerId: true,
        items: { select: { quantity: true } },
        payments: { select: { provider: true }, take: 1 },
      },
    }) as Promise<any[]>;

  return {
    storeProfile: profile,
    isLinked: isWhatsAppLinked,

    // Pages over PRODUCTS (cursor = last product id), so a page holds every variant of each product on it: `items` can exceed `limit`
    // for a variant-heavy page but never splits a product (Ruling WA-RPC-6).
    async catalogPage(storeId, cursor, limit) {
      const d = await db(storeId);
      const products: any[] = await d.product.findMany({
        where: {
          storeId,
          status: 'active',
          deletedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
        select: PRODUCT_SELECT,
      });
      const page = products.slice(0, limit);
      return {
        items: await rowsForProducts(storeId, d, page),
        nextCursor: products.length > limit ? page[page.length - 1].id : null,
      };
    },

    // Only ACTIVE products (Ruling BRIDGE-ACTIVE-1): same rule as `catalogPage`. A draft or archived product is "not there" for the cart check
    // and the event sync, so Ebda Chat neither accepts it in a cart nor pushes it back into Meta.
    async catalogByIds(storeId, ids) {
      const d = await db(storeId);
      const variants: any[] = await d.productVariant.findMany({
        where: { id: { in: ids } },
        select: { id: true, productId: true },
      });
      const productIds = [...new Set([...variants.map(v => v.productId as string), ...ids])];
      const products: any[] = await d.product.findMany({
        where: { storeId, id: { in: productIds }, status: 'active', deletedAt: null },
        select: PRODUCT_SELECT,
      });
      return rowsForProducts(storeId, d, products, new Set(ids));
    },

    // The storefront's own ranked search (Arabic stemming, AI Franco/dialect search terms, meaning leg: Ruling SEARCH-SEMANTIC-ON-1),
    // so Chat and the website can never disagree on what "فستان احمر" matches. Active public products only, rank order kept,
    // the price ceiling applied per sellable row (a variant can be cheaper than its product).
    async searchProducts(storeId, query, o) {
      const { ids, degraded } = await readInStoreContext(storeId, () =>
        rankedSearchWithMode(storeId, query, { searcher: o.searcher })
      );
      // Chat only: once the store's daily query-embed budget is spent the meaning leg is skipped and the storefront calls that
      // "not degraded" (it is a budget, not a failure). For Chat an empty answer then rests on keyword search alone, so it is
      // reported degraded and the agent says it will check instead of "we don't have it" (Ruling CHAT-AGENT-6).
      if (ids.length === 0) return { items: [], degraded: degraded || queryBudgetSpent(storeId) };
      const top = ids.slice(0, SEARCH_CANDIDATES);
      const d = await db(storeId);
      const products: ChatSearchProductRow[] = await d.product.findMany({
        where: { storeId, id: { in: top }, status: 'active', deletedAt: null, audience: 'public' },
        select: PRODUCT_SELECT,
      });
      const byId = new Map(products.map(p => [p.id, p]));
      const ranked = top
        .map(id => byId.get(id))
        .filter((p): p is ChatSearchProductRow => p !== undefined);
      const rows = await rowsForProducts(storeId, d, ranked);
      return {
        items: rows
          .filter(r => o.maxPriceMinor === undefined || r.priceMinor <= o.maxPriceMinor)
          .slice(0, o.limit),
        degraded,
      };
    },

    async storePolicies(storeId): Promise<StorePolicyFacts> {
      const d = await db(storeId);
      const s = await d.store.findUnique({
        where: { id: storeId },
        select: {
          nameAr: true,
          businessHours: true,
          address: true,
          addressAr: true,
          googleMapsUrl: true,
          returnWindowDays: true,
          returnFeesPaidBy: true,
        },
      });
      const zones: ChatZoneRow[] = await d.shippingZone.findMany({
        where: { storeId, isActive: true },
        orderBy: { position: 'asc' },
        take: 30,
      });
      const areaRates: ChatAreaRateRow[] = await d.shippingAreaRate.findMany({
        where: { storeId, isActive: true },
        orderBy: { position: 'asc' },
        take: 2000,
      });
      const cod = await d.paymentConfig.findFirst({
        where: { storeId, provider: 'cod', isEnabled: true },
        select: { fixedFee: true, settings: true },
      });
      const codCfg = cod ? codFeeConfigFromRow(cod) : null;
      const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const loc = {
        address: text(s?.address),
        addressAr: text(s?.addressAr),
        mapsUrl: text(s?.googleMapsUrl),
      };
      return {
        nameAr: text(s?.nameAr),
        shipping: {
          zones: zones.map(z => ({
            name: z.name,
            nameAr: text(z.nameAr),
            areas: Array.isArray(z.areas) ? (z.areas as unknown[]).map(String).slice(0, 40) : [],
            feeMinor: z.deliveryFee,
            freeOverMinor: z.freeShippingThreshold ?? null,
            etaDaysMin: z.estimatedDaysMin ?? z.estimatedDays ?? null,
            etaDaysMax: z.estimatedDaysMax ?? z.estimatedDays ?? null,
          })),
          governorates: governoratesOf(areaRates),
        },
        returns: {
          windowDays: typeof s?.returnWindowDays === 'number' ? s.returnWindowDays : null,
          feesPaidBy:
            s?.returnFeesPaidBy === 'merchant' || s?.returnFeesPaidBy === 'customer'
              ? s.returnFeesPaidBy
              : null,
        },
        // 0 = "no fee declared", reported as null: the agent must not say "COD fee is 0" for a merchant who never set one
        cod: {
          fixedFeeMinor: codCfg && codCfg.fixedFee > 0 ? codCfg.fixedFee : null,
          percentBps: codCfg && codCfg.percentBps > 0 ? codCfg.percentBps : null,
        },
        hours: text(s?.businessHours),
        location: loc.address || loc.addressAr || loc.mapsUrl ? loc : null,
      };
    },

    async customerProfile(storeId, buyerKey): Promise<CustomerProfileFacts | null> {
      const base = (await (
        await storeWriter(storeId)
      ).$proc('waCustomerProfile', { storeId, buyerKey })) as {
        firstName: string | null;
        preferredLocale: 'ar' | 'en' | null;
        defaultAddress: CustomerProfileFacts['defaultAddress'];
        known: boolean;
      };
      const d = await db(storeId);
      const orders: ChatRecentOrderRow[] = await d.order.findMany({
        where: { storeId, buyerKey, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: {
          orderNumber: true,
          status: true,
          paymentStatus: true,
          total: true,
          walletAmount: true,
          currency: true,
          createdAt: true,
          items: { select: { productName: true, variantName: true, quantity: true }, take: 10 },
          payments: { select: { provider: true }, take: 1 },
        },
      });
      if (!base.known && orders.length === 0) return null;
      return {
        firstName: base.firstName,
        preferredLocale: base.preferredLocale,
        defaultAddress: base.defaultAddress,
        recentOrders: orders.map(o => ({
          orderNumber: o.orderNumber,
          status: orderStatus(o, methodOf(o.payments, o.walletAmount, o.total)),
          totalMinor: o.total,
          currency: o.currency,
          at: new Date(o.createdAt).getTime(),
          items: o.items.map(i => ({
            name: i.variantName ? `${i.productName} - ${i.variantName}` : i.productName,
            quantity: i.quantity,
          })),
        })),
      };
    },

    async placeOrder(storeId, a) {
      const d = await db(storeId);
      const money = await storeMoney(storeId);
      if (!money) throw new PortError('unavailable', 'store is not on a Durable Object');
      const wanted = a.items.map(i => i.variantId);
      const variants: any[] = await d.productVariant.findMany({
        where: { id: { in: wanted }, product: { storeId, deletedAt: null } },
        select: { id: true, productId: true },
      });
      const vById = new Map(variants.map(v => [v.id as string, v.productId as string]));
      const simple: any[] = await d.product.findMany({
        where: { storeId, id: { in: wanted.filter(w => !vById.has(w)) }, deletedAt: null },
        select: { id: true },
      });
      const pIds = new Set(simple.map(p => p.id as string));
      const lines: CreateOrderArgs['lines'] = [];
      for (const it of a.items) {
        const productId = vById.get(it.variantId);
        if (productId) lines.push({ productId, variantId: it.variantId, quantity: it.quantity });
        else if (pIds.has(it.variantId))
          lines.push({ productId: it.variantId, quantity: it.quantity });
        else throw new PortError('not_found', `variant ${it.variantId}`);
      }
      let area: string, street: string;
      if (a.addressId) {
        const saved = (await (
          await storeWriter(storeId)
        ).$proc('waAddresses', { storeId, buyerKey: a.buyer.buyerKey })) as Address[];
        const found = saved.find(x => x.id === a.addressId);
        if (!found) throw new PortError('not_found', 'address');
        ({ area, street } = found);
      } else ({ area, street } = a.address!);
      const first = (a.buyer.name ?? '').trim();
      const args: CreateOrderArgs = {
        lines,
        buyer: ANONYMOUS_BUYER,
        paymentMethod: a.paymentMethod,
        idempotencyKey: `wa:${a.idempotencyKey}`,
        source: 'whatsapp',
        locale: a.buyer.locale,
        shippingAddress: {
          firstName: first.split(' ')[0] || 'Customer',
          lastName: first.split(' ').slice(1).join(' ') || '-',
          phone: a.buyer.phoneE164,
          area,
          address1: street,
          street,
          country: 'EG',
        },
      };
      let placed;
      try {
        placed = await money.createOrder(args);
      } catch (e) {
        throw (
          refusalOf(
            e,
            a.items.map(i => i.variantId)
          ) ?? e
        );
      }
      // Every step below is idempotent, so a REPLAY (the caller retrying after a transient failure of an earlier step) runs them again and
      // completes whatever is missing (Ruling WA-RPC-8, #616): the buyer key stamp is fill-only-NULL, the payment rows are reused, and the
      // `order/created` fanout claims `order_created_notified_at` atomically. Stamp FIRST so the buyer can see the order even if a later
      // step throws; a failed send THROWS (the caller retries the same key) instead of being logged and lost.
      await money.ciOrderStamp({
        orderId: placed.orderId,
        areaKey: null,
        buyerKey: a.buyer.buyerKey,
      });
      // The engine writes the ORDER; the payment row is a second step exactly as at checkout (payment.routes.ts / InstapayService), both
      // replay-safe (an open COD row is reused, an awaiting InstaPay order returns the same instructions).
      const currency = await currencyOf(storeId);
      if (a.paymentMethod === 'cod' && placed.paymentStatus !== 'paid') {
        await PaymentService.recordCodPayment({
          storeId,
          orderId: placed.orderId,
          amount: placed.total - placed.walletAmount,
          currency,
          metadata: { codFee: placed.codFee, originalTotal: placed.total - placed.codFee },
          userId: null,
        });
      } else if (a.paymentMethod === 'instapay' && placed.paymentStatus !== 'paid') {
        await InstapayService.initiate({
          storeId,
          order: {
            id: placed.orderId,
            orderNumber: placed.orderNumber,
            total: placed.total,
            walletAmount: placed.walletAmount,
            currency,
            status: 'pending',
          },
          customer: { name: a.buyer.name ?? 'Customer', email: '', phone: a.buyer.phoneE164 },
          userId: null,
        });
      }
      // `order/created` announces the order to Ebda Chat (COD confirmation request) and to CI; same shape OrderService sends.
      await inngest.send({
        name: 'order/created',
        data: {
          orderId: placed.orderId,
          storeId,
          paymentMethod: placed.paymentStatus === 'paid' ? 'wallet' : a.paymentMethod,
          locale: a.buyer.locale,
        },
      });
      // remember an address typed in chat so the next chat can offer it (best effort: the order is already placed)
      if (a.address && !placed.replayed)
        await Promise.resolve(
          (await storeWriter(storeId)).$proc('waSaveAddress', {
            storeId,
            buyerKey: a.buyer.buyerKey,
            label: a.address.label ?? null,
            area: a.address.area,
            street: a.address.street,
          })
        ).catch(() => undefined);
      return {
        orderId: placed.orderId,
        orderNumber: placed.orderNumber,
        totalMinor: placed.total,
        currency: await currencyOf(storeId),
        paymentStatus: placed.paymentStatus,
        replayed: placed.replayed,
      };
    },

    async orderPayable(storeId, orderId) {
      const o = await (
        await db(storeId)
      ).order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        select: {
          orderNumber: true,
          paymentStatus: true,
          status: true,
          payments: { select: { provider: true }, take: 1 },
        },
      });
      return o
        ? {
            orderNumber: o.orderNumber,
            paymentStatus: o.paymentStatus,
            status: o.status,
            method: o.payments?.[0]?.provider ?? null,
          }
        : null;
    },

    async issuePaymentLink(storeId, orderId) {
      const d = await db(storeId);
      const order = await d.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: { items: true },
      });
      if (!order) throw new PortError('not_found', 'order');
      const providerName = await PaymentService.getDefaultProvider(storeId);
      if (!providerName) throw new PortError('payment_method_disabled', 'no online provider');
      const base = await originFor(storeId);
      const ship = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
      const result = await PaymentService.createPayment(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.total - order.walletAmount,
          currency: order.currency as Currency,
          customer: {
            id: `guest-${order.id}`,
            name: `${ship.firstName ?? ''} ${ship.lastName ?? ''}`.trim() || 'Customer',
            email: ship.email ?? '',
            phone: ship.phone,
          },
          items: buildPaymentLineItems(order.items),
          callbackUrl: `${base}/checkout/success`,
          errorUrl: `${base}/checkout/error`,
          webhookUrl: paymentWebhookUrl(providerName, storeId),
          notifyVia: 'link',
        },
        providerName,
        storeId
      );
      if (!result.paymentUrl) throw new PortError('unavailable', 'provider returned no url');
      return {
        url: result.paymentUrl,
        expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString(),
      };
    },

    async codOutcome(storeId, a) {
      const o = await (
        await db(storeId)
      ).order.findFirst({
        where: { id: a.orderId, storeId, deletedAt: null },
        select: { orderNumber: true },
      });
      if (!o) return null;
      // ONE implementation: the queue consumer's `applyCodOutcome` (Ruling WA-RPC-7). Open-COD-only, one-way transitions through the
      // DO status writer (which re-checks the live status), audited `source: whatsapp`; a replay is a no-op by state. The key is audited
      // as the event id (a uuid derived from it).
      const h = createHash('sha256')
        .update(`wa-rpc-cod:v1:${storeId}:${a.idempotencyKey}`)
        .digest('hex');
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      const r = await applyCodOutcome({
        id,
        type: 'whatsapp.cod_outcome',
        v: 1,
        storeId,
        occurredAt: a.at,
        data: { orderId: a.orderId, outcome: a.outcome, source: 'whatsapp' },
      });
      return r === 'unknown_order' ? null : { orderNumber: o.orderNumber };
    },

    async attachProof(storeId, orderId, mediaUrl) {
      const d = await db(storeId);
      const pay = await d.payment.findFirst({
        where: { orderId, provider: 'instapay', order: { storeId } },
        select: { id: true },
      });
      if (!pay) return false;
      // The customer's transfer screenshot from chat. The receipt pipeline needs the image bytes (Meta media download, blocked on
      // company papers), so for now the reference is audited against the order for the merchant (Ruling WA-RPC-5).
      await auditLog({
        action: 'order.instapay_proof_from_chat',
        resourceType: 'order',
        resourceId: orderId,
        storeId,
        details: { mediaRef: proofRef(mediaUrl), source: 'whatsapp' },
      });
      return true;
    },

    async orderBuyerKey(storeId, orderId) {
      const o = await (
        await db(storeId)
      ).order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        select: { buyerKey: true },
      });
      return o ? (o.buyerKey ?? null) : undefined;
    },

    async addresses(storeId, buyerKey) {
      return (await (
        await storeWriter(storeId)
      ).$proc('waAddresses', { storeId, buyerKey })) as Address[];
    },

    // Find-or-create the buyer's customer row and add the address, idempotently, in one DO section (Ruling WA-RPC-4).
    async saveAddress(storeId, buyerKey, a) {
      const r = await (
        await storeWriter(storeId)
      ).$proc('waSaveAddress', {
        storeId,
        buyerKey,
        label: a.label ?? null,
        area: a.area,
        street: a.street,
      });
      return { id: r.id, label: r.label ?? null, area: r.area, street: r.street };
    },

    async orderStatus(storeId, orderNumber, buyerKey) {
      const d = await db(storeId);
      const o = await d.order.findFirst({
        where: { storeId, orderNumber, buyerKey, deletedAt: null },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          total: true,
          walletAmount: true,
          payments: { select: { provider: true }, take: 1 },
        },
      });
      if (!o) return null;
      const sh = await d.shipment.findFirst({
        where: { orderId: o.id, storeId },
        orderBy: { createdAt: 'desc' },
        select: { status: true, trackingUrl: true },
      });
      const method = methodOf(o.payments, o.walletAmount, o.total);
      return {
        orderNumber: o.orderNumber,
        status: orderStatus(o, method),
        paymentMethod: method,
        shipment: sh ? { status: sh.status, trackingUrl: sh.trackingUrl ?? null } : null,
      };
    },

    async orderSeedIds(storeId, orderNumber, buyerKey) {
      const d = await db(storeId);
      const o = await d.order.findFirst({
        where: { storeId, orderNumber, buyerKey, deletedAt: null },
        select: { items: { select: { productId: true, variantId: true }, take: 20 } },
      });
      if (!o) return null;
      return [
        ...new Set<string>(
          o.items.map(
            (i: { variantId: string | null; productId: string }) => i.variantId ?? i.productId
          )
        ),
      ];
    },

    /**
     * Reuses the Store's own recommendation engine (curated picks, AI picks, bought-together, vector neighbours, same category;
     * the merchant's automatic switch is applied inside it) and then RE-READS every candidate from this store: storeId + active +
     * public audience + in stock. The engine's list is cached (bounded-stale, 5 min), so what is returned (price, stock, link)
     * is never taken from it, only the ids and their order.
     */
    async recommend(storeId, a) {
      const d = await db(storeId);
      // Seeds resolve inside THIS store only (a variant id of another store resolves to nothing).
      const variants: any[] = await d.productVariant.findMany({
        where: { id: { in: a.seedIds }, product: { storeId, deletedAt: null } },
        select: { id: true, productId: true },
      });
      const vById = new Map(variants.map(v => [v.id as string, v.productId as string]));
      const direct: Array<{ id: string }> = await d.product.findMany({
        where: { storeId, id: { in: a.seedIds.filter(i => !vById.has(i)) }, deletedAt: null },
        select: { id: true },
      });
      const seeds = [
        ...new Set<string>([
          ...a.seedIds.filter(i => vById.has(i)).map(i => vById.get(i)!),
          ...direct.map(p => p.id),
        ]),
      ].slice(0, 3);
      if (seeds.length === 0) return [];
      const { recommendationService } = await import('../../../services/recommendation.service.js');
      const order =
        a.mode === 'similar'
          ? ['alsoLike', 'crossSell', 'upsell']
          : ['crossSell', 'upsell', 'alsoLike'];
      const ranked: string[] = [];
      for (const seed of seeds) {
        const r = (await recommendationService.getProductRecommendations(storeId, seed)) as Record<
          string,
          Array<{ id: string }>
        >;
        for (const k of order) for (const p of r[k] ?? []) ranked.push(p.id);
      }
      const ids = [...new Set(ranked)].filter(id => !seeds.includes(id));
      if (ids.length === 0) return [];
      const products: any[] = await d.product.findMany({
        where: {
          storeId,
          id: { in: ids },
          status: 'active',
          deletedAt: null,
          ...visibleProductWhere(),
        },
        select: PRODUCT_SELECT,
      });
      const rows = await rowsForProducts(storeId, d, products);
      // One buyable row per product (the cheapest in-stock variant), within budget, in the engine's order.
      const best = new Map<string, CatalogRow>();
      for (const r of rows) {
        if (r.availability !== 'in_stock') continue;
        if (a.maxPriceMinor !== undefined && r.priceMinor > a.maxPriceMinor) continue;
        const cur = best.get(r.productId);
        if (!cur || r.priceMinor < cur.priceMinor) best.set(r.productId, r);
      }
      return ids.flatMap(id => (best.has(id) ? [best.get(id)!] : [])).slice(0, a.limit);
    },

    async customerOrders(storeId, buyerKey, limit) {
      return (await buyerOrders(storeId, buyerKey, limit)).map(o => {
        const method = methodOf(o.payments, o.walletAmount, o.total);
        return {
          orderId: o.id,
          orderNumber: o.orderNumber,
          status: orderStatus(o, method),
          totalMinor: o.total,
          currency: o.currency,
          paymentMethod: method,
          itemsCount: Math.max(1, o.items.length),
          at: new Date(o.createdAt).getTime(),
        };
      });
    },
  };
}
