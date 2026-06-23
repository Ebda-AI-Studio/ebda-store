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
