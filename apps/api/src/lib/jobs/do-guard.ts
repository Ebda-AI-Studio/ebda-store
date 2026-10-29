/**
 * Background jobs and the stores that live on their Durable Object (INFRA-CF-1 PR E, Ruling CF-JOBS-1).
 *
 * A store is "on the DO" for jobs when `JOBS_ON_DO=1` AND the store is flagged (lib/store-backend.ts). `JOBS_ON_DO` is the
 * one switch the cutover flips together with the flag; while it is off (today, every store on Postgres) NOTHING in this
 * file changes behaviour: no scope, no refusal, no alert.
 *
 * Once it is on, every job run goes through `guardedRun` / `decideRun`:
 *   - the job's store (alarm scope or `event.data.storeId`) is a DO store and the job is `unported` (lib/jobs/job-data.ts):
 *     REFUSED before it starts, with an alert (P0 when it is a money job). Not retried, not run, no Postgres write;
 *   - any other run executes inside a repo scope that follows the flag (`storeDb`/`storeWriter` reach the DO) and inside
 *     `withHiddenStores`, so a sweep's store list (`storeDirectory`, `acrossStores`) drops the DO stores. A dropped store
 *     is alerted once per run for an `unported` job (it is being skipped) and silently for a `ported` one (its alarm owns it).
 * `none` jobs (platform tables, logs) are never touched.
 */
import { withHiddenStores } from '@ebda/database';
import logger from '../logger';
import { sendAlert } from '../../services/alerts.service';
import { enabledStoreIds } from '../store-backend';
import { runInJobRepoScope } from '../repo-factory';
import { webhookInbox } from '../definer';
import { jobDataClass, MONEY_JOBS } from './job-data';
import { alarmStoreId } from './store-scope';
import type { JobDef, JobEvent } from './types';

export function jobsOnDo(): boolean {
  return process.env.JOBS_ON_DO === '1';
}

/** Stores whose data lives on their Durable Object, as far as jobs are concerned. Empty = today. */
export function doStoreIds(): ReadonlySet<string> {
  return jobsOnDo() ? enabledStoreIds() : new Set<string>();
}

/** The store a run is about: the alarm's store, else a string `event.data.storeId`. */
export function jobTargetStore(event: JobEvent): string | undefined {
  const alarm = alarmStoreId(event);
  if (alarm) return alarm;
  const id = event.data?.storeId;
  return typeof id === 'string' && id ? id : undefined;
}

export type RunDecision = { run: true } | { run: false; storeId: string; money: boolean };

/**
 * Events that carry NO `storeId` of their own name the store through a reference the job's data holds. The resolver reads
 * it (a platform lookup, never the store's tables) so a DO store's event is refused/served like any other. Today only
 * `payment/webhook.received` (`storeId` optional, "undefined for the platform-only path"): its inbox row holds the store
 * the route resolved from the provider reference (WEBHOOK-SCOPE-1). A run for which NO store can be named stays on
 * Postgres exactly as before: nothing of a DO store can be reached from it (a DO store's payment reference does not
 * resolve there until the D1 entity index, plan task 3.5, lands - recorded in Ruling CF-MONEY-1).
 */
export const EVENT_STORE_RESOLVERS: Readonly<
  Record<string, (event: JobEvent) => Promise<string | undefined>>
> = {
  'payment-webhook-process': async event => {
    const id = event.data?.webhookEventId;
    if (typeof id !== 'string' || !id) return undefined;
    const row = await webhookInbox.get(id);
    return row?.storeId ?? undefined;
  },
};

/** True when the run's store must be looked up (JOBS_ON_DO on, the event carries none, the job has a resolver). */
export function needsStoreLookup(def: JobDef, event: JobEvent): boolean {
  return doStoreIds().size > 0 && !jobTargetStore(event) && def.id in EVENT_STORE_RESOLVERS;
}

/** The store a run is about, resolving it from a reference when the event does not carry it. Never throws. */
export async function resolveRunStore(def: JobDef, event: JobEvent): Promise<string | undefined> {
  const direct = jobTargetStore(event);
  if (direct) return direct;
  const resolver = EVENT_STORE_RESOLVERS[def.id];
  if (!resolver || doStoreIds().size === 0) return undefined;
  try {
    return await resolver(event);
  } catch (err) {
    // A failed lookup must not turn into "run against Postgres" silently for a store that may be a DO store.
    logger.error(
      { err, job: def.id },
      '[jobs] could not resolve the store of an event; running as platform-only'
    );
    return undefined;
  }
}

export function decideRunForStore(def: JobDef, storeId: string | undefined): RunDecision {
  const dos = doStoreIds();
  if (dos.size === 0 || jobDataClass(def.id) !== 'unported') return { run: true };
  if (storeId && dos.has(storeId)) return { run: false, storeId, money: MONEY_JOBS.has(def.id) };
  return { run: true };
}

export function decideRun(def: JobDef, event: JobEvent): RunDecision {
  return decideRunForStore(def, jobTargetStore(event));
}

/** Loud refusal: log + alert, never the job's own failure path (its `onFailure` would write to Postgres). */
export async function reportRefusal(
  def: JobDef,
  event: JobEvent,
  runId: string,
  d: Extract<RunDecision, { run: false }>
): Promise<void> {
  logger.error(
    { job: def.id, storeId: d.storeId, runId, event: event.name },
    '[jobs] REFUSED: job is not ported to the store Durable Object'
  );
  await sendAlert({
    level: d.money ? 'p0' : 'p1',
    source: 'jobs-do-guard',
    title: `Job ${def.id} refused for DO store ${d.storeId}`,
    body:
      `${def.id} still reads/writes this store's Postgres tables and the store is served by its Durable Object, ` +
      `so it was NOT run (run ${runId}, event ${event.name}). ${d.money ? 'It is a money/stock job: the work it skips is real. ' : ''}` +
      `It runs again once it is ported (docs/cf/jobs-on-do.md).`,
  }).catch(err => logger.error({ err, job: def.id }, '[jobs] refusal alert failed'));
}

/** Run a job body (a whole queue handler, or one Workflow step) inside the DO-aware scope. */
export async function guardedRun<T>(
  def: JobDef,
  event: JobEvent,
  fn: () => Promise<T>
): Promise<T> {
  const dos = doStoreIds();
  const cls = jobDataClass(def.id);
  if (dos.size === 0 || cls === 'none') return fn();
  const only = alarmStoreId(event);
  // A ported alarm run for store S must still be able to LIST S; every other DO store stays hidden.
  const hidden = new Set([...dos].filter(id => !(cls === 'ported' && id === only)));
  const excluded = new Set<string>();
  try {
    return await runInJobRepoScope(() =>
      withHiddenStores({ hidden, onExcluded: ids => ids.forEach(i => excluded.add(i)) }, fn)
    );
  } finally {
    if (excluded.size > 0 && cls === 'unported') {
      const ids = [...excluded];
      logger.error({ job: def.id, storeIds: ids }, '[jobs] sweep skipped DO stores (not ported)');
      await sendAlert({
        level: MONEY_JOBS.has(def.id) ? 'p0' : 'p1',
        source: 'jobs-do-guard',
        title: `Job ${def.id} skipped ${ids.length} DO store(s)`,
        body: `Not ported to the store Durable Object, so its sweep did not include: ${ids.join(', ')}.`,
      }).catch(err => logger.error({ err, job: def.id }, '[jobs] skip alert failed'));
    }
  }
}
