/**
 * WhatsApp -> Store consumer (contract 2026-10-24, sections 3 and 8): the `ebda-store-events` queue.
 *
 *  - `whatsapp.cod_outcome`: confirmed / refused / no_reply for a COD order. The Store stays the
 *    ONLY writer of order state: `confirmed` moves pending -> confirmed, `refused` cancels (stock
 *    restored by the normal cancel path), `no_reply` records the outcome and changes nothing. The
 *    outcome is tagged `source: whatsapp` in the audit trail, and the Store does NOT emit its own
 *    commerce outcome for it (Ebda Chat already emitted `commerce_outcomes`; contract section 8).
 *  - `whatsapp.order_after_erasure`: an order created from chat for a buyer erased at the same
 *    moment: cancelled so it is never fulfilled for an erased customer.
 *
 * Idempotent by construction: envelope ids are remembered (7 days) AND every action is a state
 * transition that is a no-op the second time (same-status write, terminal states ignored). The
 * seen-marker is written AFTER the action, so a crash between them replays safely instead of
 * losing the event. Tenant-scoped: every read and write runs in the event's store context.
 */
import { applyOptOutChanged } from './consent';
import { prisma } from '@ebda/database';
import { storeRepo, storeDb } from '../repo-factory';
import { runInStoreTenantContext } from '../store-scoped-read';
import { outboundStoreEventSchema, type OutboundStoreEvent } from '../../contracts/wa-v1';
import { redis } from '../../services/redis.service';
import { OrderService } from '../../services/order.service';
import { auditLog } from '../../middleware/security';
import { AppError } from '../../middleware/error-handler';
import { withDeferredWork } from '../after-tenant-commit';
import { WhatsAppLinkService, isWhatsAppLinked } from './link';
import logger from '../logger';

const SEEN_TTL_SECONDS = 7 * 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoreEventResult = 'applied' | 'ignored' | 'duplicate' | 'invalid' | 'unknown_order';

/**
 * Lock the order row for the rest of the transaction, then read it. The check ("still pending and
 * unpaid COD?") and the status write run in ONE tenant transaction on a locked row, so a merchant
 * shipping the order in the same instant either wins first (we then see `shipped` and ignore the
 * answer) or waits for us. Without the lock a late "refused" could cancel, and restock, a parcel
 * that had just been handed to the courier.
 */
const ORDER_SELECT = {
  id: true,
  status: true,
  paymentStatus: true,
  createdAt: true,
  payments: { select: { provider: true, status: true } },
} as const;

