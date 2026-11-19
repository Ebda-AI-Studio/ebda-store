/**
 * Source events -> `commerce_outcomes` inputs. Pure of I/O except the injected `CiSource` reads (one row
 * by id each) and the buyer-key HMAC. Every input carries a SEED derived from the occurrence (order id,
 * shipment id + kind + attempt no), never from the source event or the clock, so a re-sent Inngest event,
 * a COD mark-paid re-sending `order/created`, or a carrier poll that returns the same status twice all
 * yield the SAME eventId.
 *
 * What is deliberately NOT emitted here: a COD confirmed/refused/no-reply that arrived from WhatsApp.
 * Ebda Chat already emitted that outcome itself (contract section 8, #218); emitting it again would
 * double every row. Detected by the `order.cod_outcome` audit row the WhatsApp consumer writes.
 */
import { buyerKeyFor } from '@ebda/shared';
import {
  ONBOARDING_HELP_KINDS,
  ONBOARDING_STEPS,
  type CiOutcomeInput,
  type PAYMENT_FAILURE_CODES,
} from './envelope';
import { channelOf, isEarliest, openStep, qualifiedAt } from './activation';
import { mapReturnReason, scrubFreeText } from './return-reason';
import type { CiOrderFacts, CiShipmentFacts, CiSource, CiStoreSetupFacts } from './source';

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
    ...(o.paymentStatus === 'paid' ? await planActivationMilestones(ctx, o, ['first_order']) : []),
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
  const milestones: Array<'first_order' | 'first_fulfilled_order'> = [];
  if (['confirmed', 'processing', 'shipped', 'delivered'].includes(e.status))
    milestones.push('first_order');
  if (e.status === 'delivered') milestones.push('first_fulfilled_order');
  else if (o.paymentStatus === 'paid' && !milestones.length) milestones.push('first_order');
  out.push(...(await planActivationMilestones(ctx, o, milestones)));

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
        out.push(
          ...(await planActivationMilestones(ctx, o, ['first_order', 'first_fulfilled_order']))
        );
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
            shippingFeeMinor: o.shippingMinor,
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
            shippingFeeMinor: o.shippingMinor,
          },
        });
        break;
      }
    }
  }
  return out;
}

const failureCodeOf = (kind: string): (typeof PAYMENT_FAILURE_CODES)[number] =>
  kind === 'expired' ? 'expired' : kind === 'cancelled' ? 'cancelled' : 'declined';
const validDate = (iso: unknown): Date => {
  const d = typeof iso === 'string' ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
};

/**
 * `ci/payment-failed`: the gateway (pull-side confirm) or its webhook settled a payment as failed,
 * expired or cancelled. Sent once by the call that won the order's `unpaid -> failed` claim, and the seed is
 * the payment id, so a replay is harmless. `failureCode` is a closed code: the provider's own message is
 * never read here.
 */
export async function planPaymentFailed(
  ctx: PlanCtx,
  e: { storeId?: string; orderId?: string; paymentId?: string; kind?: string; at?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.orderId || !e.paymentId) return [];
  const o = await ctx.source.order(e.storeId, e.orderId);
  if (!o) throw new Error(`order ${e.orderId} not visible yet`);
  const p = o.payments.find(x => x.id === e.paymentId) ?? o.payments[0];
  if (!p) return [];
  return [
    {
      type: 'payment.failed',
      seed: `payment-failed:${e.paymentId}`,
      occurredAt: validDate(e.at),
      ...base(o, await buyerKeyOf(ctx, o)),
      data: {
        provider: p.provider,
        methodKind: p.method ?? p.provider,
        totalMinor: o.totalMinor,
        failureCode: failureCodeOf(e.kind ?? ''),
      },
    },
  ];
}

/**
 * `ci/cart-reminder-sent`: a recovery message went out. There is no order yet and the cart's contact is a
 * reminder consent, not a CI one, so the event carries no buyer key at all.
 */
export async function planCartReminder(
  ctx: PlanCtx,
  e: { storeId?: string; abandonedCartId?: string; channel?: string; step?: number; at?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.abandonedCartId) return [];
  const step = e.step && e.step >= 1 && e.step <= 3 ? e.step : 1;
  const channel = e.channel === 'email' ? 'email' : 'notification';
  return [
    {
      type: 'cart.abandoned',
      seed: `cart:${e.abandonedCartId}:${channel}:${step}`,
      occurredAt: validDate(e.at),
      storeId: e.storeId,
      orderId: null,
      buyerKey: null,
      xstore: await ctx.source.storeCiSharing(e.storeId),
      data: { channel, step },
    },
  ];
}

/** `ci/cart-recovered`: only when a reminder had actually gone out first (otherwise it was not recovered BY one). */
export async function planCartRecovered(
  ctx: PlanCtx,
  e: { storeId?: string; abandonedCartId?: string; orderId?: string; at?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.abandonedCartId || !e.orderId) return [];
  const cart = await ctx.source.abandonedCart(e.storeId, e.abandonedCartId);
  if (!cart) throw new Error(`abandoned cart ${e.abandonedCartId} not visible yet`);
  if (!cart.firstReminderAt || !cart.firstChannel) return [];
  const o = await ctx.source.order(e.storeId, e.orderId);
  if (!o) throw new Error(`order ${e.orderId} not visible yet`);
  const at = cart.recoveredAt ?? validDate(e.at);
  return [
    {
      type: 'cart.recovered',
      seed: `cart:${cart.id}:recovered`,
      occurredAt: at,
      ...base(o, await buyerKeyOf(ctx, o)),
      data: { channel: cart.firstChannel, hoursToRecover: hoursBetween(cart.firstReminderAt, at) },
    },
  ];
}

