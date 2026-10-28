/**
 * `inngest.send`, routed: starts a Workflow instance or a queue message for EVERY job subscribed to
 * each event (lib/jobs/start.ts). It starts all of them, then throws if any start failed, so the
 * "enqueue failed -> mark the row failed" callers behave as they did before. Without the Worker
 * bindings (Node: tests, scripts, local dev) nothing is started, as with the old dry-run send.
 */
import logger from '../logger';
import { jobRunsOnCf } from './flag';
import { jobsForEvent } from './registry';
import { startJob } from './start';
import type { JobEvent } from './types';
import { cfBindings } from '../../cf/bindings';

export async function dispatchEvents(payload: JobEvent | JobEvent[]): Promise<{ ids: string[] }> {
  const events = Array.isArray(payload) ? payload : [payload];
  if (!cfBindings()) return { ids: [] };
  const failures: unknown[] = [];

  for (const ev of events) {
    const subs = jobsForEvent(ev.name).filter(d => jobRunsOnCf(d.id));
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
