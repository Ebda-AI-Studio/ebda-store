/**
 * The real `BridgePort`: StoreDO / D1 through the repo layer (no Postgres). Every read and write is scoped by the `storeId` the
 * service already resolved and gated; no query runs without it. Money (prices, totals, stock, COD fee) is the checkout engine's
 * (`money.createOrder`), exactly the path the storefront uses; this file only translates chat shapes into it.
 */
import { createHash } from 'crypto';
import { storefrontOrigin } from '@ebda/shared';
import { storeRepo, storeMoney, storeWriter, type CreateOrderArgs } from '../../repo-factory';
import { lookupStore } from '../../definer';
import { isWhatsAppLinked } from '../link';
import { handleStoreEvent } from '../store-events-consumer';
import { PaymentService } from '../../../services/payment-providers/payment.factory';
import { paymentWebhookUrl } from '../../../services/payment-providers/webhook-url';
import { buildPaymentLineItems } from '../../payment-line-items';
import { auditLog } from '../../../middleware/security';
import { inngest } from '../../inngest/client';
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

/** A stable v4-shaped uuid from (store, key): the envelope id `handleStoreEvent` dedupes on, so a replayed key replays safely. */
export function envelopeId(storeId: string, key: string): string {
  const h = createHash('sha256').update(`wa-rpc-cod:v1:${storeId}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

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

async function toRows(
  storeId: string,
  variants: any[],
  products: Map<string, any>,
  currency: string
): Promise<CatalogRow[]> {
  const origin = await originFor(storeId);
  return variants.map(v => {
    const p = products.get(v.productId);
    return {
      retailerId: v.id,
      productId: v.productId,
      title: v.title && p ? `${p.name} - ${v.title}` : (p?.name ?? v.title),
      titleAr: p?.nameAr ?? null,
      description: p?.description ?? null,
      priceMinor: v.price ?? p?.price ?? 0,
      currency,
      availability:
        v.isActive && (v.inventory > 0 || v.allowBackorder) ? 'in_stock' : 'out_of_stock',
      imageUrl: v.imageUrl ?? p?.images?.[0]?.url ?? null,
      link: `${origin}/products/${p?.slug ?? v.productId}`,
      brand: null,
    } as CatalogRow;
  });
}
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
  const currencyOf = async (storeId: string) => (await profile(storeId))?.currency ?? 'EGP';

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

    async catalogPage(storeId, cursor, limit) {
      const d = await db(storeId);
      const variants: any[] = await d.productVariant.findMany({
        where: {
          product: { storeId, status: 'active', deletedAt: null },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const page = variants.slice(0, limit);
      const prods: any[] = await d.product.findMany({
        where: { storeId, id: { in: [...new Set(page.map(v => v.productId))] } },
        select: {
          id: true,
          name: true,
          nameAr: true,
          description: true,
          price: true,
          slug: true,
          images: { take: 1, orderBy: { position: 'asc' } },
        },
      });
      return {
        items: await toRows(
          storeId,
          page,
          new Map(prods.map(p => [p.id, p])),
          await currencyOf(storeId)
        ),
        nextCursor: variants.length > limit ? page[page.length - 1].id : null,
      };
    },

    async catalogByIds(storeId, ids) {
      const d = await db(storeId);
      const variants: any[] = await d.productVariant.findMany({
        where: { id: { in: ids }, product: { storeId, deletedAt: null } },
      });
      const prods: any[] = await d.product.findMany({
        where: { storeId, id: { in: [...new Set(variants.map(v => v.productId))] } },
        select: {
          id: true,
          name: true,
          nameAr: true,
          description: true,
          price: true,
          slug: true,
          images: { take: 1, orderBy: { position: 'asc' } },
        },
      });
      return toRows(
        storeId,
        variants,
        new Map(prods.map(p => [p.id, p])),
        await currencyOf(storeId)
      );
    },

    async placeOrder(storeId, a) {
      const d = await db(storeId);
      const money = await storeMoney(storeId);
      if (!money) throw new PortError('unavailable', 'store is not on a Durable Object');
      const variants: any[] = await d.productVariant.findMany({
        where: { id: { in: a.items.map(i => i.variantId) }, product: { storeId, deletedAt: null } },
        select: { id: true, productId: true },
      });
      const vById = new Map(variants.map(v => [v.id as string, v.productId as string]));
      const lines: CreateOrderArgs['lines'] = [];
      for (const it of a.items) {
        const productId = vById.get(it.variantId);
        if (!productId) throw new PortError('not_found', `variant ${it.variantId}`);
        lines.push({ productId, variantId: it.variantId, quantity: it.quantity });
      }
      let area: string, street: string;
      if (a.addressId) {
        const customer = (
          await buyerOrders(storeId, a.buyer.buyerKey, 1, { customerId: { not: null } })
        )[0];
        const found = customer?.customerId
          ? await d.customerAddress.findFirst({
              where: { id: a.addressId, customerId: customer.customerId },
              select: { area: true, street: true },
            })
          : null;
        if (!found) throw new PortError('not_found', 'address');
        ({ area, street } = found);
      } else ({ area, street } = a.address!);
      const first = (a.buyer.name ?? '').trim();
      const args: CreateOrderArgs = {
        lines,
        buyer: { kind: 'anonymous' },
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
      // `order/created` (idempotent downstream) stamps the buyer key on the order via the CI planner (same normaliser and secret as
      // Ebda Chat), which is what later status / history / address reads match on; it also emits `order.created` to Ebda Chat.
      if (!placed.replayed)
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
          .catch(() => undefined);
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
      // The proven queue path does the work: row-locked, open-COD-only, state transition idempotent, `source: whatsapp` audited, and no
      // Store-side commerce outcome (Ebda Chat already emitted it). The envelope id derives from the idempotency key, so a replay dedupes.
      const r = await handleStoreEvent({
        id: envelopeId(storeId, a.idempotencyKey),
        type: 'whatsapp.cod_outcome',
        v: 1,
        storeId,
        occurredAt: a.at,
        data: { orderId: a.orderId, outcome: a.outcome, source: 'whatsapp' },
      });
      if (r === 'invalid') throw new PortError('invalid', 'cod outcome rejected');
      if (r === 'unknown_order') return null;
      return { orderNumber: o.orderNumber };
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
      const o = (await buyerOrders(storeId, buyerKey, 1, { customerId: { not: null } }))[0];
      if (!o?.customerId) return [];
      const rows: any[] = await (
        await db(storeId)
      ).customerAddress.findMany({
        where: { customerId: o.customerId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, label: true, area: true, street: true },
      });
      return rows as Address[];
    },

    async saveAddress(storeId, buyerKey, a) {
      const o = (await buyerOrders(storeId, buyerKey, 1, { customerId: { not: null } }))[0];
      if (!o?.customerId) return null;
      const row = await (
        await storeWriter(storeId)
      ).customerAddress.create({
        data: {
          customerId: o.customerId,
          label: a.label ?? null,
          area: a.area,
          street: a.street,
          isDefault: false,
        },
      });
      return { id: row.id, label: row.label ?? null, area: row.area, street: row.street };
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