const secondsSinceSignup = (facts: Pick<CiStoreSetupFacts, 'ownerSignupAt'>, at: Date) =>
  facts.ownerSignupAt
    ? Math.max(0, Math.round((at.getTime() - facts.ownerSignupAt.getTime()) / 1000))
    : null;

/** `ci/onboarding-step`: a milestone of the store setup. One event per (store, step), ever. */
export async function planOnboardingStep(
  ctx: PlanCtx,
  e: { storeId?: string; step?: string; at?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.step || !(ONBOARDING_STEPS as readonly string[]).includes(e.step)) return [];
  const facts = await ctx.source.storeSetup(e.storeId);
  if (!facts) throw new Error(`store ${e.storeId} not visible yet`);
  const at = validDate(e.at);
  return [
    {
      type: 'merchant.onboarding_step',
      seed: `onboarding:${e.storeId}:${e.step}`,
      occurredAt: at,
      storeId: e.storeId,
      orderId: null,
      buyerKey: null,
      xstore: facts.ciSharing,
      data: {
        step: e.step as (typeof ONBOARDING_STEPS)[number],
        secondsSinceSignup: secondsSinceSignup(facts, at),
        template: facts.template,
      },
    },
  ];
}

/**
 * Activation milestones (Ruling ACT-1), derived from the order events the stream already carries: `first_order` when this
 * order is the store's earliest real (paid, or COD-confirmed) order, `first_fulfilled_order` when it is the earliest
 * real order that was delivered. The seed is per store and step, so the stream holds ONE row each, ever; and a later
 * order is not even planned because an earlier real one is found among its peers. Demo stores and orders placed from the
 * admin by anyone but the owner never count.
 */
export async function planActivationMilestones(
  ctx: PlanCtx,
  o: CiOrderFacts,
  kinds: Array<'first_order' | 'first_fulfilled_order'>
): Promise<CiOutcomeInput[]> {
  if (!kinds.length || !o.activation) return [];
  const setup = await ctx.source.storeSetup(o.storeId);
  if (!setup || setup.isDemo) return [];
  const ownerId = setup.ownerId ?? null;
  const a = o.activation;
  const out: CiOutcomeInput[] = [];
  const emit = (step: 'first_order' | 'first_fulfilled_order', at: Date) =>
    out.push({
      type: 'merchant.onboarding_step',
      seed: `onboarding:${o.storeId}:${step}`,
      occurredAt: at,
      storeId: o.storeId,
      orderId: null,
      buyerKey: null,
      xstore: setup.ciSharing,
      data: {
        step,
        secondsSinceSignup: secondsSinceSignup(setup, at),
        template: setup.template,
        channel: step === 'first_order' ? channelOf(a) : null,
        orderId: o.id,
      },
    });
  if (kinds.includes('first_order') && qualifiedAt(a, ownerId)) {
    const peers = await ctx.source.activationPeers(o.storeId, o.id, 'qualified');
    const first = isEarliest(a, peers, x => qualifiedAt(x, ownerId));
    if (first) emit('first_order', first.at);
  }
  if (kinds.includes('first_fulfilled_order') && qualifiedAt(a, ownerId) && a.fulfilledAt) {
    const peers = await ctx.source.activationPeers(o.storeId, o.id, 'fulfilled');
    const when = (x: typeof a) => (qualifiedAt(x, ownerId) ? x.fulfilledAt : null);
    const first = isEarliest(a, peers, when);
    if (first) emit('first_fulfilled_order', first.at);
  }
  return out;
}

/**
 * `ci/onboarding-help`: the merchant used the Ebda AI assistant, or a super admin wrote to the store before it went live.
 * The step is the FIRST milestone not yet reached at that moment (read from the store's own state, not from the
 * event), so "help needed at payment methods" means the merchant was stuck there. A store past the 30-day onboarding
 * window, a demo store and a store with every step done produce nothing. One row per (store, step, kind), ever.
 */
export async function planOnboardingHelp(
  ctx: PlanCtx,
  e: { storeId?: string; kind?: string; at?: string }
): Promise<CiOutcomeInput[]> {
  if (!e.storeId || !e.kind || !(ONBOARDING_HELP_KINDS as readonly string[]).includes(e.kind))
    return [];
  const kind = e.kind as (typeof ONBOARDING_HELP_KINDS)[number];
  const p = await ctx.source.onboardingProgress(e.storeId);
  if (!p) throw new Error(`store ${e.storeId} not visible yet`);
  if (p.isDemo) return [];
  const at = validDate(e.at);
  const step = openStep({
    storeAgeDays: p.createdAt ? (at.getTime() - p.createdAt.getTime()) / 86_400_000 : null,
    paymentConfirmed: p.paymentConfirmed,
    live: p.live,
    hasFirstOrder: p.hasFirstOrder,
    hasFirstFulfilled: p.hasFirstFulfilled,
  });
  // A super admin's write only counts as help before the store is live (after that it is routine operation).
  if (!step || (kind === 'super_admin_action' && p.live)) return [];
  const facts = await ctx.source.storeSetup(e.storeId);
  return [
    {
      type: 'merchant.onboarding_help',
      seed: `onboarding-help:${e.storeId}:${step}:${kind}`,
      occurredAt: at,
      storeId: e.storeId,
      orderId: null,
      buyerKey: null,
      xstore: facts?.ciSharing ?? false,
      data: { step, kind },
    },
  ];
}

export type { CiShipmentFacts };
