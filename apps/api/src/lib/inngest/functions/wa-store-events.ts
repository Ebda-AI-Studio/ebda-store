import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@ebda/database';
import { BUYER_KEY_VERSION, buyerKeyFor, toE164 } from '@ebda/shared';
import { inngest } from '../client';
import logger from '../../logger';
import { suiteBuyerKeySecret } from '../../wa/config';
import { buildStoreEvent, sendStoreEvents, type StoreEventInput } from '../../wa/events';
import { isWhatsAppLinked } from '../../wa/link';

/**
 * Store -> Ebda WhatsApp events (contract 2026-10-24, section 4): order created, COD confirmation
 * requested, order status changed, shipment updated. One function, three source events, so the
 * emit sites in the order and carrier services stay a one-line `inngest.send` and the producer
 * gets the job layer's retries and failure alerts.
 *
 * Idempotent end to end: every envelope id is derived from the source event (+ type), so a retry
 * sends the same envelope and the consumer dedupes on `id`. A store that has not linked WhatsApp
 * emits nothing. An order with no usable phone emits nothing for the customer-facing events
 * (never invent a key or a number).
 */

/** How long a COD customer has to answer before the order is treated as unconfirmed. */
function codDeadlineHours(): number {
  const n = Number(process.env.COD_CONFIRMATION_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/** The contract's payment method enum; any gateway (card-ish) maps to `card`. */
export function contractPaymentMethod(
  raw: unknown
): 'cod' | 'link' | 'card' | 'wallet' | 'instapay' {
  const m = String(raw ?? '').toLowerCase();
  if (m === 'cod' || m === 'wallet' || m === 'instapay' || m === 'link') return m;
  return 'card';
}

type SourceEvent = { id?: string; name: string; data?: Record<string, unknown> };

async function orderEvents(event: SourceEvent): Promise<StoreEventInput[]> {
  const { orderId, storeId, paymentMethod, locale } = (event.data ?? {}) as {
    orderId?: string;
    storeId?: string;
    paymentMethod?: string;
    locale?: string;
  };
  if (!orderId || !storeId) return [];
  const order = await runInTenantContext(storeId, () =>
    prisma.order.findUnique({
      where: { id: orderId, storeId },
      select: {
        orderNumber: true,
        total: true,
        currency: true,
        shippingAddress: true,
        locale: true,
        source: true,
        createdAt: true,
      },
    })
  );
  if (!order) return [];
  const addr = (order.shippingAddress ?? {}) as { phone?: unknown };
  const phone = toE164(typeof addr.phone === 'string' ? addr.phone : null);
  if (!phone) {
    logger.info({ orderId, storeId }, '[wa-events] order has no usable phone, nothing sent');
    return [];
  }
  const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), phone);
  if (!buyerKey) return [];
  const loc = (locale ?? order.locale ?? 'ar') as string;
  const method = contractPaymentMethod(paymentMethod);
  const out: StoreEventInput[] = [
    {
      type: 'order.created',
      storeId,
      data: {
        orderId,
        orderNumber: order.orderNumber,
        buyerKey,
        phoneE164: phone,
        locale: loc,
        totalMinor: order.total,
        currency: order.currency,
        paymentMethod: method,
        channel: order.source ?? 'web',
      },
    },
  ];
  if (method === 'cod') {
    out.push({
      type: 'order.cod_confirmation_requested',
      storeId,
      data: {
        orderId,
        buyerKey,
        phoneE164: phone,
        locale: loc,
        deadlineAt: new Date(
          order.createdAt.getTime() + codDeadlineHours() * 3_600_000
        ).toISOString(),
        orderNumber: order.orderNumber,
        totalMinor: order.total,
        currency: order.currency,
      },
    });
  }
  return out;
}

async function shipmentEvent(event: SourceEvent): Promise<StoreEventInput[]> {
  const d = (event.data ?? {}) as {
    storeId?: string;
    orderId?: string;
    shipmentId?: string;
    status?: string;
    trackingUrl?: string | null;
    updatedAt?: string;
  };
  if (!d.storeId || !d.orderId || !d.shipmentId || !d.status) return [];
  const order = await runInTenantContext(d.storeId, () =>
    prisma.order.findUnique({
      where: { id: d.orderId!, storeId: d.storeId! },
      select: { orderNumber: true, shippingAddress: true, locale: true },
    })
  );
  const addr = (order?.shippingAddress ?? {}) as { phone?: unknown };
  const phone = toE164(typeof addr.phone === 'string' ? addr.phone : null);
  return [
    {
      type: 'shipment.updated',
      storeId: d.storeId,
      data: {
        orderId: d.orderId,
        shipmentId: d.shipmentId,
        status: d.status,
        ...(d.trackingUrl && /^https?:\/\//.test(d.trackingUrl)
          ? { trackingUrl: d.trackingUrl }
          : {}),
        updatedAt: d.updatedAt ?? new Date().toISOString(),
        // The customer-facing template needs these; WhatsApp otherwise looks the order up by id.
        ...(phone ? { phoneE164: phone } : {}),
        ...(order?.locale ? { locale: order.locale } : {}),
        ...(order?.orderNumber ? { orderNumber: order.orderNumber } : {}),
      },
    },
  ];
}

function statusEvent(event: SourceEvent): StoreEventInput[] {
  const d = (event.data ?? {}) as { orderId?: string; storeId?: string; status?: string };
  if (!d.orderId || !d.storeId || !d.status) return [];
  return [
    {
      type: 'order.status_changed',
      storeId: d.storeId,
      data: { orderId: d.orderId, status: d.status, updatedAt: new Date().toISOString() },
    },
  ];
}

export async function emitStoreEventsFor(event: SourceEvent): Promise<number> {
  const storeId = (event.data as { storeId?: string } | undefined)?.storeId;
  if (!storeId || !(await isWhatsAppLinked(storeId))) return 0;
  const inputs =
    event.name === 'order/created'
      ? await orderEvents(event)
      : event.name === 'shipment/status-updated'
        ? await shipmentEvent(event)
        : event.name === 'order/status-changed'
          ? statusEvent(event)
          : [];
  if (inputs.length === 0) return 0;
  const d = event.data as { orderId?: string; status?: string; shipmentId?: string };
  // One seed per source occurrence: an order is created once, a status/shipment status can repeat
  // only as a different value, so (order, value) identifies the occurrence across retries.
  const seed = event.id ?? `${d.orderId}:${d.shipmentId ?? ''}:${d.status ?? ''}`;
  const events = await Promise.all(inputs.map(i => buildStoreEvent(i, { seed })));
  await sendStoreEvents(events);
  return events.length;
}

export const waStoreEvents: InngestFunction.Any = inngest.createFunction(
  {
    id: 'wa-store-events',
    name: 'Store -> Ebda WhatsApp events',
    retries: 4,
    triggers: [
      { event: 'order/created' },
      { event: 'order/status-changed' },
      { event: 'shipment/status-updated' },
    ],
  },
  async ({ event, step }) => {
    const sent = await step.run('emit', () => emitStoreEventsFor(event as SourceEvent));
    return { sent, keyVersion: BUYER_KEY_VERSION };
  }
);
