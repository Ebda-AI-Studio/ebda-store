import type { JobDef } from '../../jobs/types';
import { webhookInbox } from '../../definer';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import { stepRunUnlessEmpty } from '../empty-exit';
import { logSweepRun } from '../sweep-run-log';

/**
 * Stuck payment-webhook sweep — scheduled safety net (every 30 min, Ruling INNGEST-BUDGET-1).
 *
 * Closes the one gap the offload introduced that neither the inline fallback
 * nor the function.failed P0 covers: inngest.send() SUCCEEDS at the route but
 * the event is never delivered (an Inngest-side drop, not a transient send
 * error). The WebhookEvent row then sits at status='received' with attempts=0
 * forever — a captured provider payment whose order is never marked paid, with
 * NO function.failed (the consumer never ran) and NO provider retry (we already
 * 200'd). See feedback-db-pool-starvation-webhook-storm-starves-auth.md.
 *
 * This sweep finds inbox rows that crossed the staleness threshold and:
 *   - status='received' AND attempts=0  → genuinely undelivered. RE-SEND the
 *     Inngest event once per tick. Bounded automatically: the moment a consumer
 *     picks it up, attempts becomes >0 (incremented in the consumer's `process`
 *     step) so this branch never re-sends it again, and a terminal status
 *     ('processed'/'failed') excludes it entirely.
 *   - status IN ('received' with attempts>0, 'processing')  → a consumer started
 *     but the row is wedged. Don't blindly re-send (risk of pile-up); P0-ALERT
 *     so an operator investigates + replays from the durable row.
 *
 * Idempotency-safe: a re-sent event re-enters the same consumer, which is
 * guarded by 3 idempotency layers (inbox status, Order.webhookProcessedAt,
 * handleWebhook status-equality) — so a duplicate delivery can never double-
 * apply. 'failed' rows are handled by the P0 from alertsFailureWatch +
 * (future) replay sweep, so they're excluded here to avoid double-alerting.
 */

interface StuckRow {
  id: string;
  provider: string;
  idempotencyKey: string;
  storeId: string | null;
  status: string;
  attempts: number;
  receivedAt: Date | string; // ISO string once replayed from step memo
}

const STUCK_WEBHOOK_MINUTES = Number(process.env.STUCK_WEBHOOK_MINUTES) || 10;
const SWEEP_TAKE = 200;

export const paymentWebhookStuckSweep: JobDef = inngest.createFunction(
  {
    id: 'payment-webhook-stuck-sweep',
    name: 'Payment webhook — sweep undelivered / wedged inbox rows',
    retries: 1,
    // CADENCE NOTE (2026-08-09) — this is a COST control, not a preference.
    //
    // Neon suspends a compute after 5 minutes idle. Anything polling the database
    // every 5 minutes therefore resets the idle timer just before it fires, and the
    // compute NEVER sleeps. Measured: a previous project ran 195 active hours out of 195 and
    // burned 193 CU-h/month — 76% of the whole account allowance — while the menu
    // projects, which idle normally, used 7-17.
    //
    // payment-webhook-stuck-sweep is threshold-driven: it looks for rows stale by
    // STUCK_WEBHOOK_MINUTES (10) minutes, so polling every 5 was oversampling it. At */15 the worst-case
    // detection window moves from 10-15 to 10-25 minutes, and the database gets a
    // ~10 minute sleep gap every cycle.
    //
    // Do NOT tighten this back to */5 without re-checking the Neon bill: the whole
    // saving comes from leaving a gap LONGER than the 300s suspend timeout.
    // EVERY 30 MIN (Ruling INNGEST-BUDGET-1): the one sweep kept shorter than hourly. A captured payment whose
    // webhook never reached the consumer leaves a shopper who HAS PAID on a pending order; the payment
    // provider's own retries are the only other recovery. Worst-case detection is 10-40 min.
    triggers: [{ cron: '7,37 * * * *' }],
  },
  async ({ step }) => {
    // Cross-tenant read of the inbox (storeId may be null) — withRlsBypass.
    // Cross-store by nature (the inbox spans every store, including rows with a
    // NULL store): one definer call, `ebda_webhook_inbox_stuck`.
    const stuck: StuckRow[] = await stepRunUnlessEmpty(step, 'find-stuck', async () =>
      // The cutoff is read inside the step: part of the memoised read, not re-derived on replay.
      webhookInbox.stuck(new Date(Date.now() - STUCK_WEBHOOK_MINUTES * 60_000), SWEEP_TAKE)
    );

    if (stuck.length === 0)
      return logSweepRun('payment-webhook-stuck-sweep', { swept: 0, resent: 0, alerted: 0 });

    const undelivered = stuck.filter(r => r.status === 'received' && r.attempts === 0);
    const wedged = stuck.filter(r => !(r.status === 'received' && r.attempts === 0));

    // Re-send genuinely-undelivered rows (consumer never picked them up).
    let resent = 0;
    if (undelivered.length > 0) {
      await step.run('resend-undelivered', async () => {
        for (const r of undelivered) {
          try {
            await inngest.send({
              name: 'payment/webhook.received',
              data: {
                webhookEventId: r.id,
                provider: r.provider,
                idempotencyKey: r.idempotencyKey,
                storeId: r.storeId ?? undefined,
              },
            });
            resent += 1;
          } catch (err) {
            logger.error(
              { err, webhookEventId: r.id },
              '[payment-webhook-stuck-sweep] re-send failed'
            );
          }
        }
      });
      logger.warn(
        { count: undelivered.length, resent },
        '[payment-webhook-stuck-sweep] re-sent undelivered payment webhooks'
      );
    }

    // P0-alert wedged rows (started but not finishing) — operator replays.
    if (wedged.length > 0) {
      await step.run('alert-wedged', async () => {
        await sendAlert({
          level: 'p0',
          scope: 'platform',
          source: 'payment.webhook.stuck',
          title: `payment webhook inbox: ${wedged.length} wedged row(s)`,
          body:
            `${wedged.length} payment webhook(s) have been in received(attempts>0)/processing ` +
            `for > ${STUCK_WEBHOOK_MINUTES}m. A captured payment may not be marked paid. ` +
            `Replay from the webhook_events rows.`,
          context: {
            ids: wedged.slice(0, 20).map(r => r.id),
            // new Date(): `wedged` derives from a memoized step.run result, so
            // receivedAt is an ISO string on replay (issue 2284's class).
            oldestReceivedAt: wedged[0]?.receivedAt
              ? new Date(wedged[0].receivedAt).toISOString()
              : undefined,
          },
        }).catch(() => undefined);
      });
      logger.error(
        { count: wedged.length },
        '[payment-webhook-stuck-sweep] wedged payment webhook rows — P0 alerted'
      );
    }

    return logSweepRun('payment-webhook-stuck-sweep', {
      swept: stuck.length,
      resent,
      alerted: wedged.length,
    });
  }
);
