/**
 * What the CI planners read. A narrow interface so the planners do not know where the order lives:
 * today `prismaCiSource` (Postgres, one row per call, by id, under the store's tenant scope); after the
 * StoreDO cutover the repo layer supplies a StoreDO-backed one. No method scans a table.
 */
import { prisma, runInStoreScope, runInTenantContext } from '@ebda/database';
import { getAccountsBrief } from '../identity-client';
import { storeMoney, storeRepo, type StoreRepo, type StoreReads } from '../repo-factory';
import { toE164 } from '@ebda/shared';
import { areaKeyFor, type AreaKeyResult } from './area-key';
import {
  ACTIVATION_PEER_LIMIT,
  activationOf,
  qualifiedAt,
  type CiActivationOrder,
} from './activation';

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
  shipment: { pickedUpAt: Date | null; returnedAt: Date | null; deliveredAt?: Date | null } | null;
  /** The order's activation facts (`activation.ts`): provenance, who placed it from the admin, when it became real. */
  activation?: CiActivationOrder;
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
  /** Activation rules: a demo store's orders never count, and the owner's own admin orders do. */
  ownerId?: string | null;
  isDemo?: boolean;
}

/** Where a store stands in setup right now (for the help signal). Reads only; `live` hides the order reads. */
interface CiOnboardingProgress {
  ownerId: string | null;
  isDemo: boolean;
  createdAt: Date | null;
  live: boolean;
  paymentConfirmed: boolean;
  hasFirstOrder: boolean;
  hasFirstFulfilled: boolean;
}

export interface CiSource {
  order(storeId: string, orderId: string): Promise<CiOrderFacts | null>;
  shipment(storeId: string, shipmentId: string): Promise<CiShipmentFacts | null>;
  /** Did a WhatsApp COD answer already drive this order (Ebda Chat emitted that outcome itself)? */
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
  /**
   * Up to ACTIVATION_PEER_LIMIT other orders of the store, oldest first, that could be its first real order
   * (`qualified`: paid, or moved on by a COD confirmation) or its first fulfilled one (`fulfilled`: status delivered).
   * Explicit select, served by (store_id, created_at).
   */
  activationPeers(
    storeId: string,
    excludeOrderId: string,
    mode: 'qualified' | 'fulfilled'
  ): Promise<CiActivationOrder[]>;
  onboardingProgress(storeId: string): Promise<CiOnboardingProgress | null>;
  /** The shipment's own flag for ciSharing lookups of a shipment's store. */
  storeCiSharing(storeId: string): Promise<boolean>;
}

const toNum = (d: unknown): number | null => (d == null ? null : Number(d));

/**
 * Run `fn` for a store on its backend (Ruling CF-JOBS-4): a store on its Durable Object reads through its DO client in the
 * store's scope, a Postgres store keeps `runInTenantContext` and `prisma` exactly as before (`repo.db` IS `prisma` there).
 */
async function inStore<T>(
  storeId: string,
  fn: (db: StoreReads, repo: StoreRepo) => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  return repo.backend === 'do'
    ? runInStoreScope(storeId, () => fn(repo.db, repo))
    : runInTenantContext(storeId, () => fn(repo.db, repo));
}

/**
 * The store's CI-sharing switch, read through the store's backend like every other CI read (`inStore`): a DO store answers from
 * its `db.store` delegate (D1 for the column the DO does not hold), a Postgres store keeps its tenant scope. It was a bare
 * `runInTenantContext(storeId, () => prisma.store...)`, which opens a Postgres transaction and so threw `PostgresRemovedError`
 * on the Worker for every CI event that carried a store (Ruling NZ-D23).
 */
async function readCiSharing(storeId: string): Promise<{ ciSharing: boolean } | null> {
  return inStore(storeId, db =>
    db.store.findFirst({ where: { id: storeId }, select: { ciSharing: true } })
  );
}

