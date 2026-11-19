/**
 * Customer Intelligence capture wiring (docs/plans/done/2026-10-25-ci1-capture-impl.md). Names only; the
 * bindings themselves are in apps/api/wrangler.jsonc.
 */
import type { CfBindings } from '../../cf/bindings';
import { suiteBuyerKeySecret } from '../wa/config';

export const CI_EVENTS_QUEUE = 'ebda-ci-events';
export const CI_EVENTS_DLQ = 'ebda-ci-events-dlq';
/** Raw envelopes stay 24 months (lifecycle rule on `outcomes/`, scripts/ops/ci-r2-lifecycle.sh). */
export const CI_RAW_RETENTION_DAYS = 730;

/**
 * Fail loud at boot, like the WhatsApp link config: with the CI queue bound, a missing bucket or
 * buyer-key secret would otherwise surface as lost events on the first order (the one thing capture
 * cannot recover).
 */
export function assertCiCaptureConfig(env: CfBindings): void {
  if (!env.CI_EVENTS_QUEUE) return;
  if (!env.CI_BUCKET)
    throw new Error('CI_EVENTS_QUEUE is bound but the CI_BUCKET (ebda-ci) is not');
  if (!env.CI_OUTCOMES) {
    throw new Error('CI_EVENTS_QUEUE is bound but the CI_OUTCOMES Analytics Engine dataset is not');
  }
  suiteBuyerKeySecret();
}
