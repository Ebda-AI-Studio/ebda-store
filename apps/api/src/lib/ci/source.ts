/**
 * What the CI planners read. A narrow interface so the planners do not know where the order lives:
 * today `prismaCiSource` (Postgres, one row per call, by id, under the store's tenant scope); after the
 * StoreDO cutover the repo layer supplies a StoreDO-backed one. No method scans a table.
 */
import { prisma, runInTenantContext, withUser } from '@ebda/database';
import { toE164 } from '@ebda/shared';
import { areaKeyFor, type AreaKeyResult } from './area-key';

export interface CiOrderFacts {
  id: string;
  storeId: string;
  totalMinor: number;
  /** What the buyer was charged for shipping (`orders.shipping`, piastres). */
  shippingMinor: number;
  currency: string;
  channel: string;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  itemCount: number;
  /** E.164 or null: the ONLY use of the phone is to compute `buyerKey`; it is never put in an event. */
  phoneE164: string | null;
  area: AreaKeyResult;
  payments: Array<{
    id: string;
    provider: string;
    method: string | null;
    status: string;
    paidAt: Date | null;
    failureReason: string | null;
  }>;
  transitions: Array<{ from: string | null; to: string; at: Date; actorId: string | null }>;
  shipment: { pickedUpAt: Date | null; returnedAt: Date | null } | null;
  ciSharing: boolean;
}

export interface CiShipmentFacts {
  id: string;
  orderId: string;
  carrier: string;
  codMinor: number;
  createdAt: Date;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  deliveryAttempts: number;
  createAttempts: number;
  weightGrams: number | null;
  areaKey: string | null;
  returnReasonCode: string | null;
  returnReasonRaw: string | null;
}

/** An abandoned-cart row, reduced to when reminders went out and when (if) the cart turned into an order. */
export interface CiAbandonedCartFacts {
  id: string;
  firstReminderAt: Date | null;
  /** Which sender reached the buyer FIRST: the push/SMS/WhatsApp steps, or the recovery email. */
  firstChannel: 'email' | 'notification' | null;
  recoveredAt: Date | null;
}

export interface CiStoreSetupFacts {
  /** When the owner's account was created (the signup), or null if unknown. */
  ownerSignupAt: Date | null;
  template: string | null;
  ciSharing: boolean;
}

export interface CiSource {
  order(storeId: string, orderId: string): Promise<CiOrderFacts | null>;
  shipment(storeId: string, shipmentId: string): Promise<CiShipmentFacts | null>;
  /** Did a WhatsApp COD answer already drive this order (Ebda WhatsApp emitted that outcome itself)? */
  hasWhatsAppCodOutcome(storeId: string, orderId: string): Promise<boolean>;
  /** Earlier orders by the same buyer in THIS store (a point count on (store, buyerKey)), or null if unknown. */
  priorOrdersByBuyer(
    storeId: string,
    buyerKey: string,
    before: Date,
    excludeOrderId: string
  ): Promise<number>;
  /** Idempotent: sets area/buyer only where still null. */
  stampOrder(
    storeId: string,
    orderId: string,
    v: { areaKey: string | null; buyerKey: string | null }
  ): Promise<void>;
  abandonedCart(storeId: string, abandonedCartId: string): Promise<CiAbandonedCartFacts | null>;
  storeSetup(storeId: string): Promise<CiStoreSetupFacts | null>;
  /** The shipment's own flag for ciSharing lookups of a shipment's store. */
  storeCiSharing(storeId: string): Promise<boolean>;
}

const toNum = (d: unknown): number | null => (d == null ? null : Number(d));

