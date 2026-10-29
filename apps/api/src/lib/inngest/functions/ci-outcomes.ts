import type { JobDef } from '../../jobs/types';
import { cfBindings } from '../../../cf/bindings';
import { inngest } from '../client';
import { suiteBuyerKeySecret } from '../../wa/config';
import { commerceOutcomesPort, type CommerceOutcomesPort } from '../../ci/port';
import {
  planCartReminder,
  planCartRecovered,
  planOnboardingStep,
  planOrderCreated,
  planOrderStatusChanged,
  planPaymentFailed,
  planShipmentBooked,
  planShipmentUpdated,
  type PlanCtx,
} from '../../ci/planner';
import { prismaCiSource } from '../../ci/source';
import {
  CI_CART_RECOVERED_EVENT,
  CI_CART_REMINDER_EVENT,
  CI_ONBOARDING_STEP_EVENT,
  CI_PAYMENT_FAILED_EVENT,
  CI_SHIPMENT_BOOKED_EVENT,
  CI_SHIPMENT_TRACKED_EVENT,
} from '../../ci/events';

/**
 * Customer Intelligence capture (CI-1): turns the Store's existing domain events into append-only
 * `commerce_outcomes` envelopes and hands them to the ONE emit port. It reads a single order or
 * shipment row by id per event; it never scans a table, and it never changes order or shipment state
 * (advise-never-block: a failure here is a retried job, the order flow has already committed).
 *
 * Ids are deterministic per occurrence (lib/ci/planner.ts), so Inngest retries, `order/created`
 * re-sends (COD mark-paid, the stuck sweep) and repeated carrier polls collapse to one row.
 */
type SourceEvent = { name: string; data?: Record<string, unknown> };

export async function emitCiOutcomesFor(
  event: SourceEvent,
  deps: { ctx?: PlanCtx; port?: CommerceOutcomesPort } = {}
): Promise<number> {
  // Node (local dev, unit tests) has no queue to write to; the Worker is where capture runs.
  if (!deps.ctx && !deps.port && !cfBindings()) return 0;
  const ctx = deps.ctx ?? { source: prismaCiSource, secret: suiteBuyerKeySecret() };
  const d = (event.data ?? {}) as Record<string, never>;
  const planned =
    event.name === 'order/created'
      ? await planOrderCreated(ctx, d)
      : event.name === 'order/status-changed'
        ? await planOrderStatusChanged(ctx, d)
        : event.name === CI_SHIPMENT_BOOKED_EVENT
          ? await planShipmentBooked(ctx, d)
          : event.name === CI_SHIPMENT_TRACKED_EVENT
            ? await planShipmentUpdated(ctx, d)
            : event.name === CI_PAYMENT_FAILED_EVENT
              ? await planPaymentFailed(ctx, d)
              : event.name === CI_CART_REMINDER_EVENT
                ? await planCartReminder(ctx, d)
                : event.name === CI_CART_RECOVERED_EVENT
                  ? await planCartRecovered(ctx, d)
                  : event.name === CI_ONBOARDING_STEP_EVENT
                    ? await planOnboardingStep(ctx, d)
                    : [];
  await (deps.port ?? commerceOutcomesPort()).emit(planned);
  return planned.length;
}

export const ciOutcomes: JobDef = inngest.createFunction(
  {
    id: 'ci-outcomes',
    name: 'Customer Intelligence: commerce outcomes capture',
    retries: 5,
    triggers: [
      { event: 'order/created' },
      { event: 'order/status-changed' },
      { event: CI_SHIPMENT_TRACKED_EVENT },
      { event: CI_SHIPMENT_BOOKED_EVENT },
      { event: CI_PAYMENT_FAILED_EVENT },
      { event: CI_CART_REMINDER_EVENT },
      { event: CI_CART_RECOVERED_EVENT },
      { event: CI_ONBOARDING_STEP_EVENT },
    ],
  },
  async ({ event, step }) => {
    const sent = await step.run('emit', () => emitCiOutcomesFor(event as SourceEvent));
    return { sent };
  }
);
