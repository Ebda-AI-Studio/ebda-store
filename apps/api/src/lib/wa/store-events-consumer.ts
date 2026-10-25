/**
 * WhatsApp -> Store consumer (contract 2026-10-24, sections 3 and 8): the `ebda-store-events` queue.
 *
 *  - `whatsapp.cod_outcome`: confirmed / refused / no_reply for a COD order. The Store stays the
 *    ONLY writer of order state: `confirmed` moves pending -> confirmed, `refused` cancels (stock
 *    restored by the normal cancel path), `no_reply` records the outcome and changes nothing. The
 *    outcome is tagged `source: whatsapp` in the audit trail, and the Store does NOT emit its own
 *    commerce outcome for it (Ebda WhatsApp already emitted `commerce_outcomes`; contract section 8).
 *  - `whatsapp.order_after_erasure`: an order created from chat for a buyer erased at the same
 *    moment: cancelled so it is never fulfilled for an erased customer.
 *
 * Idempotent by construction: envelope ids are remembered (7 days) AND every action is a state
 * transition that is a no-op the second time (same-status write, terminal states ignored). The
 * seen-marker is written AFTER the action, so a crash between them replays safely instead of
 * losing the event. Tenant-scoped: every read and write runs in the event's store context.
 */
import { prisma, runInTenantContext } from '@ebda/database';
import { outboundStoreEventSchema, type OutboundStoreEvent } from '../../contracts/ebda-wa-v1';
import { redis } from '../../services/redis.service';
import { OrderService } from '../../services/order.service';
import { auditLog } from '../../middleware/security';
import logger from '../logger';

const SEEN_TTL_SECONDS = 7 * 24 * 3600;

export type StoreEventResult = 'applied' | 'ignored' | 'duplicate' | 'invalid' | 'unknown_order';

async function applyCodOutcome(
  e: Extract<OutboundStoreEvent, { type: 'whatsapp.cod_outcome' }>
): Promise<StoreEventResult> {
  const { storeId } = e;
  const { orderId, outcome } = e.data;
  const order = await runInTenantContext(storeId, () =>
    prisma.order.findUnique({
      where: { id: orderId, storeId },
      select: { id: true, status: true, paymentStatus: true },
    })
  );
  if (!order) return 'unknown_order';

  let acted = false;
  // Only an unpaid order can be a COD order awaiting an answer; a paid / shipped / terminal one
  // has already moved on (a late "yes"), so the answer changes nothing.
  if (order.paymentStatus === 'unpaid') {
    if (outcome === 'confirmed' && order.status === 'pending') {
      await OrderService.updateStatus(storeId, orderId, 'confirmed');
      acted = true;
    } else if (
      outcome === 'refused' &&
      (order.status === 'pending' || order.status === 'confirmed')
    ) {
      await OrderService.updateStatus(storeId, orderId, 'cancelled');
      acted = true;
    }
  }
  await auditLog({
    action: 'order.cod_outcome',
    resourceType: 'order',
    resourceId: orderId,
    storeId,
    details: { outcome, source: e.data.source, acted, status: order.status, eventId: e.id },
  });
  return acted || outcome === 'no_reply' ? 'applied' : 'ignored';
}

async function applyOrderAfterErasure(
  e: Extract<OutboundStoreEvent, { type: 'whatsapp.order_after_erasure' }>
): Promise<StoreEventResult> {
  const { storeId } = e;
  const { orderId } = e.data;
  const order = await runInTenantContext(storeId, () =>
    prisma.order.findUnique({ where: { id: orderId, storeId }, select: { status: true } })
  );
  if (!order) return 'unknown_order';
  let acted = false;
  if (order.status === 'pending' || order.status === 'confirmed') {
    await OrderService.updateStatus(storeId, orderId, 'cancelled');
    acted = true;
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
 * result for everything that retrying cannot change (invalid body, unknown order).
 */
export async function handleStoreEvent(body: unknown): Promise<StoreEventResult> {
  const parsed = outboundStoreEventSchema.safeParse(body);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues.length },
      '[wa-store-events] invalid message dropped'
    );
    return 'invalid';
  }
  const e = parsed.data;
  const seenKey = `wa-in:${e.id}`;
  if (await redis.exists(seenKey)) return 'duplicate';

  const result =
    e.type === 'whatsapp.cod_outcome' ? await applyCodOutcome(e) : await applyOrderAfterErasure(e);
  await redis.set(seenKey, '1', SEEN_TTL_SECONDS);
  logger.info(
    { type: e.type, storeId: e.storeId, orderId: e.data.orderId, result },
    '[wa-store-events] handled'
  );
  return result;
}
