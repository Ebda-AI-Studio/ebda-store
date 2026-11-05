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
import { allJobs } from './registry';
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
  for (const def of allJobs()) {
    if (JOBS_MAP[def.id]?.trigger !== 'cron') continue;
    const event = { name: 'inngest/scheduled.timer', data: {} };
    try {
      await guardedRun(def, event, () =>
        def.handler({ event, step, runId: `sweep-${def.id}`, attempt: 0 })
      );
      jobs.push({ id: def.id, ok: true });
    } catch (err) {
      jobs.push({
        id: def.id,
        ok: false,
        error: String((err as Error)?.message ?? err).slice(0, 200),
      });
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
