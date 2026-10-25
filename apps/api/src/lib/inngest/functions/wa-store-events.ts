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

/** An event to send plus the seed of its envelope id: the SAME occurrence always yields the SAME id. */
interface Planned {
  input: StoreEventInput;
  seed: string;
  occurredAt?: Date;
}

const orderSelect = {
  orderNumber: true,
  total: true,
  currency: true,
  shippingAddress: true,
  locale: true,
  source: true,
  createdAt: true,
  status: true,
  paymentStatus: true,
  statusFanoutRequestedAt: true,
  payments: { select: { provider: true, status: true } },
} as const;

function phoneOf(shippingAddress: unknown): string | null {
  const addr = (shippingAddress ?? {}) as { phone?: unknown };
  return toE164(typeof addr.phone === 'string' ? addr.phone : null);
}

async function orderEvents(event: SourceEvent): Promise<Planned[]> {
  const { orderId, storeId, paymentMethod, locale } = (event.data ?? {}) as {
    orderId?: string;
    storeId?: string;
    paymentMethod?: string;
    locale?: string;
  };
  if (!orderId || !storeId) return [];
  const order = await runInTenantContext(storeId, () =>
    prisma.order.findUnique({ where: { id: orderId, storeId }, select: orderSelect })
  );
  // `order/created` can be sent from INSIDE the request transaction (Ruling WH-8): the order or its
  // COD payment may not be visible yet. Throw so the job retries (as the other fan-outs do) instead
  // of silently sending an order.created with no COD request, or nothing at all.
  if (!order) throw new Error(`order ${orderId} not visible yet`);
  const phone = phoneOf(order.shippingAddress);
  if (!phone) {
    logger.info({ orderId, storeId }, '[wa-events] order has no usable phone, nothing sent');
    return [];
  }
  const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), phone);
  if (!buyerKey) return [];
  // `||`, not `??`: an empty string would fail the envelope's min length and retry forever.
  const loc = String(locale || order.locale || 'ar');
  const method = contractPaymentMethod(paymentMethod);
  // `order/created` is NOT a once-per-order event (COD mark-paid, COD delivery, payment confirms and
  // the stuck sweep all re-send it), so envelope ids are seeded by the ORDER, never by the source
  // event: every re-send is the same envelope and WhatsApp dedupes it.
  const out: Planned[] = [
    {
      seed: `order:${orderId}`,
      occurredAt: order.createdAt,
      input: {
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
          channel: order.source || 'web',
        },
      },
    },
  ];
  // Ask for a COD confirmation only while it can still matter: the order is a real COD order that
  // is still pending and unpaid. A re-sent `order/created` after "mark paid" or delivery must not
  // ask the buyer to confirm an order that is already settled.
  if (
    method === 'cod' &&
    order.status === 'pending' &&
    order.paymentStatus === 'unpaid' &&
    !order.payments.some(p => p.provider === 'cod')
  ) {
    throw new Error(`COD payment of order ${orderId} not visible yet`);
  }
  const awaitingCod =
    method === 'cod' &&
    order.status === 'pending' &&
    order.paymentStatus === 'unpaid' &&
    order.payments.some(p => p.provider === 'cod' && p.status === 'cod_pending');
  if (awaitingCod) {
    out.push({
      seed: `cod:${orderId}`,
      occurredAt: order.createdAt,
      input: {
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
      },
    });
  }
  return out;
}

async function shipmentEvent(event: SourceEvent): Promise<Planned[]> {
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
  const phone = phoneOf(order?.shippingAddress);
  const parsedAt = d.updatedAt ? new Date(d.updatedAt) : new Date();
  const updatedAt = Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt;
  return [
    {
      seed: `shipment:${d.shipmentId}:${d.status}`,
      occurredAt: updatedAt,
      input: {
        type: 'shipment.updated',
        storeId: d.storeId,
        data: {
          orderId: d.orderId,
          shipmentId: d.shipmentId,
          status: d.status,
          ...(d.trackingUrl && /^https?:\/\//.test(d.trackingUrl)
            ? { trackingUrl: d.trackingUrl }
            : {}),
          updatedAt: updatedAt.toISOString(),
          // The customer-facing template needs these; WhatsApp otherwise looks the order up by id.
          ...(phone ? { phoneE164: phone } : {}),
          ...(order?.locale ? { locale: order.locale } : {}),
          ...(order?.orderNumber ? { orderNumber: order.orderNumber } : {}),
        },
      },
    },
  ];
}

async function statusEvent(event: SourceEvent): Promise<Planned[]> {
  const d = (event.data ?? {}) as {
    orderId?: string;
    storeId?: string;
    status?: string;
    requestedAt?: string;
  };
  if (!d.orderId || !d.storeId || !d.status) return [];
  // `updatedAt` is when THIS transition was requested (carried in the event by updateStatus and
  // the stuck sweep), not when this job ran and not the order's CURRENT stamp: WhatsApp drops an
  // older entity event by it, so two transitions processed out of order must keep their own times.
  // An event from an old sender without it falls back to the order's stamp only while that stamp is
  // still for THIS status.
  let at = d.requestedAt ? new Date(d.requestedAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    const order = await runInTenantContext(d.storeId, () =>
      prisma.order.findUnique({
        where: { id: d.orderId!, storeId: d.storeId! },
        select: {
          statusFanoutRequestedAt: true,
          statusFanoutRequestedStatus: true,
          updatedAt: true,
        },
      })
    );
    if (!order) throw new Error(`order ${d.orderId} not visible yet`);
    at =
      order.statusFanoutRequestedStatus === d.status && order.statusFanoutRequestedAt
        ? order.statusFanoutRequestedAt
        : order.updatedAt;
  }
  return [
    {
      seed: `status:${d.orderId}:${d.status}:${at.getTime()}`,
      occurredAt: at,
      input: {
        type: 'order.status_changed',
        storeId: d.storeId,
        data: { orderId: d.orderId, status: d.status, updatedAt: at.toISOString() },
      },
    },
  ];
}

export async function emitStoreEventsFor(event: SourceEvent): Promise<number> {
  const storeId = (event.data as { storeId?: string } | undefined)?.storeId;
  if (!storeId || !(await isWhatsAppLinked(storeId))) return 0;
  const planned =
    event.name === 'order/created'
      ? await orderEvents(event)
      : event.name === 'shipment/status-updated'
        ? await shipmentEvent(event)
        : event.name === 'order/status-changed'
          ? await statusEvent(event)
          : [];
  if (planned.length === 0) return 0;
  const events = await Promise.all(
    planned.map(p => buildStoreEvent(p.input, { seed: p.seed, occurredAt: p.occurredAt }))
  );
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
