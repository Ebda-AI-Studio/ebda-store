import { sendAlert, type AlertOptions } from '../alerts.service';
import logger from '../../lib/logger';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';

/**
 * The per-incident signal for a refund nothing books (Ruling M1-7 — a partial
 * refund made outside a return has no GL poster until the owner picks an
 * account) or a refund reported without a usable amount (#1477).
 *
 * Three properties the bare `sendAlert` call sites lacked (issues 2001, 2025,
 * 2026, 2032):
 *
 * 1. PER INCIDENT, not per title. `sendAlert` throttles on
 *    `level:title:storeId` for 5 minutes, and every site used one constant
 *    title — so a second unbooked refund on the same store inside that window
 *    was silently dropped. The order number goes into the title, so each
 *    order has its own throttle key (a redelivery of the SAME order's event
 *    still collapses, which is what the throttle is for).
 * 2. A RECORD even when the alert is throttled or Telegram is down: an
 *    error-level log line carrying the order, payment and refund ids is
 *    written first, synchronously. The payment_event / reconciliation rows
 *    stay the durable trail; this line is the searchable index into them.
 * 3. OFF THE REQUEST PATH. Inside an HTTP request the Telegram round-trip
 *    (Redis lock + a fetch capped at 5s) no longer runs while the tenant
 *    transaction is open — it is queued with `deferAfterTenantCommit` and
 *    sent after COMMIT. Outside a request (the payment-webhook Inngest
 *    function) it runs inline, exactly as before.
 */
export interface UnbookedRefundAlert {
  kind: 'partial_no_gl' | 'held_unaccounted' | 'held_provenance_unknown';
  store: { id: string; name: string };
  orderRef: string;
  body: string;
  context: Record<string, unknown>;
}

const TITLES: Record<UnbookedRefundAlert['kind'], string> = {
  partial_no_gl: 'Partial refund with no ledger entry',
  held_unaccounted: 'Refund reported without an amount',
  held_provenance_unknown: 'Refund on a pre-ledger payment not added',
};

export function unbookedRefundAlertOptions(a: UnbookedRefundAlert): AlertOptions {
  return {
    level: 'p1',
    scope: 'store',
    store: a.store,
    source: `payment.refund.${a.kind}`,
    title: `${TITLES[a.kind]} — ${a.orderRef}`,
    body: a.body,
    context: a.context,
  };
}

export async function alertUnbookedRefund(a: UnbookedRefundAlert): Promise<void> {
  logger.error(
    { kind: a.kind, storeId: a.store.id, orderRef: a.orderRef, ...a.context },
    `[refund] ${TITLES[a.kind]} — ${a.orderRef}`
  );
  const opts = unbookedRefundAlertOptions(a);
  // runOnRollback: every call site raises this AFTER the provider has already
  // moved (or reported) the money, which a rolled-back request cannot undo —
  // so the P1 must survive the rollback too (PR 2279 audit).
  await deferAfterTenantCommit(
    `refund.${a.kind}.alert`,
    async () => {
      const outcome = await sendAlert(opts);
      if (outcome !== 'sent') {
        logger.warn(
          { kind: a.kind, storeId: a.store.id, orderRef: a.orderRef, outcome },
          '[refund] unbooked-refund alert not delivered — the error log line above is the record'
        );
      }
      return outcome;
    },
    { runOnRollback: true }
  ).catch(() => undefined);
}
