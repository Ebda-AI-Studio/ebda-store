import type { JobDef } from '../../jobs/types';
import { customerRow, customerRows, isLiveCustomer, pickSelected } from '../../customer-directory';
import { prisma, runInTenantContext, withStore } from '@ebda/database';
import { acrossStoresDb, readStoreDb } from '../../jobs/store-db';
import { alarmStoreId } from '../../jobs/store-scope';
import { BUYER_KEY_VERSION, buyerKeyFor, storefrontOrigin, toE164 } from '@ebda/shared';
import { signCartRestoreToken } from '../../cart-restore-token';
import { inngest } from '../client';
import { redis } from '../../../services/redis.service';
import logger from '../../logger';
import { suiteBuyerKeySecret } from '../../wa/config';
import { buildStoreEvent, sendStoreEvents, type StoreEventInput } from '../../wa/events';
import { isWhatsAppLinked, hasWhatsAppLinkRow } from '../../wa/link';
import { PLAN_CHANGED_EVENT, planChangedInput } from '../../wa/plan-state';
import { CATALOG_CHANGED_EVENT } from '../../wa/catalog-state';
import { WhatsAppConsentService } from '../../wa/consent';
import { CONSENT_CHANGED_EVENT, consentChangedInput } from '../../wa/consent-state';

/**
 * Store -> Ebda Chat events (contract 2026-10-24, section 4): order created, COD confirmation
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
  const order = await readStoreDb(storeId, db =>
    db.order.findUnique({ where: { id: orderId, storeId }, select: orderSelect })
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
  const order = await readStoreDb(d.storeId, db =>
    db.order.findUnique({
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

/** `cart.abandoned`: the abandoned-cart rule fired (a row was created for a shopper with a phone). */
async function cartEvent(event: SourceEvent): Promise<Planned[]> {
  const { storeId, cartId } = (event.data ?? {}) as { storeId?: string; cartId?: string };
  if (!storeId || !cartId) return [];
  const row = await readStoreDb(storeId, db =>
    db.abandonedCart.findFirst({
      where: { storeId, cartId },
      select: {
        status: true,
        recoveredAt: true,
        customerPhone: true,
        customerId: true,
        createdAt: true,
      },
    })
  );
  if (!row) throw new Error(`abandoned cart ${cartId} not visible yet`);
  // `Store` is a platform row, not a store-DO one: read it for either backend
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { slug: true, domain: true, settings: true },
    })
  );
  if (!store) throw new Error(`store ${storeId} not found`);
  // Stop-on-convert: a shopper who already ordered must not be chased.
  if (row.status === 'recovered' || row.recoveredAt) return [];
  // A deactivated / erased account is never chased (belt and braces next to the revoke on delete).
  if (row.customerId) {
    const doOwner = await customerRow(storeId, row.customerId);
    const owner =
      doOwner !== undefined
        ? doOwner
        : await runInTenantContext(storeId, () =>
            prisma.user.findFirst({
              where: { id: row.customerId!, storeId },
              select: { deletedAt: true },
            })
          );
    if (!owner || owner.deletedAt) return [];
  }
  const phone = toE164(row.customerPhone);
  if (!phone) return [];
  const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), phone);
  if (!buyerKey) return [];
  // Ruling WA-CONSENT-1: a cart reminder is MARKETING. No active consent = no cart.abandoned.
  // Checked here, at send time, so a revoke between capture and send also stops it.
  if (!(await WhatsAppConsentService.hasConsent(storeId, buyerKey))) return [];
  const lang = (store.settings as { defaultLanguage?: unknown } | null)?.defaultLanguage;
  return [
    {
      seed: `cart:${cartId}`,
      occurredAt: row.createdAt,
      input: {
        type: 'cart.abandoned',
        storeId,
        data: {
          cartId,
          buyerKey,
          phoneE164: phone,
          locale: lang === 'en' ? 'en' : 'ar',
          // Signed, expiring, store-scoped: re-attaches THIS cart for guests too (Ruling CART-RESTORE-1).
          recoveryUrl: `${storefrontOrigin(store)}/cart?restore=${encodeURIComponent(signCartRestoreToken(storeId, cartId))}`,
        },
      },
    },
  ];
}

/** `customer.erased` (PDPL): Ebda Chat deletes the contact and its messages. Only the hashed key travels. */
async function erasedEvent(event: SourceEvent): Promise<Planned[]> {
  const { storeId, buyerKey } = (event.data ?? {}) as { storeId?: string; buyerKey?: string };
  if (!storeId || !buyerKey) return [];
  return [
    {
      seed: `erased:${storeId}:${buyerKey}`,
      input: { type: 'customer.erased', storeId, data: { buyerKey } },
    },
  ];
}

