/**
 * Pure idempotency-decision helpers for the payment-webhook offload path.
 *
 * Extracted so the retry-safety logic is unit-testable without a live DB /
 * Inngest. The payment-webhook-process Inngest function and the route's inbox
 * write both route their "should we (re)apply this?" decision through here, so
 * the rules are defined in exactly one place.
 *
 * Idempotency layers (all three must agree before a mutation runs):
 *   1. WebhookEvent.status — a row already 'processed' must NEVER re-apply.
 *   2. Order.webhookProcessedAt — set the moment a webhook's payment effects
 *      land; a retry that sees it set short-circuits.
 *   3. PaymentService.handleWebhook's own status-equality no-ops (not modelled
 *      here — it's the last line of defence inside the service).
 */

export type WebhookInboxStatus = 'received' | 'processing' | 'processed' | 'failed' | string;

/**
 * Should the Inngest consumer even attempt to process this inbox row?
 * False when the row is already terminal-processed (a retry / duplicate enqueue).
 */
export function shouldProcessInboxRow(status: WebhookInboxStatus): boolean {
  return status !== 'processed';
}

/**
 * Given the existing order matched by idempotency key, should we apply the
 * webhook's payment effects? False when an order is already marked processed
 * (layer 2) — a retried Inngest step then short-circuits before touching the
 * payment/order again.
 */
export function shouldApplyWebhookEffects(
  existingOrder: {
    webhookProcessedAt?: Date | string | null;
  } | null
): boolean {
  if (!existingOrder) return true; // no order yet → handleWebhook will resolve it
  return !existingOrder.webhookProcessedAt;
}

/**
 * 4xx codes that are OPERATIONAL refusals of a verified, genuine provider
 * event — not bad bytes. They must retry and dead-letter into the P0 path,
 * never land in the silent `rejected` lane (which payment-webhook-stuck-sweep
 * does not look at). AMBIGUOUS_PAYMENT: the provider id matches more than one
 * payment (issue 769 / PR 2279 audit).
 */
export const OPERATIONAL_WEBHOOK_CLIENT_ERRORS: ReadonlySet<string> = new Set([
  'AMBIGUOUS_PAYMENT',
]);

/**
 * Is this webhook-processing failure a TERMINAL client error (forged or
 * invalid signature, store mismatch, malformed payload) that must be marked
 * `rejected` without retrying or paging? Duck-typed on `statusCode`/`code`
 * so the decision stays pure and importable without the error class.
 */
export function isTerminalWebhookClientError(err: unknown): boolean {
  const e = err as { statusCode?: unknown; code?: unknown } | null;
  if (!e || typeof e.statusCode !== 'number') return false;
  if (e.statusCode < 400 || e.statusCode >= 500) return false;
  return !(typeof e.code === 'string' && OPERATIONAL_WEBHOOK_CLIENT_ERRORS.has(e.code));
}