async function lockedOrder(storeId: string, orderId: string) {
  // A store on its Durable Object (no Postgres, Ruling NZ-MONEY-6): a plain read. There is no row lock across two DO calls;
  // the status change below re-validates its FROM status inside its own DO section, and `transition()` treats a refusal
  // as "no longer eligible", so a ship that lands in between is never cancelled.
  if ((await storeRepo(storeId)).backend === 'do')
    return (await storeDb(storeId)).order.findUnique({
      where: { id: orderId, storeId },
      select: ORDER_SELECT,
    });
  await prisma.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} AND store_id = ${storeId} FOR UPDATE`;
  return prisma.order.findUnique({
    where: { id: orderId, storeId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      payments: { select: { provider: true, status: true } },
    },
  });
}

/** A real COD order still waiting for its money: the only thing a COD answer may act on. */
/**
 * The status change of a COD outcome / an erasure cancel. A transition the order state machine refuses (the order moved on
 * between the read and this call: shipped, already cancelled) is "not acted", never a retry loop.
 */
async function transition(
  storeId: string,
  orderId: string,
  to: 'confirmed' | 'cancelled'
): Promise<{ acted: boolean; refused?: string }> {
  try {
    await OrderService.updateStatus(storeId, orderId, to);
    return { acted: true };
  } catch (err) {
    if (err instanceof AppError && (err.statusCode === 400 || err.statusCode === 409))
      return { acted: false, refused: err.code };
    throw err;
  }
}

function isOpenCodOrder(o: NonNullable<Awaited<ReturnType<typeof lockedOrder>>>): boolean {
  return (
    o.paymentStatus === 'unpaid' &&
    (o.payments ?? []).some(p => p.provider === 'cod' && p.status === 'cod_pending')
  );
}

async function applyCodOutcome(
  e: Extract<OutboundStoreEvent, { type: 'whatsapp.cod_outcome' }>
): Promise<StoreEventResult> {
  const { storeId } = e;
  const { orderId, outcome } = e.data;
  // The deferral scope wraps the transaction: the cancel's follow-up work (refund fan-out, cache
  // busts) fires AFTER COMMIT, never inside it, and is dropped if the transaction rolls back.
  // a DO store has no Postgres transaction: its deferred work (the status fanout) drains under the store scope
  const noPgTx = (await storeRepo(storeId)).backend === 'do';
  return withDeferredWork({ storeId, noPgTx }, () =>
    runInStoreTenantContext(storeId, async () => {
      const order = await lockedOrder(storeId, orderId);
      if (!order) return 'unknown_order';
      // An answer that predates the order (clock skew, replay of an old id) is not about this order.
      const stale = new Date(e.occurredAt).getTime() < order.createdAt.getTime();

      let acted = false;
      let refused: string | undefined;
      // Only an open COD order can be moved by an answer: an online-paid, shipped, delivered or
      // already cancelled one has moved on (a late "yes"), and an unpaid card order is NOT a COD
      // order, so "confirmed" must never make it shippable.
      if (!stale && isOpenCodOrder(order)) {
        if (outcome === 'confirmed' && order.status === 'pending') {
          ({ acted, refused } = await transition(storeId, orderId, 'confirmed'));
        } else if (
          outcome === 'refused' &&
          (order.status === 'pending' || order.status === 'confirmed')
        ) {
          ({ acted, refused } = await transition(storeId, orderId, 'cancelled'));
        }
      }
      await auditLog({
        action: 'order.cod_outcome',
        resourceType: 'order',
        resourceId: orderId,
        storeId,
        details: {
          outcome,
          source: e.data.source,
          acted,
          stale,
          status: order.status,
          eventId: e.id,
          ...(refused ? { refused } : {}),
        },
      });
      return acted || (outcome === 'no_reply' && !stale) ? 'applied' : 'ignored';
    })
  );
}

async function applyOrderAfterErasure(
  e: Extract<OutboundStoreEvent, { type: 'whatsapp.order_after_erasure' }>
): Promise<StoreEventResult> {
  const { storeId } = e;
  const { orderId } = e.data;
  // The deferral scope wraps the transaction: the cancel's follow-up work (refund fan-out, cache
  // busts) fires AFTER COMMIT, never inside it, and is dropped if the transaction rolls back.
  // a DO store has no Postgres transaction: its deferred work (the status fanout) drains under the store scope
  const noPgTx = (await storeRepo(storeId)).backend === 'do';
  return withDeferredWork({ storeId, noPgTx }, () =>
    runInStoreTenantContext(storeId, async () => {
      const order = await lockedOrder(storeId, orderId);
      if (!order) return 'unknown_order';
      let acted = false;
      let refused: string | undefined;
      if (order.status === 'pending' || order.status === 'confirmed')
        ({ acted, refused } = await transition(storeId, orderId, 'cancelled'));
      await auditLog({
        action: 'order.cancelled_after_erasure',
        resourceType: 'order',
        resourceId: orderId,
        storeId,
        details: { acted, status: order.status, eventId: e.id, ...(refused ? { refused } : {}) },
      });
      return acted ? 'applied' : 'ignored';
    })
  );
}

/**
 * Process one queue message body. Throws on a transient failure (the queue retries); returns a
 * result for everything that retrying cannot change (invalid body, unknown order, not linked).
 *
 * Idempotency, honestly: the load-bearing guard is the order's own state transition under a row
 * lock (a second "confirmed" finds `confirmed` and does nothing). The seen-marker below is only a
 * cheap short-circuit; it is best effort (no Redis = no marker) and is written after the action.
 */
export async function handleStoreEvent(body: unknown): Promise<StoreEventResult> {
  const parsed = outboundStoreEventSchema.safeParse(body);
  if (!parsed.success || !UUID.test(parsed.data.storeId)) {
    logger.error(
      { issues: parsed.success ? 0 : parsed.error.issues.length },
      '[wa-store-events] invalid message dropped'
    );
    return 'invalid';
  }
  const e = parsed.data;
  const seenKey = `wa-in:${e.id}`;
  if (await redis.exists(seenKey)) return 'duplicate';

  // An entitlement is a fact about the store's package, not an action on an order: it is applied
  // even before the merchant links (and never needs the link), monotonic by version.
  if (e.type === 'whatsapp.entitlement_changed') {
    const applied = await WhatsAppLinkService.applyEntitlement(e.storeId, {
      ...e.data,
      validUntil: new Date(e.data.validUntil),
    });
    await redis.set(seenKey, '1', SEEN_TTL_SECONDS);
    logger.info(
      { storeId: e.storeId, version: e.data.version, status: e.data.status, applied },
      '[wa-store-events] entitlement'
    );
    return applied ? 'applied' : 'ignored';
  }

  // A STOP is the buyer's own withdrawal: applied even for a store that is not (or no longer) linked.
  // Monotonic by `version`; optedOut=false never re-enables Store consent (that needs a new tick).
  // Any failure THROWS so the queue redelivers: dropping a STOP would let marketing continue.
  if (e.type === 'whatsapp.opt_out_changed') {
    const result = await applyOptOutChanged(
      e.storeId,
      e.data.buyerKey,
      e.data.optedOut,
      e.data.version
    );
    await redis.set(seenKey, '1', SEEN_TTL_SECONDS);
    logger.info(
      { storeId: e.storeId, version: e.data.version, optedOut: e.data.optedOut, result },
      '[wa-store-events] opt-out'
    );
    return result;
  }

  // Trust boundary: the queue is account-internal and unsigned, so the Store re-derives what it can.
  // A store that is not linked / not entitled gets no WhatsApp-driven order changes.
  if (!(await isWhatsAppLinked(e.storeId))) {
    logger.warn(
      { storeId: e.storeId, type: e.type },
      '[wa-store-events] store not linked, ignored'
    );
    return 'ignored';
  }

  let result: StoreEventResult;
  try {
    result =
      e.type === 'whatsapp.cod_outcome'
        ? await applyCodOutcome(e)
        : await applyOrderAfterErasure(e);
  } catch (err) {
    // A soft-deleted / vanished order: a retry cannot fix it.
    if (err instanceof AppError && err.statusCode === 404) result = 'unknown_order';
    else throw err;
  }
  await redis.set(seenKey, '1', SEEN_TTL_SECONDS);
  logger.info(
    { type: e.type, storeId: e.storeId, orderId: e.data.orderId, result },
    '[wa-store-events] handled'
  );
  return result;
}