const CATALOG_PAGE = 200;
const CATALOG_MAX = 5000;

/** `catalog.product_upserted` / `product_deleted`: the CURRENT state of each touched product. */
async function catalogEvents(event: SourceEvent): Promise<Planned[]> {
  const { storeId, productIds } = (event.data ?? {}) as {
    storeId?: string;
    productIds?: string[] | null;
  };
  if (!storeId) return [];
  let ids = productIds ?? null;
  if (!ids) {
    // Unknown or many: resync the store's whole catalog (capped; a store past the cap is resynced by
    // the link flow's catalog read over the bridge anyway).
    const all = await readStoreDb(storeId, db =>
      db.product.findMany({ where: { storeId }, select: { id: true }, take: CATALOG_MAX })
    );
    ids = all.map(p => p.id);
  }
  const out: Planned[] = [];
  for (let i = 0; i < ids.length; i += CATALOG_PAGE) {
    const chunk = ids.slice(i, i + CATALOG_PAGE);
    const rows = await readStoreDb(storeId, db =>
      db.product.findMany({
        where: { id: { in: chunk }, storeId },
        select: { id: true, updatedAt: true, deletedAt: true, variants: { select: { id: true } } },
      })
    );
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const productId of chunk) {
      const row = byId.get(productId);
      const gone = !row || row.deletedAt !== null;
      const at = (gone ? (row?.deletedAt ?? new Date()) : row.updatedAt) as Date;
      out.push({
        seed: `catalog:${productId}:${gone ? 'del' : 'up'}:${at.getTime()}`,
        occurredAt: at,
        input: {
          type: gone ? 'catalog.product_deleted' : 'catalog.product_upserted',
          storeId,
          data: {
            productId,
            variantIds: row?.variants.map(v => v.id) ?? [],
            updatedAt: at.toISOString(),
          },
        },
      });
    }
  }
  return out;
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
    const order = await readStoreDb(d.storeId, db =>
      db.order.findUnique({
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

/** `store.plan_changed`: for any store that has a WhatsApp link row (linked now or ever), current state. */
async function planEvent(event: SourceEvent): Promise<Planned[]> {
  const storeId = (event.data as { storeId?: string } | undefined)?.storeId;
  if (!storeId) return [];
  const p = await planChangedInput(storeId);
  return p ? [{ input: p.input, seed: p.seed }] : [];
}

const CONSENT_BACKFILL_KEY = 'wa:consent-backfill:v1.1';

/**
 * Re-send the current consent state of this store's rows changed within `sinceMs` (0 = every row).
 * Used by the 12-hourly reconcile and for the one-time v1.1 backfill. Idempotent by envelope id.
 */
export async function resendConsentFor(storeId: string, sinceMs: number): Promise<number> {
  const rows = await readStoreDb(storeId, db =>
    db.storeWhatsAppConsent.findMany({
      where: {
        storeId,
        ...(sinceMs > 0 ? { updatedAt: { gte: new Date(Date.now() - sinceMs) } } : {}),
      },
      select: { buyerKey: true },
    })
  );
  let n = 0;
  for (const r of rows) {
    n += await emitStoreEventsFor({
      name: CONSENT_CHANGED_EVENT,
      data: { storeId, buyerKey: r.buyerKey },
    });
  }
  return n;
}

export async function emitStoreEventsFor(event: SourceEvent): Promise<number> {
  const storeId = (event.data as { storeId?: string } | undefined)?.storeId;
  if (!storeId) return 0;
  // An erasure goes to Ebda Chat for any store it knows (a link row), linked or not: the
  // contact may outlive an unlink, and it must be deleted either way.
  if (event.name === 'account/erased') {
    if (!(await hasWhatsAppLinkRow(storeId))) return 0;
    const planned = await erasedEvent(event);
    const events = await Promise.all(planned.map(p => buildStoreEvent(p.input, { seed: p.seed })));
    await sendStoreEvents(events);
    return events.length;
  }
  // Plan state goes to Ebda Chat for every store it knows (it holds a link row), including a
  // store that was unlinked or downgraded: that is exactly when the gate must hear about it.
  if (event.name === PLAN_CHANGED_EVENT) {
    if (!(await hasWhatsAppLinkRow(storeId))) return 0;
    const planned = await planEvent(event);
    const events = await Promise.all(planned.map(p => buildStoreEvent(p.input, { seed: p.seed })));
    await sendStoreEvents(events);
    return events.length;
  }
  // Consent state goes to Ebda Chat for every store it knows (a link row), also when unlinked:
  // an opt-out must reach it either way.
  if (event.name === CONSENT_CHANGED_EVENT) {
    const buyerKey = (event.data as { buyerKey?: string }).buyerKey;
    if (!buyerKey || !(await hasWhatsAppLinkRow(storeId))) return 0;
    const p = await consentChangedInput(storeId, buyerKey);
    await sendStoreEvents([
      await buildStoreEvent(p.input, { seed: p.seed, occurredAt: p.occurredAt }),
    ]);
    return 1;
  }
  if (!(await isWhatsAppLinked(storeId))) return 0;
  const planned =
    event.name === 'order/created'
      ? await orderEvents(event)
      : event.name === 'shipment/status-updated'
        ? await shipmentEvent(event)
        : event.name === 'order/status-changed'
          ? await statusEvent(event)
          : event.name === 'cart/abandoned'
            ? await cartEvent(event)
            : event.name === CATALOG_CHANGED_EVENT
              ? await catalogEvents(event)
              : [];
  if (planned.length === 0) return 0;
  const events = await Promise.all(
    planned.map(p => buildStoreEvent(p.input, { seed: p.seed, occurredAt: p.occurredAt }))
  );
  await sendStoreEvents(events);
  return events.length;
}

export const waStoreEvents: JobDef = inngest.createFunction(
  {
    id: 'wa-store-events',
    name: 'Store -> Ebda Chat events',
    retries: 4,
    triggers: [
      { event: 'order/created' },
      { event: 'order/status-changed' },
      { event: 'shipment/status-updated' },
      { event: PLAN_CHANGED_EVENT },
      { event: 'cart/abandoned' },
      { event: 'account/erased' },
      { event: CATALOG_CHANGED_EVENT },
      { event: CONSENT_CHANGED_EVENT },
    ],
  },
  async ({ event, step }) => {
    const sent = await step.run('emit', () => emitStoreEventsFor(event as SourceEvent));
    return { sent, keyVersion: BUYER_KEY_VERSION };
  }
);

/**
 * Backstop for `store.plan_changed` (an entitlement is a NEVER-stale class: the per-write observer
 * is the mechanism, this is the net under it): every 12 hours the CURRENT plan state of every store
 * that has a WhatsApp link row is re-sent. Same state = same envelope id, so a store whose state did
 * not change costs the consumer one deduped message; one that was missed is corrected within hours.
 */
export const waPlanSync: JobDef = inngest.createFunction(
  {
    id: 'wa-plan-sync',
    name: 'Ebda Chat: plan state reconcile (12-hourly)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '41 */12 * * *' }],
  },
  async ({ event, step }) => {
    // Idle exit BEFORE any step: most ticks find no store that ever linked WhatsApp (one execution).
    // The cron run lists the Postgres stores; a DO store runs on its own alarm and reads its link row from its DO (Ruling CF-JOBS-4).
    const only = alarmStoreId(event);
    const linked: string[] = [];
    await acrossStoresDb(event, async (storeId, db) => {
      const row = await db.storeWhatsAppLink.findUnique({
        where: { storeId },
        select: { storeId: true },
      });
      if (row) linked.push(storeId);
    });
    if (linked.length === 0) return { sent: 0 };
    // The v1.1 backfill is once per store: the cron run shares one flag for every store it visits, an alarm run (one store) keeps its own
    const backfillKey = only ? `${CONSENT_BACKFILL_KEY}:${only}` : CONSENT_BACKFILL_KEY;
    const backfill = !(await redis.exists(backfillKey));
    const sinceMs = backfill ? 0 : 36 * 3600 * 1000;
    const sent = await step.run('sweep', async () => {
      let n = 0;
      for (const storeId of linked) {
        n += await emitStoreEventsFor({ name: PLAN_CHANGED_EVENT, data: { storeId } });
        // Net under the consent observer too: re-send the consent state that changed recently (and,
        // ONCE, every row: the v1.1 backfill). Same state = same envelope id, so this is idempotent.
        n += await resendConsentFor(storeId, sinceMs);
      }
      if (backfill) await redis.set(backfillKey, '1', 365 * 24 * 3600);
      return n;
    });
    return { sent };
  }
);
