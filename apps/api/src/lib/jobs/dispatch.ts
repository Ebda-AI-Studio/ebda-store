/**
 * `inngest.send`, routed: starts a Workflow instance or a queue message for EVERY job subscribed to
 * each event (lib/jobs/start.ts). It starts all of them, then throws if any start failed, so the
 * "enqueue failed -> mark the row failed" callers behave as they did before. Without the Worker
 * bindings (Node: tests, scripts, local dev) nothing is started, as with the old dry-run send.
 *
 * Inside the Worker an event that would start NOTHING (no job subscribes to it, or the Workflows /
 * Queue bindings are unbound) THROWS (Ruling JOBS-ORPHAN-1): a silent no-op left job rows `queued`
 * forever. Callers that create a row first mark it failed on this throw (lib/jobs/enqueue-fail.ts).
 */
import logger from '../logger';
import { jobRunsOnCf } from './flag';
import { jobsForEvent } from './registry';
import { startJob } from './start';
import type { JobEvent } from './types';
import { cfBindings } from '../../cf/bindings';

/**
 * Test/diagnostic only (the Worker turns it on under DEV_STATS=1, never on a deployed Worker): every event dispatched, with
 * its order id, so a workers-test can assert an event fired EXACTLY once (money-path.test.ts: a retried keyed checkout).
 */
let trackDispatch = false;
const dispatched: Array<{ name: string; orderId: string | null }> = [];
export function trackDispatches(on: boolean): void {
  trackDispatch = on;
}
export function dispatchedEvents(): Array<{ name: string; orderId: string | null }> {
  return dispatched.slice();
}

export async function dispatchEvents(payload: JobEvent | JobEvent[]): Promise<{ ids: string[] }> {
  const events = Array.isArray(payload) ? payload : [payload];
  if (trackDispatch && dispatched.length < 2000)
    for (const ev of events) {
      const orderId = (ev.data as { orderId?: unknown } | undefined)?.orderId;
      dispatched.push({ name: ev.name, orderId: typeof orderId === 'string' ? orderId : null });
    }
  if (!cfBindings()) return { ids: [] };
  const failures: unknown[] = [];

  for (const ev of events) {
    const all = jobsForEvent(ev.name);
    const subs = all.filter(d => jobRunsOnCf(d.id));
    if (subs.length === 0) {
      const reason = all.length === 0 ? 'no job subscribes to this event' : 'no runner is bound';
      const err = new Error(`[jobs] event "${ev.name}" would start nothing: ${reason}`);
      logger.error({ event: ev.name, jobs: all.map(d => d.id), reason }, '[jobs] dispatch no-op');
      failures.push(err);
      continue;
    }
    const results = await Promise.allSettled(subs.map(d => startJob(d, ev)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failures.push(r.reason);
        logger.error({ err: r.reason, job: subs[i].id, event: ev.name }, '[jobs] start failed');
      }
    });
  }

  if (failures.length > 0) {
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'job dispatch failed');
  }
  return { ids: [] };
}

/** Dispatch used by running jobs (`step.sendEvent`, the failure event). */
export const dispatchEventsToAll = dispatchEvents;
