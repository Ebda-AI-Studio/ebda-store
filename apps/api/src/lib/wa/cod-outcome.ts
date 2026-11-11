/**
 * A COD answer from Ebda Chat applied to an order on its Durable Object store (Rulings WA-RPC-2, WA-RPC-7).
 * Shared by the `whatsapp.cod_outcome` queue consumer and the `recordCodOutcome` RPC, so both behave identically.
 *
 * The Store stays the ONLY writer of order state, and only an OPEN COD order (unpaid + a pending COD payment) can move:
 *   confirmed -> pending => confirmed;  refused -> pending|confirmed => cancelled (unpaid only, stock restored by the cancel path);
 *   no_reply -> recorded, nothing changes.
 * An answer older than the order, an online-paid / shipped / delivered / cancelled order, or a transition the state machine
 * refuses is ignored (a late "yes" never makes a paid order shippable, a late "no" never cancels a parcel in transit).
 * Replays are no-ops by construction: the second `confirmed` finds `confirmed`, the second `refused` finds `cancelled`. The DO
 * section behind `updateStatus` checks the live status, so two racing answers cannot both act.
 */
import { storeRepo } from '../repo-factory';
import { OrderService } from '../../services/order.service';
import { auditLog } from '../../middleware/security';
import { AppError } from '../../middleware/error-handler';

export type CodOutcomeResult = 'applied' | 'ignored' | 'unknown_order';

export async function applyCodOutcomeOnDo(
  storeId: string,
  a: {
    orderId: string;
    outcome: 'confirmed' | 'refused' | 'no_reply';
    occurredAt: string;
    ref: string;
    source: string;
  }
): Promise<CodOutcomeResult> {
  const repo = await storeRepo(storeId);
  const order = await repo.db.order.findFirst({
    where: { id: a.orderId, storeId, deletedAt: null },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      payments: { select: { provider: true, status: true } },
    },
  });
  if (!order) return 'unknown_order';
  const stale =
    new Date(a.occurredAt).getTime() < new Date(order.createdAt as unknown as string).getTime();
  const open =
    order.paymentStatus === 'unpaid' &&
    (order.payments ?? []).some(p => p.provider === 'cod' && p.status === 'cod_pending');
  let acted = false;
  if (!stale && open) {
    try {
      if (a.outcome === 'confirmed' && order.status === 'pending') {
        await OrderService.updateStatus(storeId, a.orderId, 'confirmed');
        acted = true;
      } else if (
        a.outcome === 'refused' &&
        (order.status === 'pending' || order.status === 'confirmed')
      ) {
        await OrderService.updateStatus(storeId, a.orderId, 'cancelled', { unpaidOnly: true });
        acted = true;
      }
    } catch (err) {
      // the state machine refused (the order moved on between the read and the write): ignored, never forced
      // a 404 (the order vanished) propagates so the queue acknowledges it as unknown; a 5xx retries
      if (!(err instanceof AppError) || err.statusCode >= 500 || err.statusCode === 404) throw err;
    }
  }
  await auditLog({
    action: 'order.cod_outcome',
    resourceType: 'order',
    resourceId: a.orderId,
    storeId,
    details: {
      outcome: a.outcome,
      source: a.source,
      acted,
      stale,
      status: order.status,
      ref: a.ref,
    },
  });
  return acted || (a.outcome === 'no_reply' && !stale) ? 'applied' : 'ignored';
}
