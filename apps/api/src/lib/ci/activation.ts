/**
 * Merchant activation, the pure half (Ruling ACT-1): which orders count as a store's first real order / first fulfilled order,
 * and which setup step was open when a merchant needed help. No I/O: `planner.ts` feeds it facts read by `CiSource`.
 *
 * "Real" = an order a shopper placed (or the owner keyed in from their own admin) that was paid, or that a COD confirmation
 * moved forward. Never counted: a demo store's orders, and an order placed by someone who is not the store owner from the admin
 * (store staff, a super admin acting on the store). Those are not demand.
 */
import type { FIRST_ORDER_CHANNELS, ONBOARDING_STEPS } from './envelope';

/** An order reduced to what the activation rules read. Built from a full `CiOrderFacts` or from a peer query. */
export interface CiActivationOrder {
  id: string;
  /** `orders.source`: web | agent | whatsapp | checkout. */
  source: string;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  /** True when the first payment row is cash on delivery. */
  cod: boolean;
  paidAt: Date | null;
  /** First time the order moved past `pending` on a merchant's confirmation or later (COD). */
  advancedAt: Date | null;
  /** Delivered shipment, or the order marked delivered (pickup and digital orders have no shipment). */
  fulfilledAt: Date | null;
  /** The user who placed it from the admin (the `stock_not_taken` row `createAdminOrder` writes), else null. */
  adminActorId: string | null;
}

type FirstOrderChannel = (typeof FIRST_ORDER_CHANNELS)[number];
type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const ADVANCED = new Set(['confirmed', 'processing', 'shipped', 'delivered']);
const STOCK_NOT_TAKEN_ROW = 'stock_not_taken';
/** Peers read per decision. More than this many earlier real orders means this one is not the first anyway. */
export const ACTIVATION_PEER_LIMIT = 10;
/** Help only counts while the store is this young: older stores are established, not onboarding. */
const ONBOARDING_WINDOW_DAYS = 30;

interface ActivationInputs {
  id: string;
  source: string | null;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  payments: Array<{ provider: string; status: string; paidAt: Date | null }>;
  transitions: Array<{ from: string | null; to: string; at: Date; actorId: string | null }>;
  shipmentDeliveredAt: Date | null;
}

export function activationOf(o: ActivationInputs): CiActivationOrder {
  const paid = o.payments.find(p => p.status === 'completed' || p.paidAt);
  const advanced = o.transitions.find(t => ADVANCED.has(t.to));
  const delivered = o.transitions.find(t => t.to === 'delivered');
  const marker = o.transitions.find(t => t.to === STOCK_NOT_TAKEN_ROW && t.actorId);
  return {
    id: o.id,
    source: o.source || 'web',
    status: o.status,
    paymentStatus: o.paymentStatus,
    createdAt: o.createdAt,
    cod: o.payments[0]?.provider === 'cod',
    paidAt: paid?.paidAt ?? null,
    advancedAt: advanced?.at ?? (ADVANCED.has(o.status) ? o.createdAt : null),
    fulfilledAt:
      o.shipmentDeliveredAt ?? delivered?.at ?? (o.status === 'delivered' ? o.createdAt : null),
    adminActorId: marker?.actorId ?? null,
  };
}

/** Placed from the admin by someone other than the owner: staff, or a super admin acting on the store. */
const isStaffOrder = (a: CiActivationOrder, ownerId: string | null): boolean =>
  a.adminActorId != null && a.adminActorId !== ownerId;

export function channelOf(a: CiActivationOrder): FirstOrderChannel {
  if (a.adminActorId) return 'admin';
  return a.source === 'whatsapp' ? 'whatsapp' : 'storefront';
}

/** When the order became a real order: paid, or (COD) confirmed. Null while it is neither, and for a cancelled or refunded one. */
export function qualifiedAt(a: CiActivationOrder, ownerId: string | null): Date | null {
  if (isStaffOrder(a, ownerId)) return null;
  if (a.status === 'cancelled' || a.status === 'refunded') return null;
  if (a.paymentStatus === 'paid') return a.paidAt ?? a.createdAt;
  if (a.cod) return a.advancedAt;
  return null;
}

const byTimeThenId = (x: { at: Date; id: string }, y: { at: Date; id: string }) =>
  x.at.getTime() - y.at.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Is `me` the earliest of `me` + `peers` by `when`? Same instant: the lower id wins, so two orders paid in the same
 * millisecond cannot both claim "first". A peer that never qualifies does not count.
 */
export function isEarliest(
  me: CiActivationOrder,
  peers: CiActivationOrder[],
  when: (a: CiActivationOrder) => Date | null
): { at: Date } | null {
  const mine = when(me);
  if (!mine) return null;
  const rivals = peers
    .filter(p => p.id !== me.id)
    .map(p => ({ id: p.id, at: when(p) }))
    .filter((p): p is { id: string; at: Date } => p.at != null);
  const first = [...rivals, { id: me.id, at: mine }].sort(byTimeThenId)[0]!;
  return first.id === me.id ? { at: mine } : null;
}

/**
 * The step a merchant is stuck on: the first milestone not yet reached. `null` when every step is done, or the store is
 * past the onboarding window (no help signal then). Pure on facts the source read.
 */
export function openStep(f: {
  storeAgeDays: number | null;
  paymentConfirmed: boolean;
  live: boolean;
  hasFirstOrder: boolean;
  hasFirstFulfilled: boolean;
}): OnboardingStep | null {
  if (f.storeAgeDays != null && f.storeAgeDays > ONBOARDING_WINDOW_DAYS) return null;
  if (!f.paymentConfirmed) return 'payment_methods';
  if (!f.live) return 'went_live';
  if (!f.hasFirstOrder) return 'first_order';
  if (!f.hasFirstFulfilled) return 'first_fulfilled_order';
  return null;
}
