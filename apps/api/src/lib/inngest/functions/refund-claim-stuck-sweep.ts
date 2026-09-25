import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { sendAlert } from '../../../services/alerts.service';
import {
  REFUND_CLAIM_EVENT,
  REFUND_EXECUTED_EVENT,
  REFUND_RELEASED_EVENT,
} from '../../../services/payment-providers/refund-outcome';

/**
 * Stuck refund-claim check (#1317) — runs on the refund-reversal sweep's tick,
 * not a cron of its own (a new cadence would keep the Neon compute awake; see
 * the CADENCE NOTE in refund-reversal-stuck-sweep.ts).
 *
 * PaymentService.refund commits its claim — `refundedAmount` raised, a
 * `refund_initiated` payment event written — BEFORE it calls the provider, and
 * resolves it afterwards with `refund_completed` (money sent) or
 * `refund_failed` (nothing sent, balance put back). A claim with neither is a
 * refund whose outcome nobody knows:
 *
 *   - the process died between the claim and the provider's answer, or
 *   - the provider never gave a clear answer (`refund_indeterminate`).
 *
 * Either way the payment's balance counts money that may never have left, and
 * nothing in the product can tell it apart from a real refund. It cannot be
 * resolved automatically — without a provider refund id there is nothing to
 * ask the provider about — so this raises it for a human, who checks the
 * provider dashboard. The claim and its outcome show on the order page's
 * payment-events timeline.
 */

/** Old enough that the request that made the claim is certainly over. */
const STUCK_AFTER_MINUTES = Number(process.env.REFUND_CLAIM_STUCK_MINUTES) || 15;
/**
 * Stop reporting after a week: by then it has been alerted on ~670 ticks and
 * is either reconciled by hand or not going to be because of this alert.
 */
const MAX_AGE_MINUTES = Number(process.env.REFUND_CLAIM_MAX_AGE_MINUTES) || 7 * 24 * 60;

interface SweepStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

interface StuckClaim {
  claimId: string;
  paymentId: string;
  storeId: string;
  orderId: string;
  amount: number | null;
  claimedAt: string;
}

export async function handleStuckRefundClaimSweep(step: SweepStep): Promise<{ stuck: number }> {
  const cutoff = Date.now() - STUCK_AFTER_MINUTES * 60_000;
  const floor = new Date(Date.now() - MAX_AGE_MINUTES * 60_000);

  const stuck: StuckClaim[] = await step.run('find-stuck-refund-claims', async () => {
    const events = await withRlsBypass(tx =>
      tx.paymentEvent.findMany({
        where: {
          eventType: { in: [REFUND_CLAIM_EVENT, REFUND_EXECUTED_EVENT, REFUND_RELEASED_EVENT] },
          occurredAt: { gt: floor },
        },
        select: {
          eventType: true,
          paymentId: true,
          storeId: true,
          orderId: true,
          details: true,
          occurredAt: true,
        },
      })
    );
    const resolved = new Set<string>();
    const claims = new Map<string, StuckClaim>();
    for (const e of events) {
      const details = (e.details ?? {}) as Record<string, unknown>;
      const claimId = typeof details.claimId === 'string' ? details.claimId : null;
      if (!claimId) continue;
      if (e.eventType === REFUND_CLAIM_EVENT) {
        claims.set(claimId, {
          claimId,
          paymentId: e.paymentId,
          storeId: e.storeId,
          orderId: e.orderId,
          amount: typeof details.amount === 'number' ? details.amount : null,
          claimedAt: e.occurredAt.toISOString(),
        });
      } else if (e.eventType === REFUND_EXECUTED_EVENT || e.eventType === REFUND_RELEASED_EVENT) {
        resolved.add(claimId);
      }
    }
    return [...claims.values()].filter(
      c => !resolved.has(c.claimId) && new Date(c.claimedAt).getTime() < cutoff
    );
  });

  if (stuck.length === 0) return { stuck: 0 };

  logger.error(
    { count: stuck.length, claims: stuck.slice(0, 20) },
    '[refund-claim-stuck-sweep] refund claims with no outcome — balances may count money that never left'
  );
  await step.run('alert-stuck-refund-claims', async () => {
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'payment.refund.claim_stuck',
      title: `${stuck.length} refund(s) with no known outcome`,
      body:
        `${stuck.length} refund(s) were claimed on a payment more than ${STUCK_AFTER_MINUTES}m ago ` +
        `and never confirmed as sent or released. Each payment's refunded total already ` +
        `counts the amount. Check each one in the provider dashboard; the claim is on the ` +
        `order page's payment timeline.`,
      context: {
        claims: stuck.slice(0, 20).map(c => ({
          orderId: c.orderId,
          paymentId: c.paymentId,
          storeId: c.storeId,
          amount: c.amount,
          claimedAt: c.claimedAt,
        })),
      },
    }).catch(() => undefined);
  });
  return { stuck: stuck.length };
}
