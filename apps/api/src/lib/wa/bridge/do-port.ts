/**
 * The real `BridgePort`: StoreDO / D1 through the repo layer (no Postgres). Every read and write is scoped by the `storeId` the
 * service already resolved and gated; no query runs without it. Money (prices, totals, stock, COD fee) is the checkout engine's
 * (`money.createOrder`), exactly the path the storefront uses; this file only translates chat shapes into it.
 */
import { storefrontOrigin } from '@ebda/shared';
import { storeRepo, storeMoney, storeWriter, type CreateOrderArgs } from '../../repo-factory';
import { lookupStore } from '../../definer';
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
  type OrderStatus,
  type OrderSummary,
  type StoreProfile,
} from './service';
import type { Currency } from '../../../services/payment-providers/types';

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

/** One catalog row per sellable thing: each variant of a variant product, else the simple product itself (retailer id = product id). */
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
        retailerId: p.id,
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
          retailerId: v.id,
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

    async catalogByIds(storeId, ids) {
      const d = await db(storeId);
      const variants: any[] = await d.productVariant.findMany({
        where: { id: { in: ids } },
        select: { id: true, productId: true },
      });
      const productIds = [...new Set([...variants.map(v => v.productId as string), ...ids])];
      const products: any[] = await d.product.findMany({
        where: { storeId, id: { in: productIds }, deletedAt: null },
        select: PRODUCT_SELECT,
      });
      return rowsForProducts(storeId, d, products, new Set(ids));
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
        const msg = e as { code?: string; message?: string };
        if (/STOCK|INVENTORY|OUT_OF/i.test(msg.code ?? ''))
          throw new PortError(
            'out_of_stock',
            msg.message,
            a.items.map(i => i.variantId)
          );
        if (/BAD_|INVALID|NOT_FOUND|MOQ|CART/i.test(msg.code ?? ''))
          throw new PortError('invalid', msg.message);
        throw e;
      }
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
      if (!placed.replayed) {
        // Stamp the buyer key NOW: status / history reads match on it. The CI planner adds the area key afterwards (fill-only-NULL stamp).
        await money.ciOrderStamp({
          orderId: placed.orderId,
          areaKey: null,
          buyerKey: a.buyer.buyerKey,
        });
        // `order/created` announces the order to Ebda Chat (COD confirmation request) and to CI; same shape OrderService sends.
        await inngest
          .send({
            name: 'order/created',
            data: {
              orderId: placed.orderId,
              storeId,
              paymentMethod: placed.paymentStatus === 'paid' ? 'wallet' : a.paymentMethod,
              locale: a.buyer.locale,
            },
          })
          .catch((err: unknown) =>
            logger.error(
              { err, orderId: placed.orderId },
              'wa-bridge: failed to enqueue order/created'
            )
          );
      }
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
        details: { mediaUrl, source: 'whatsapp' },
      });
      return true;
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
