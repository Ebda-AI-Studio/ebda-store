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
import { storeRepo } from '../repo-factory';
import { outboundStoreEventSchema, type OutboundStoreEvent } from '../../contracts/wa-v1';
import { redis } from '../../services/redis.service';
import { OrderService } from '../../services/order.service';
import { auditLog } from '../../middleware/security';
import { AppError } from '../../middleware/error-handler';
import { applyCodOutcomeOnDo } from './cod-outcome';
import { WhatsAppLinkService, isWhatsAppLinked } from './link';
import logger from '../logger';

const SEEN_TTL_SECONDS = 7 * 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoreEventResult = 'applied' | 'ignored' | 'duplicate' | 'invalid' | 'unknown_order';

async function applyCodOutcome(
  e: Extract<OutboundStoreEvent, { type: 'whatsapp.cod_outcome' }>
): Promise<StoreEventResult> {
  // The Worker has no Postgres (NEON-ZERO N-17): the answer is applied on the store's Durable Object (Ruling WA-RPC-7), the same
  // function the `recordCodOutcome` RPC uses.
  return applyCodOutcomeOnDo(e.storeId, {
    orderId: e.data.orderId,
    outcome: e.data.outcome,
    occurredAt: e.occurredAt,
    ref: e.id,
    source: e.data.source,
  });
}

async function applyOrderAfterErasure(
  e: Extract<OutboundStoreEvent, { type: 'whatsapp.order_after_erasure' }>
): Promise<StoreEventResult> {
  const { storeId } = e;
  const { orderId } = e.data;
  // On the store's Durable Object (no Postgres, Ruling WA-RPC-7): cancel an order that is still open, so it is never fulfilled for an
  // erased customer. The DO section behind `updateStatus` re-checks the live status.
  const order = await (
    await storeRepo(storeId)
  ).db.order.findFirst({
    where: { id: orderId, storeId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!order) return 'unknown_order';
  let acted = false;
  if (order.status === 'pending' || order.status === 'confirmed') {
    try {
      await OrderService.updateStatus(storeId, orderId, 'cancelled');
      acted = true;
    } catch (err) {
      if (!(err instanceof AppError) || err.statusCode >= 500 || err.statusCode === 404) throw err;
    }
  }
  await auditLog({
    action: 'order.cancelled_after_erasure',
    resourceType: 'order',
    resourceId: orderId,
    storeId,
    details: { acted, status: order.status, eventId: e.id },
  });
  return acted ? 'applied' : 'ignored';
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