export const prismaCiSource: CiSource = {
  async order(storeId, orderId) {
    return runInTenantContext(storeId, async () => {
      const [o, store] = await Promise.all([
        prisma.order.findFirst({
          where: { id: orderId, storeId },
          select: {
            id: true,
            total: true,
            shipping: true,
            currency: true,
            source: true,
            status: true,
            paymentStatus: true,
            createdAt: true,
            shippingAddress: true,
            _count: { select: { items: true } },
            payments: {
              select: {
                id: true,
                provider: true,
                method: true,
                status: true,
                paidAt: true,
                failureReason: true,
              },
            },
            events: {
              orderBy: { createdAt: 'asc' },
              take: 50,
              select: { fromStatus: true, toStatus: true, createdAt: true, actorId: true },
            },
            shipment: { select: { pickedUpAt: true, returnedAt: true } },
          },
        }),
        prisma.store.findFirst({ where: { id: storeId }, select: { ciSharing: true } }),
      ]);
      if (!o) return null;
      const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      return {
        id: o.id,
        storeId,
        totalMinor: o.total,
        shippingMinor: o.shipping,
        currency: o.currency,
        channel: o.source || 'web',
        status: String(o.status),
        paymentStatus: String(o.paymentStatus),
        createdAt: o.createdAt,
        itemCount: o._count.items,
        phoneE164: toE164(str(a.phone)),
        area: areaKeyFor({
          country: str(a.country),
          state: str(a.state),
          city: str(a.city),
          area: str(a.area),
        }),
        payments: o.payments.map(p => ({ ...p, status: String(p.status) })),
        transitions: o.events.map(e => ({
          from: e.fromStatus,
          to: e.toStatus,
          at: e.createdAt,
          actorId: e.actorId,
        })),
        shipment: o.shipment,
        ciSharing: store?.ciSharing ?? false,
      };
    });
  },

  async shipment(storeId, shipmentId) {
    return runInTenantContext(storeId, async () => {
      const s = await prisma.shipment.findFirst({
        where: { id: shipmentId, storeId },
        select: {
          id: true,
          orderId: true,
          carrier: true,
          codAmount: true,
          createdAt: true,
          pickedUpAt: true,
          deliveredAt: true,
          returnedAt: true,
          deliveryAttempts: true,
          createAttempts: true,
          weight: true,
          areaKey: true,
          returnReasonCode: true,
          returnReasonRaw: true,
        },
      });
      if (!s) return null;
      const kg = toNum(s.weight);
      return {
        id: s.id,
        orderId: s.orderId,
        carrier: s.carrier,
        codMinor: s.codAmount,
        createdAt: s.createdAt,
        pickedUpAt: s.pickedUpAt,
        deliveredAt: s.deliveredAt,
        returnedAt: s.returnedAt,
        deliveryAttempts: s.deliveryAttempts,
        createAttempts: s.createAttempts,
        weightGrams: kg == null ? null : Math.round(kg * 1000),
        areaKey: s.areaKey,
        returnReasonCode: s.returnReasonCode,
        returnReasonRaw: s.returnReasonRaw,
      };
    });
  },

  async hasWhatsAppCodOutcome(storeId, orderId) {
    return runInTenantContext(storeId, async () => {
      const row = await prisma.auditLog.findFirst({
        where: {
          storeId,
          action: 'order.cod_outcome',
          resourceId: orderId,
          details: { path: ['source'], equals: 'whatsapp' },
        },
        select: { id: true },
      });
      return row != null;
    });
  },

  async priorOrdersByBuyer(storeId, buyerKey, before, excludeOrderId) {
    return runInTenantContext(storeId, () =>
      prisma.order.count({
        where: { storeId, buyerKey, id: { not: excludeOrderId }, createdAt: { lt: before } },
      })
    );
  },

  async stampOrder(storeId, orderId, v) {
    await runInTenantContext(storeId, async () => {
      await prisma.order.updateMany({
        where: { id: orderId, storeId, areaKey: null, buyerKey: null },
        data: { areaKey: v.areaKey, buyerKey: v.buyerKey },
      });
    });
  },

  async abandonedCart(storeId, abandonedCartId) {
    return runInTenantContext(storeId, async () => {
      const a = await prisma.abandonedCart.findFirst({
        where: { id: abandonedCartId, storeId },
        select: {
          id: true,
          step1SentAt: true,
          step2SentAt: true,
          step3SentAt: true,
          emailSentAt: true,
          recoveredAt: true,
        },
      });
      if (!a) return null;
      const push = [a.step1SentAt, a.step2SentAt, a.step3SentAt]
        .filter((d): d is Date => d != null)
        .sort((x, y) => x.getTime() - y.getTime())[0];
      const email = a.emailSentAt ?? undefined;
      const first = [push, email]
        .filter((d): d is Date => d != null)
        .sort((x, y) => x.getTime() - y.getTime())[0];
      return {
        id: a.id,
        firstReminderAt: first ?? null,
        firstChannel: !first ? null : first === email ? 'email' : 'notification',
        recoveredAt: a.recoveredAt,
      };
    });
  },

  async storeSetup(storeId) {
    const s = await runInTenantContext(storeId, () =>
      prisma.store.findFirst({
        where: { id: storeId },
        select: { template: true, ciSharing: true, ownerId: true },
      })
    );
    if (!s) return null;
    // `users` rows are visible only under their own user context (strict RLS), never the store's.
    const owner = await withUser(s.ownerId, tx =>
      tx.user.findFirst({ where: { id: s.ownerId }, select: { createdAt: true } })
    );
    return {
      ownerSignupAt: owner?.createdAt ?? null,
      template: s.template ? String(s.template) : null,
      ciSharing: s.ciSharing ?? false,
    };
  },

  async storeCiSharing(storeId) {
    return runInTenantContext(storeId, async () => {
      const s = await prisma.store.findFirst({
        where: { id: storeId },
        select: { ciSharing: true },
      });
      return s?.ciSharing ?? false;
    });
  },
};