export const prismaCiSource: CiSource = {
  async order(storeId, orderId) {
    return inStore(storeId, async (db, repo) => {
      const [o, store] = await Promise.all([
        db.order.findFirst({
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
            shipment: { select: { pickedUpAt: true, returnedAt: true, deliveredAt: true } },
          },
        }),
        readCiSharing(storeId),
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
        activation: activationOf({
          id: o.id,
          source: o.source,
          status: String(o.status),
          paymentStatus: String(o.paymentStatus),
          createdAt: o.createdAt,
          payments: o.payments.map(p => ({
            provider: p.provider,
            status: String(p.status),
            paidAt: p.paidAt,
          })),
          transitions: o.events.map(e => ({
            from: e.fromStatus,
            to: e.toStatus,
            at: e.createdAt,
            actorId: e.actorId,
          })),
          shipmentDeliveredAt: o.shipment?.deliveredAt ?? null,
        }),
        ciSharing: store?.ciSharing ?? false,
      };
    });
  },

  async shipment(storeId, shipmentId) {
    return inStore(storeId, async (db, repo) => {
      const s = await db.shipment.findFirst({
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
    return inStore(storeId, async (db, repo) => {
      // the DO read client has no JSON-path filter: read the order's COD outcome rows and test `details.source` here
      if (repo.backend === 'do') {
        const rows = await db.auditLog.findMany({
          where: { storeId, action: 'order.cod_outcome', resourceId: orderId },
          select: { details: true },
          take: 50,
        });
        return rows.some(r => (r.details as { source?: unknown } | null)?.source === 'whatsapp');
      }
      const row = await db.auditLog.findFirst({
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
    return inStore(storeId, db =>
      db.order.count({
        where: { storeId, buyerKey, id: { not: excludeOrderId }, createdAt: { lt: before } },
      })
    );
  },

  async stampOrder(storeId, orderId, v) {
    const money = await storeMoney(storeId);
    if (money) {
      // an order is a money row on the DO: its CI stamp is a named op (only while both are still null)
      await money.ciOrderStamp({ orderId, areaKey: v.areaKey, buyerKey: v.buyerKey });
      return;
    }
    await runInTenantContext(storeId, async () => {
      await prisma.order.updateMany({
        where: { id: orderId, storeId, areaKey: null, buyerKey: null },
        data: { areaKey: v.areaKey, buyerKey: v.buyerKey },
      });
    });
  },

  async abandonedCart(storeId, abandonedCartId) {
    return inStore(storeId, async db => {
      const a = await db.abandonedCart.findFirst({
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
    const s = await inStore(storeId, db =>
      db.store.findFirst({
        where: { id: storeId },
        select: { template: true, ciSharing: true, ownerId: true, isDemo: true },
      })
    );
    if (!s) return null;
    // The owner's signup instant lives in the identity service (`ebda-accounts`), not in a Postgres `users` row.
    const [owner] = s.ownerId ? await getAccountsBrief([s.ownerId]) : [];
    return {
      ownerSignupAt: owner?.createdAt ? new Date(owner.createdAt) : null,
      template: s.template ? String(s.template) : null,
      ciSharing: s.ciSharing ?? false,
      ownerId: s.ownerId ?? null,
      isDemo: s.isDemo === true,
    };
  },

  async activationPeers(storeId, excludeOrderId, mode) {
    return inStore(storeId, async db => {
      const rows = await db.order.findMany({
        where: {
          storeId,
          deletedAt: null,
          id: { not: excludeOrderId },
          ...(mode === 'fulfilled'
            ? { status: 'delivered' }
            : {
                OR: [
                  { paymentStatus: 'paid' },
                  { status: { in: ['confirmed', 'processing', 'shipped', 'delivered'] } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: ACTIVATION_PEER_LIMIT,
        select: {
          id: true,
          source: true,
          status: true,
          paymentStatus: true,
          createdAt: true,
          payments: { select: { provider: true, status: true, paidAt: true } },
          events: {
            orderBy: { createdAt: 'asc' },
            take: 50,
            select: { fromStatus: true, toStatus: true, createdAt: true, actorId: true },
          },
          shipment: { select: { deliveredAt: true } },
        },
      });
      return rows.map(o =>
        activationOf({
          id: o.id,
          source: o.source,
          status: String(o.status),
          paymentStatus: String(o.paymentStatus),
          createdAt: o.createdAt,
          payments: o.payments.map(p => ({
            provider: p.provider,
            status: String(p.status),
            paidAt: p.paidAt,
          })),
          transitions: o.events.map(e => ({
            from: e.fromStatus,
            to: e.toStatus,
            at: e.createdAt,
            actorId: e.actorId,
          })),
          shipmentDeliveredAt: o.shipment?.deliveredAt ?? null,
        })
      );
    });
  },

  async onboardingProgress(storeId) {
    const s = await inStore(storeId, async db => {
      const [store, otherMethods] = await Promise.all([
        db.store.findFirst({
          where: { id: storeId },
          select: { status: true, createdAt: true, settings: true, ownerId: true, isDemo: true },
        }),
        db.paymentConfig.count({ where: { storeId, isEnabled: true, provider: { not: 'cod' } } }),
      ]);
      return store ? { store, otherMethods } : null;
    });
    if (!s) return null;
    const live = String(s.store.status) === 'active';
    const ownerId = s.store.ownerId ?? null;
    const manual = (
      s.store.settings as { setupGuide?: { manual?: Record<string, boolean> } } | null
    )?.setupGuide?.manual;
    let hasFirstOrder = false;
    let hasFirstFulfilled = false;
    if (live) {
      const none = '00000000-0000-0000-0000-000000000000';
      const q = await prismaCiSource.activationPeers(storeId, none, 'qualified');
      hasFirstOrder = q.some(o => qualifiedAt(o, ownerId) != null);
      if (hasFirstOrder) {
        const f = await prismaCiSource.activationPeers(storeId, none, 'fulfilled');
        hasFirstFulfilled = f.some(o => qualifiedAt(o, ownerId) != null && o.fulfilledAt != null);
      }
    }
    return {
      ownerId,
      isDemo: s.store.isDemo === true,
      createdAt: s.store.createdAt ?? null,
      live,
      paymentConfirmed: s.otherMethods > 0 || manual?.payment === true,
      hasFirstOrder,
      hasFirstFulfilled,
    };
  },

  async storeCiSharing(storeId) {
    return (await readCiSharing(storeId))?.ciSharing ?? false;
  },
};
