import type { JobDef } from '../../jobs/types';
import { prisma, runInTenantContext } from '@ebda/database';
import { webhookInbox } from '../../definer';
import { PaymentService } from '../../../services/payment-providers/payment.factory';
import { storeMoney } from '../../repo-factory';
import type { PaymentProvider } from '../../../services/payment-providers/types';
import logger from '../../logger';
import { inngest } from '../client';
import {
  shouldProcessInboxRow,
  shouldApplyWebhookEffects,
  isTerminalWebhookClientError,
} from '../webhook-offload.guard';
import { AppError } from '../../../middleware/error-handler';

/**
 * Consumes `payment/webhook.received` and runs the heavy
 * PaymentService.handleWebhook mutation OFF the inbound webhook request path.
 *
 * Why this exists: the payment webhook route used to run handleWebhook
 * (payment.update + recordPaymentEvent + applyRefundEffects + order.update,
 * inside a tenant-scoped interactive $transaction) INLINE in the provider
 * request, on the shared basePrisma pool that also serves auth/login. A
 * provider webhook storm could hold every connection and time out login
 * (P2024). The route now persists a WebhookEvent inbox row, fires this event,
 * and returns 200 immediately; the mutation happens here, on Inngest's own
 * execution path. See feedback-db-pool-starvation-webhook-storm-starves-auth.md.
 *
 * Idempotency / retry-safety (this function MUST be safe to retry):
 *   1. WebhookEvent.status — if already 'processed', this run is a no-op.
 *   2. Order.webhookProcessedAt — re-checked before mutating; handleWebhook is
 *      only invoked when the order has NOT been marked processed yet.
 *   3. handleWebhook's own internal status-equality no-ops (refund + status
 *      paths) — a duplicate that slips past 1+2 still cannot double-apply.
 * An Inngest retry re-enters the `process` step, but webhookProcessedAt is
 * already set (or the internal no-ops fire) so no payment/refund double-applies.
 *
 * Tenant context: handleWebhook + the markWebhookProcessed write run inside
 * runInTenantContext(storeId) so RLS scopes their payment/order writes —
 * exactly as the route did. The platform-only path (no storeId) calls
 * `apply()` directly with no wrapper, also matching the route (see
 * webhook.routes.ts's processWebhookInline no-storeId branch — withRlsBypass
 * never threads its `tx` through AsyncLocalStorage, so wrapping `apply`
 * (which reads/writes via the ambient `prisma` export) in it was a no-op;
 * the OLD-idiom null-context escape on orders/payments RLS policies already
 * covers this branch).
 */
