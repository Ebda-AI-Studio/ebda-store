import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import logger from '../../logger';

/**
 * Catch-all watcher for Inngest function failures past their final
 * retry. Inngest automatically emits `inngest/function.failed` when
 * any function exhausts its `retries` count, so registering one
 * handler against that event gives us dead-letter alerting for
 * every function in the registry without per-function plumbing.
 *
 * Payload shape (from Inngest):
 *   event.data.function_id   - id of the failed function
 *   event.data.event         - the original triggering event
 *   event.data.error         - { message, name, stack? }
 *   event.data.run_id        - dashboard link target
 *
 * Alerts are P1 by default — Inngest jobs are typically email
 * sending, AI sweeps, retention crons — degraded but not customer-
 * facing P0. If a P0 surface (payment fan-out, order-created) shows
 * up here we can promote later by inspecting function_id.
 */
export const alertsFailureWatch: JobDef = inngest.createFunction(
  {
    id: 'alerts-failure-watch',
    name: 'Alert on Inngest function past-final-retry failure',
    retries: 0, // the alert itself shouldn't retry; an alert miss is recoverable.
    triggers: [{ event: 'inngest/function.failed' }],
  },
  async ({ event }) => {
    const data = (event as { data?: Record<string, unknown> }).data ?? {};
    const functionId = String(data.function_id ?? 'unknown');
    const runId = String(data.run_id ?? '');
    const errorBlob =
      (data.error as { message?: string; name?: string; stack?: string } | undefined) ?? {};

    // Money-path escalation: a payment webhook that exhausts its retries can
    // leave an order permanently unpaid despite a captured provider payment
    // (the offload removed the old provider-retry self-heal — see
    // payment-webhook-process + feedback-db-pool-starvation-webhook-storm-starves-auth.md).
    // Promote those to P0 so a stuck payment is never a silent P1 until the
    // WebhookEvent replay sweep ships. The inbox row (status='failed') is the
    // durable record an operator replays from.
    const isPaymentPath = functionId === 'payment-webhook-process';

    await sendAlert({
      level: isPaymentPath ? 'p0' : 'p1',
      scope: 'platform',
      source: `inngest.${functionId}`,
      title: isPaymentPath
        ? `PAYMENT webhook processing failed past final retry: ${functionId}`
        : `background job failed: ${functionId}`,
      body: errorBlob.message ?? 'unknown error',
      context: {
        functionId,
        runId,
        errorName: errorBlob.name,
        // truncate stack to avoid Telegram's 4096 cap eating up signal
        errorStack: errorBlob.stack?.slice(0, 800),
        // surface the original triggering event so the operator can
        // reproduce / requeue from the Cloudflare Workflows dashboard
        triggeringEvent: (data.event as { name?: string } | undefined)?.name,
      },
    });

    logger.warn(
      { functionId, runId, errorName: errorBlob.name, errorMessage: errorBlob.message },
      'inngest function failed past final retry — alert dispatched'
    );
  }
);
