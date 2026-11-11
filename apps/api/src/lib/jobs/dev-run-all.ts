/**
 * Dev/test only (worker.ts `/__dev/run-jobs`, DEV_STATS=1, never set in wrangler.jsonc): run the BODY of every cron-triggered job and
 * every Postgres-adjacent queue message through the same guard the consumers use, so the dead-Postgres route sweep can count the
 * Postgres reaches each one makes (POSTGRES_REMOVED counted as failure; workers-test/route-sweep.test.ts, cron group).
 * A job that throws is reported, not fatal: the sweep measures reaches, not job outcomes.
 */
import { dispatchEventsToAll } from './dispatch';
import { guardedRun } from './do-guard';
import { handleJobsBatch, type QueueMessageLike } from './run-queue';
import { JOBS_MAP } from './jobs-map';
import { allJobs, jobsForEvent } from './registry';
import { doStoreIdList } from '../store-backend';
import { inlineStep } from './step-adapter';
import type { JobStep } from './types';

export interface RunAllReport {
  jobs: Array<{ id: string; ok: boolean; error?: string }>;
  queueMessages: string[];
}

export async function runEveryJobBody(): Promise<RunAllReport> {
  const base = inlineStep({ dispatch: dispatchEventsToAll });
  // a workflow job sleeps between steps: the sweep does not wait
  const step: JobStep = {
    ...base,
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
  };
  const jobs: RunAllReport['jobs'] = [];
  // A cron run (unscoped), then - for every alarm-enabled job - the run each DO store's own alarm makes
  // (`data: { alarm: true, storeId }`, lib/jobs/store-scope.ts): production runs these per store, a cron run does not.
  const storeIds = await doStoreIdList();
  for (const def of allJobs()) {
    const entry = JOBS_MAP[def.id];
    if (entry?.trigger !== 'cron') continue;
    const runs = [
      { label: def.id, data: {} as Record<string, unknown> },
      ...(entry.alarm
        ? storeIds.map(storeId => ({
            label: `${def.id}@${storeId}`,
            data: { alarm: true, storeId },
          }))
        : []),
    ];
    for (const r of runs) {
      const event = { name: 'inngest/scheduled.timer', data: r.data };
      try {
        await guardedRun(def, event, () =>
          def.handler({ event, step, runId: `sweep-${r.label}`, attempt: 0 })
        );
        jobs.push({ id: r.label, ok: true });
      } catch (err) {
        jobs.push({
          id: r.label,
          ok: false,
          error: String((err as Error)?.message ?? err).slice(0, 300),
        });
      }
    }
  }
  // Queue consumers that touch Postgres by design on a Node deployment: they must be no-ops on a Worker without it.
  const bodies: Array<Record<string, unknown>> = [
    {
      kind: 'pg-copy-scrub',
      userId: '00000000-0000-4000-8000-0000000000aa',
      storeId: '00000000-0000-4000-8000-0000000000bb',
    },
  ];
  const messages: QueueMessageLike[] = bodies.map((body, i) => ({
    id: `sweep-msg-${i}`,
    body,
    attempts: 1,
    ack: () => undefined,
    retry: () => undefined,
  }));
  await handleJobsBatch({ queue: 'ebda-jobs', messages });
  return { jobs, queueMessages: bodies.map(b => String(b.kind)) };
}

/**
 * Dev/test only (worker.ts `/__dev/run-event`, DEV_STATS=1): run, inline and once, the body of every job an event triggers,
 * through the same guard the workflow uses. The workerd harness does not execute event jobs (a Workflow instance), so a test
 * that must prove what a job body does on a DO store (workers-test/merchant-orders-do.test.ts: the CSV import) runs it here.
 */
export async function runEventJobs(
  name: string,
  data: Record<string, unknown>
): Promise<RunAllReport['jobs']> {
  const base = inlineStep({ dispatch: dispatchEventsToAll });
  const step: JobStep = {
    ...base,
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
  };
  const out: RunAllReport['jobs'] = [];
  for (const def of jobsForEvent(name)) {
    const event = { name, data };
    try {
      await guardedRun(def, event, () =>
        def.handler({ event, step, runId: `dev-event-${def.id}`, attempt: 0 })
      );
      out.push({ id: def.id, ok: true });
    } catch (err) {
      out.push({
        id: def.id,
        ok: false,
        error: String((err as Error)?.message ?? err).slice(0, 300),
      });
    }
  }
  return out;
}
