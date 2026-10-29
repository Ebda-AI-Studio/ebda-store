/**
 * Source events -> `commerce_outcomes` inputs. Pure of I/O except the injected `CiSource` reads (one row
 * by id each) and the buyer-key HMAC. Every input carries a SEED derived from the occurrence (order id,
 * shipment id + kind + attempt no), never from the source event or the clock, so a re-sent Inngest event,
 * a COD mark-paid re-sending `order/created`, or a carrier poll that returns the same status twice all
 * yield the SAME eventId.
 *
 * What is deliberately NOT emitted here: a COD confirmed/refused/no-reply that arrived from WhatsApp.
 * Ebda WhatsApp already emitted that outcome itself (contract section 8, #218); emitting it again would
 * double every row. Detected by the `order.cod_outcome` audit row the WhatsApp consumer writes.
 */
import { buyerKeyFor } from '@ebda/shared';
import type { CiOutcomeInput } from './envelope';
import { mapReturnReason, scrubFreeText } from './return-reason';
import type { CiOrderFacts, CiShipmentFacts, CiSource } from './source';

const HOUR = 3_600_000;
const hoursBetween = (a: Date, b: Date) =>
  Math.max(0, Math.round(((b.getTime() - a.getTime()) / HOUR) * 100) / 100);

export interface PlanCtx {
  source: CiSource;
  /** SUITE_BUYER_KEY_SECRET. */
  secret: string;
}

/** Wire shape of the optional `ci` block that applyTrackingEntries adds to `shipment/status-updated`. */
export interface ShipmentCiMark {
  kind: 'picked_up' | 'attempted' | 'delivered' | 'returned';
  at: string;
  attemptNo?: number;
  reasonRaw?: string | null;
}

async function buyerKeyOf(ctx: PlanCtx, o: CiOrderFacts): Promise<string | null> {
  return o.phoneE164 ? buyerKeyFor(ctx.secret, o.phoneE164) : null;
}

const isCod = (o: CiOrderFacts) => o.payments.some(p => p.provider === 'cod');
const paymentMethod = (o: CiOrderFacts) => o.payments[0]?.provider ?? 'unknown';

function base(o: CiOrderFacts, buyerKey: string | null) {
  return { storeId: o.storeId, orderId: o.id, buyerKey, xstore: o.ciSharing };
}

function paymentCaptured(o: CiOrderFacts, buyerKey: string | null): CiOutcomeInput[] {
  if (o.paymentStatus !== 'paid') return [];
  const paid = o.payments.find(p => p.status === 'completed' || p.paidAt) ?? o.payments[0];
  if (!paid) return [];
  return [
    {
      type: 'payment.captured',
      seed: `payment:${o.id}`,
      occurredAt: paid.paidAt ?? o.createdAt,
      ...base(o, buyerKey),
      data: {
        provider: paid.provider,
        methodKind: paid.method ?? paid.provider,
        totalMinor: o.totalMinor,
        failureCode: null,
      },
    },
  ];
}

/** `order/created` (re-sent by COD mark-paid, payment confirms and the stuck sweep: the seeds make that harmless). */
export async function planOrderCreated(
  ctx: PlanCtx,
  e: { storeId?: string; orderId?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.orderId) return [];
  const o = await ctx.source.order(e.storeId, e.orderId);
  if (!o) throw new Error(`order ${e.orderId} not visible yet`); // may be sent inside the request tx: retry
  const buyerKey = await buyerKeyOf(ctx, o);
  await ctx.source.stampOrder(o.storeId, o.id, { areaKey: o.area.areaKey, buyerKey });
  const prior = buyerKey
    ? await ctx.source.priorOrdersByBuyer(o.storeId, buyerKey, o.createdAt, o.id)
    : null;
  return [
    {
      type: 'order.placed',
      seed: `order:${o.id}`,
      occurredAt: o.createdAt,
      ...base(o, buyerKey),
      data: {
        totalMinor: o.totalMinor,
        currency: o.currency,
        paymentMethod: paymentMethod(o),
        channel: o.channel,
        itemCount: o.itemCount,
        areaKey: o.area.areaKey,
        isFirstOrderForBuyerInStore: prior == null ? null : prior === 0,
      },
    },
    ...paymentCaptured(o, buyerKey),
  ];
}