export const paymentWebhookProcess: JobDef = inngest.createFunction(
  {
    id: 'payment-webhook-process',
    name: 'Payment webhook — process inbox event off the request path',
    // Serialize per inbox row so an Inngest retry can never run concurrently
    // with the original attempt on the same webhook (belt to the idempotency
    // braces above). Falls back to a global key for malformed test payloads.
    concurrency: { key: 'event.data.webhookEventId', limit: 1 },
    retries: 3,
    triggers: [{ event: 'payment/webhook.received' }],
  },
  async ({ event, step }) => {
    const { webhookEventId, idempotencyKey } = event.data;

    // Guard against empty test payloads from Inngest's sync UI.
    if (!webhookEventId) {
      logger.warn(
        { event: event.name },
        '[payment-webhook-process] fired without webhookEventId — skipping'
      );
      return;
    }

    // 1. Load the durable inbox row (cross-tenant — storeId may be null and we
    //    must read it BEFORE entering tenant context). withRlsBypass mirrors the
    //    route's checkIdempotency / resolveStoreIdFromWebhookPayload reads.
    // The inbox row must be read BEFORE a store scope exists (store_id may be
    // NULL), so every inbox access here is a SECURITY DEFINER function.
    // A miss THROWS (the step is retried, then dead-lettered P0): never a silent return. During a cutover the row can be
    // in the middle of being put back into D1; a miss here must not drop a payment notification.
    const row = await step.run('load-inbox', async () => {
      const found = await webhookInbox.get(webhookEventId);
      if (!found) {
        logger.error(
          { webhookEventId, idempotencyKey },
          '[payment-webhook-process] inbox row not found — retrying'
        );
        throw new Error(
          `webhook inbox row ${webhookEventId} not found (retry; it may be mid-cutover)`
        );
      }
      return found;
    });

    // Idempotency layer 1 — already fully processed, this is a retry / duplicate
    // enqueue. No-op. (Pure decision in shouldProcessInboxRow for unit testing.)
    if (!shouldProcessInboxRow(row.status)) {
      logger.info(
        { webhookEventId, idempotencyKey: row.idempotencyKey },
        '[payment-webhook-process] inbox row already processed — no-op'
      );
      return;
    }

    // Mark processing. attempts is bumped inside the `process` step instead of
    // here: this `mark-processing` step is MEMOIZED by Inngest (replayed from
    // cache on a retry, not re-executed), so incrementing here would freeze the
    // counter at 1. The `process` step re-runs on every retry, so the increment
    // there reflects the real attempt count for spotting a poison row.
    await step.run('mark-processing', async () =>
      webhookInbox.update(webhookEventId, { status: 'processing' })
    );

    const provider = row.provider as PaymentProvider;
    const payload = row.payload as Record<string, unknown>;
    const storeId = row.storeId ?? undefined;

    // 2. Run the mutation. Idempotency layer 2 (Order.webhookProcessedAt) is
    //    re-checked here so a retry that already applied the payment short-
    //    circuits before touching it again. handleWebhook re-verifies the HMAC
    //    signature against the stored raw body (cryptographic check preserved).
    let result: { success: boolean; status?: string; orderId?: string };
    try {
      result = await step.run('process', async () => {
        // attempts++ here (NOT in the memoized mark-processing step) so the
        // counter reflects real retries — Inngest replays mark-processing from
        // cache but re-executes this step body on every retry.
        await webhookInbox.update(webhookEventId, { incrementAttempts: true });
        const apply = async (): Promise<{
          success: boolean;
          status?: string;
          orderId?: string;
        }> => {
          // A store on its Durable Object (Ruling CF-JOBS-4): the order row, the payment row and the
          // event log live there, and the DO dedupes the signed event inside the same section that applies it
          // (`payment_event_log (provider, event_id)`, outcome `replayed`). So there is no Postgres
          // `webhookProcessedAt` to read or stamp: `handleWebhook` is the whole apply, and a retry of this
          // step is a `replayed` no-op there. An external money fact is recorded in full, never rejected.
          if (storeId && (await storeMoney(storeId))) {
            return PaymentService.handleWebhook(
              provider,
              payload,
              row.signature,
              storeId,
              row.rawBody
            );
          }
          // Re-check idempotency by the route's contract: if there is already an
          // order marked processed for this idempotency key, skip re-applying.
          // Order is a tenant model: with no store scope (no storeId on the
          // inbox row) there is nothing to look up and nothing to mark.
          const existing = storeId
            ? await prisma.order.findUnique({
                where: { idempotencyKey: row.idempotencyKey, storeId },
                select: { id: true, webhookProcessedAt: true },
              })
            : null;
          // Idempotency layer 2 (pure decision in shouldApplyWebhookEffects).
          if (!shouldApplyWebhookEffects(existing)) {
            return { success: true, status: 'already_processed', orderId: existing!.id };
          }

          const r = await PaymentService.handleWebhook(
            provider,
            payload,
            row.signature,
            storeId,
            row.rawBody
          );

          // markWebhookProcessed (mirrors webhook.routes.ts) — only when we have
          // an order. Runs in the same tenant context as the mutation.
          if (r.orderId && storeId) {
            await prisma.order.update({
              where: { id: r.orderId, storeId },
              data: { idempotencyKey: row.idempotencyKey, webhookProcessedAt: new Date() },
            });
          }
          return r;
        };

        // Same tenant-context branching the route used: scoped when storeId is
        // known; called directly (no wrapper) for the platform-only path — see
        // the docstring above for why withRlsBypass here was a no-op.
        if (storeId && !(await storeMoney(storeId))) {
          return runInTenantContext(storeId, apply);
        }
        return apply();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // TERMINAL client errors (4xx AppError: forged/invalid signature, store
      // mismatch, malformed payload) are NOT retryable — the bytes are bad, so
      // replaying them just burns retries and, worse, pages a P0 on every forged
      // POST (an unauthenticated attacker could spam P0s). Mark the row
      // 'rejected' and RETURN without throwing: no retry, no inngest/function.failed,
      // no P0. The durable row + lastError remain for audit. Only 5xx / unknown
      // (DB, network — genuinely transient) rethrow to retry + escalate.
      //
      // EXCEPT an operational refusal of a verified event (AMBIGUOUS_PAYMENT,
      // issue 769): it retries and dead-letters into the P0 path instead of
      // the silent 'rejected' lane. See isTerminalWebhookClientError.
      const isTerminalClientError = err instanceof AppError && isTerminalWebhookClientError(err);
      if (isTerminalClientError) {
        await step
          .run('mark-rejected', async () =>
            webhookInbox.update(webhookEventId, {
              status: 'rejected',
              lastError: message.slice(0, 1000),
            })
          )
          .catch(() => undefined);
        logger.warn(
          { err, webhookEventId, provider, storeId },
          '[payment-webhook-process] webhook rejected (terminal client error) — not retrying'
        );
        return;
      }

      // Transient failure: persist + rethrow so Inngest retries. The row stays
      // 'failed' and is a durable backstop for a replay sweep. When retries are
      // exhausted Inngest emits inngest/function.failed → alertsFailureWatch
      // fires a P0 (money-path escalation) so a stuck captured payment is never
      // silent. The 'failed' WebhookEvent row is what an operator replays from.
      await step
        .run('mark-failed', async () =>
          webhookInbox.update(webhookEventId, {
            status: 'failed',
            lastError: message.slice(0, 1000),
          })
        )
        .catch(() => undefined);
      logger.error(
        { err, webhookEventId, provider, storeId },
        '[payment-webhook-process] handleWebhook failed — Inngest will retry'
      );
      throw err;
    }

    // 3. Finalize — mark the inbox row processed with the result for audit.
    await step.run('finalize', async () =>
      webhookInbox.update(webhookEventId, {
        status: 'processed',
        markProcessed: {
          resultOrderId: result.orderId ?? null,
          resultStatus: result.status ?? null,
        },
      })
    );

    logger.info(
      { webhookEventId, provider, storeId, result },
      '[payment-webhook-process] processed off the request path'
    );
  }
);
