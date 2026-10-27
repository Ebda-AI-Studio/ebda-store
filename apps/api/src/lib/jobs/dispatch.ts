/**
 * `inngest.send`, routed. Call sites keep calling `inngest.send(...)` / `sendEventAfterCommit`; this
 * decides per event which runtime owns each subscriber:
 *  - subscribers whose group is on Cloudflare start a Workflow / queue message here;
 *  - everything else (not-yet-ported subscribers, or an event nobody here subscribes to) goes to
 *    Inngest exactly as before.
 * It throws if any start fails (after trying all), so "enqueue failed -> mark the row failed"
 * callers behave as they did on Inngest. A function that already moved is also guarded on the
 * Inngest side (lib/jobs/with-jobs.ts), so an event that still reaches Inngest cannot run it twice.
 */
import logger from '../logger';
import { jobRunsOnCf } from './flag';
import { jobsForEvent } from './registry';
import { startJob } from './start';
import type { JobEvent } from './types';

export async function dispatchEvents<R>(
  payload: JobEvent | JobEvent[],
  sendToInngest: (p: JobEvent[]) => Promise<R>
): Promise<R | { ids: string[] }> {
  const events = Array.isArray(payload) ? payload : [payload];
  const forInngest: JobEvent[] = [];
  const failures: unknown[] = [];

  for (const ev of events) {
    const subs = jobsForEvent(ev.name);
    const cf = subs.filter(d => jobRunsOnCf(d.id));
    // `inngest/*` names are reserved: Inngest's API refuses them (400), and the only subscriber of
    // `inngest/function.failed` is alerts-failure-watch. Until that moves, a failure event with no
    // Cloudflare subscriber is dropped here instead of failing the run's own failure step.
    const reserved = ev.name.startsWith('inngest/');
    if (!reserved && (subs.length === 0 || cf.length < subs.length)) forInngest.push(ev);
    const results = await Promise.allSettled(cf.map(d => startJob(d, ev)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failures.push(r.reason);
        logger.error({ err: r.reason, job: cf[i].id, event: ev.name }, '[jobs] start failed');
      }
    });
  }

  let inngestResult: R | undefined;
  try {
    if (forInngest.length > 0) inngestResult = await sendToInngest(forInngest);
  } catch (err) {
    failures.push(err);
  }
  if (failures.length > 0) {
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'job dispatch failed');
  }
  return inngestResult ?? { ids: [] };
}