/** `order/status-changed`. Reads the order's own transition rows, so the answer does not depend on event order. */
export async function planOrderStatusChanged(
  ctx: PlanCtx,
  e: { storeId?: string; orderId?: string; status?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.orderId || !e.status) return [];
  const o = await ctx.source.order(e.storeId, e.orderId);
  if (!o) throw new Error(`order ${e.orderId} not visible yet`);
  const buyerKey = await buyerKeyOf(ctx, o);
  const out: CiOutcomeInput[] = [...paymentCaptured(o, buyerKey)];
  const when = (to: string) => o.transitions.filter(t => t.to === to).at(-1);

  if (e.status === 'confirmed' && isCod(o)) {
    if (!(await ctx.source.hasWhatsAppCodOutcome(o.storeId, o.id))) {
      const t = when('confirmed');
      out.push({
        type: 'order.cod_confirmed',
        seed: `cod:${o.id}`,
        occurredAt: t?.at ?? new Date(),
        ...base(o, buyerKey),
        data: {
          confirmedVia: 'call',
          minutesToConfirm: t
            ? Math.round((t.at.getTime() - o.createdAt.getTime()) / 60_000)
            : null,
          areaKey: o.area.areaKey,
        },
      });
    }
  }

  if (e.status === 'cancelled' || e.status === 'refunded') {
    const wa = isCod(o) ? await ctx.source.hasWhatsAppCodOutcome(o.storeId, o.id) : false;
    const returned = o.shipment?.returnedAt != null;
    const t = when(e.status);
    const reason = wa ? 'cod_refused' : returned ? 'returned_to_sender' : 'unspecified';
    const byActor = wa ? 'customer' : returned ? 'system' : t?.actorId ? 'merchant' : 'unknown';
    out.push({
      type: e.status === 'cancelled' ? 'order.cancelled' : 'order.refunded',
      seed: `order:${o.id}:${e.status}`,
      occurredAt: t?.at ?? new Date(),
      ...base(o, buyerKey),
      data: { reason, byActor, totalMinor: o.totalMinor },
    });
    // A COD order cancelled before it was ever confirmed and before a courier had it: the window closed
    // unanswered (not a refusal after the parcel went out, and not one WhatsApp already reported).
    const everConfirmed = o.transitions.some(x => x.to === 'confirmed');
    if (
      e.status === 'cancelled' &&
      isCod(o) &&
      !wa &&
      !everConfirmed &&
      o.shipment?.pickedUpAt == null &&
      !returned
    ) {
      out.push({
        type: 'order.cod_unconfirmed',
        seed: `cod:${o.id}`,
        occurredAt: t?.at ?? new Date(),
        ...base(o, buyerKey),
        data: { confirmedVia: 'none', minutesToConfirm: null, areaKey: o.area.areaKey },
      });
    }
  }
  return out;
}

/** The booking succeeded (`ci/shipment-booked`). */
export async function planShipmentBooked(
  ctx: PlanCtx,
  e: { storeId?: string; shipmentId?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.shipmentId) return [];
  const s = await ctx.source.shipment(e.storeId, e.shipmentId);
  if (!s) throw new Error(`shipment ${e.shipmentId} not visible yet`);
  const o = await ctx.source.order(e.storeId, s.orderId);
  if (!o) throw new Error(`order ${s.orderId} not visible yet`);
  return [
    {
      type: 'shipment.created',
      seed: `shipment:${s.id}`,
      occurredAt: s.createdAt,
      ...base(o, await buyerKeyOf(ctx, o)),
      data: {
        carrier: s.carrier,
        codMinor: s.codMinor,
        areaKey: s.areaKey ?? o.area.areaKey,
        weightGrams: s.weightGrams,
        attemptsToBook: s.createAttempts,
      },
    },
  ];
}

/** `shipment/status-updated`, driven by the `ci` marks the status writer recorded (first-time only). */
export async function planShipmentUpdated(
  ctx: PlanCtx,
  e: { storeId?: string; shipmentId?: string; ci?: ShipmentCiMark[] }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.shipmentId || !e.ci?.length) return [];
  const s = await ctx.source.shipment(e.storeId, e.shipmentId);
  if (!s) throw new Error(`shipment ${e.shipmentId} not visible yet`);
  const o = await ctx.source.order(e.storeId, s.orderId);
  if (!o) throw new Error(`order ${s.orderId} not visible yet`);
  const b = base(o, await buyerKeyOf(ctx, o));
  const areaKey = s.areaKey ?? o.area.areaKey;
  const out: CiOutcomeInput[] = [];
  for (const m of e.ci) {
    const at = new Date(m.at);
    const occurredAt = Number.isNaN(at.getTime()) ? new Date() : at;
    const since = s.pickedUpAt ? hoursBetween(s.pickedUpAt, occurredAt) : null;
    switch (m.kind) {
      case 'picked_up':
        out.push({
          type: 'shipment.picked_up',
          seed: `shipment:${s.id}:picked_up`,
          occurredAt,
          ...b,
          data: { carrier: s.carrier, hoursSinceCreated: hoursBetween(s.createdAt, occurredAt) },
        });
        break;
      case 'attempted': {
        const raw = scrubFreeText(m.reasonRaw);
        out.push({
          type: 'shipment.attempted',
          seed: `shipment:${s.id}:attempt:${m.attemptNo ?? 0}`,
          occurredAt,
          ...b,
          data: {
            carrier: s.carrier,
            attemptNo: m.attemptNo ?? 1,
            reasonCode: raw ? mapReturnReason(s.carrier, raw).code : null,
            areaKey,
          },
        });
        break;
      }
      case 'delivered':
        out.push({
          type: 'shipment.delivered',
          seed: `shipment:${s.id}:delivered`,
          occurredAt,
          ...b,
          data: {
            carrier: s.carrier,
            codMinor: s.codMinor,
            hoursSincePickup: since,
            attempts: s.deliveryAttempts,
            areaKey,
          },
        });
        break;
      case 'returned': {
        const reason = s.returnReasonCode
          ? {
              code: s.returnReasonCode as ReturnType<typeof mapReturnReason>['code'],
              raw: s.returnReasonRaw,
            }
          : mapReturnReason(s.carrier, m.reasonRaw ?? s.returnReasonRaw);
        out.push({
          type: 'shipment.returned',
          seed: `shipment:${s.id}:returned`,
          occurredAt,
          ...b,
          data: {
            carrier: s.carrier,
            codMinor: s.codMinor,
            returnReasonCode: reason.code,
            returnReasonRaw: reason.raw,
            attempts: s.deliveryAttempts,
            hoursSincePickup: since,
            areaKey,
          },
        });
        break;
      }
    }
  }
  return out;
}

export type { CiShipmentFacts };
