/**
 * Configuration of the Store <-> Ebda Chat link (contract 2026-10-24, sections 3 and 6).
 * Secrets come from the environment only (a Worker secret), never from code or wrangler vars.
 */
import type { CfBindings } from '../../cf/bindings';

export const WA_EVENTS_QUEUE = 'ebda-wa-events';
export const STORE_EVENTS_QUEUE = 'ebda-store-events';
export const STORE_EVENTS_DLQ = 'ebda-store-events-dlq';

const MIN_SECRET_LENGTH = 32;

/** SUITE_BUYER_KEY_SECRET, the HMAC key of every buyerKey in the suite (same value in every Worker). */
export function suiteBuyerKeySecret(): string {
  const v = process.env.SUITE_BUYER_KEY_SECRET ?? '';
  if (v.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SUITE_BUYER_KEY_SECRET must be set (>= ${MIN_SECRET_LENGTH} chars): it keys every buyerKey`
    );
  }
  return v;
}

/**
 * Fail loud at boot (a throwing isolate 500s every request until fixed or rolled back, like the
 * embedding and DB-role guards): with the WhatsApp queue bound, a missing secret would otherwise
 * surface as a failed enqueue on the first order, or worse, an unkeyed hash.
 */
export function assertWhatsAppLinkConfig(env: CfBindings): void {
  // A secret that is set but too short is wrong whether or not the queue is bound (the bridge and the erasure use it too): WA-4.
  const set = process.env.SUITE_BUYER_KEY_SECRET ?? '';
  if (set.length > 0 && set.length < MIN_SECRET_LENGTH) suiteBuyerKeySecret();
  if (!env.WA_EVENTS_QUEUE) return;
  suiteBuyerKeySecret();
}
