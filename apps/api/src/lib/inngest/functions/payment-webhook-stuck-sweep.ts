import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';

/**
 * Stuck payment-webhook sweep — scheduled safety net (every 5 min).
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
  receivedAt: Date;
}

const STUCK_WEBHOOK_MINUTES = Number(process.env.STUCK_WEBHOOK_MINUTES) || 10;
const SWEEP_TAKE = 200;

export const paymentWebhookStuckSweep: InngestFunction.Any = inngest.createFunction(
  {
    id: 'payment-webhook-stuck-sweep',
    name: 'Payment webhook — sweep undelivered / wedged inbox rows',
    retries: 1,
    triggers: [{ cron: '*/5 * * * *' }], // every 5 minutes
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - STUCK_WEBHOOK_MINUTES * 60_000);

    // Cross-tenant read of the inbox (storeId may be null) — withRlsBypass.
    const stuck: StuckRow[] = await step.run('find-stuck', async () =>
      withRlsBypass(tx =>
        tx.webhookEvent.findMany({
          where: {
            status: { in: ['received', 'processing'] },
            receivedAt: { lt: cutoff },
          },
          select: {
            id: true,
            provider: true,
            idempotencyKey: true,
            storeId: true,
            status: true,
            attempts: true,
            receivedAt: true,
          },
          orderBy: { receivedAt: 'asc' },
          take: SWEEP_TAKE,
        })
      )
    );

    if (stuck.length === 0) return { swept: 0, resent: 0, alerted: 0 };

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
            oldestReceivedAt: wedged[0]?.receivedAt?.toISOString(),
          },
        }).catch(() => undefined);
      });
      logger.error(
        { count: wedged.length },
        '[payment-webhook-stuck-sweep] wedged payment webhook rows — P0 alerted'
      );
    }

    return { swept: stuck.length, resent, alerted: wedged.length };
  }
);
