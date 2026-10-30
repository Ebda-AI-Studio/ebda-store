/**
 * One Workflow instance = one run of one job. Pure of `cloudflare:*` imports (the thin
 * `JobWorkflow` class in worker.ts injects the step, the context wrapper and NonRetryableError),
 * so the whole flow is unit-testable with a fake WorkflowStep.
 *
 *   debounce wait -> concurrency gates -> handler (each step.run = one durable step)
 *   -> on failure: onFailure + `inngest/function.failed` -> rethrow (instance shows errored)
 *
 * Concurrency (Inngest `concurrency`) is a lease per gate: taken before the handler, renewed
 * before EVERY step body (fencing: a lost lease aborts the run before it touches anything),
 * released while the run sleeps and re-taken after, released on success and on failure.
 */
import logger from '../logger';
import { dispatchEventsToAll } from './dispatch';
import {
  decideRunForStore,
  guardedRun,
  jobTargetStore,
  needsStoreLookup,
  reportRefusal,
  resolveRunStore,
} from './do-guard';
import { FREEZE_MAX_WAITS, FREEZE_PARK_SECONDS, writesFrozen } from './freeze';
import { reportJobFailure, runOnFailure } from './failure';
import {
  debounceClient,
  debounceFor,
  GATE_LEASE_TTL_MS,
  gateClient,
  gatesFor,
  type Gate,
} from './gate';
import { getJob } from './registry';
import { durableStep, isNonRetriable, type WorkflowStepLike } from './step-adapter';
import type { JobParams } from './start';

const NO_RETRY = {
  retries: { limit: 0, delay: '1 second' as const },
  timeout: '1 minute' as const,
};
const GATE_MAX_WAITS = 120;

export interface RunWorkflowArgs {
  params: JobParams;
  instanceId: string;
  step: WorkflowStepLike;
  withContext: <T>(fn: () => Promise<T>) => Promise<T>;
  NonRetryable: new (message: string) => Error;
}

export async function runJobWorkflow(a: RunWorkflowArgs): Promise<void> {
  const { params, step } = a;
  const def = getJob(params.fn);
  if (!def) throw new a.NonRetryable(`unknown job ${params.fn}`);
  const event = params.event;

  const deb = debounceFor(def, event);
  if (deb && params.debounceToken) {
    await step.sleep('debounce-wait', deb.periodMs);
    const latest = await step.do('debounce-latest', NO_RETRY, () =>
      debounceClient.isLatest(deb, params.debounceToken!)
    );
    if (!latest) {
      logger.info({ job: def.id }, '[jobs] superseded by a newer event (debounce)');
      return;
    }
  }

  const gates = gatesFor(def, event);
  const held = new Map<Gate, string>();
  let generation = 0;

  /** Take every gate (in order); waits with a Workflow sleep while one is busy. */
  const acquireAll = async (): Promise<void> => {
    const gen = generation++;
    for (const [i, gate] of gates.entries()) {
      let token: string | null = null;
      for (let w = 0; w <= GATE_MAX_WAITS && !token; w++) {
        token = await step.do(`gate${gen}-${i}-try-${w}`, NO_RETRY, () =>
          gateClient.acquire(gate, GATE_LEASE_TTL_MS)
        );
        if (!token)
          await step.sleep(`gate${gen}-${i}-wait-${w}`, Math.min(120_000, 10_000 * (w + 1)));
      }
      if (!token) {
        await releaseAll();
        throw new a.NonRetryable(
          `concurrency gate ${gate.gateId} not free after ${GATE_MAX_WAITS} waits`
        );
      }
      held.set(gate, token);
    }
  };

  /** Fencing check, inside a step: every held lease must still be ours. */
  const renewAll = async (): Promise<void> => {
    for (const [gate, token] of held) {
      if (!(await gateClient.renew(gate, token, GATE_LEASE_TTL_MS))) {
        throw new a.NonRetryable(`concurrency lease on ${gate.gateId} was lost; run aborted`);
      }
    }
  };

  let released = 0;
  const releaseAll = async (): Promise<void> => {
    const entries = [...held.entries()];
    held.clear();
    for (const [gate, token] of entries) {
      await step
        .do(`gate-release-${released++}`, NO_RETRY, async () => {
          await gateClient.release(gate, token);
          return null;
        })
        .catch(err => logger.warn({ err }, '[jobs] gate release failed (lease will expire)'));
    }
  };

  // Write freeze (Ruling CF-JOBS-2): park before anything runs, and again before EVERY later step. The wait is a Workflow
  // sleep, so a long window costs no CPU and loses nothing. Held concurrency leases are released for the sleep and re-taken.
  let freezeSleeps = 0;
  const waitUnfrozen = async (): Promise<void> => {
    let waits = 0;
    while (writesFrozen()) {
      if (++waits > FREEZE_MAX_WAITS) {
        throw new a.NonRetryable(`write freeze lasted over ${FREEZE_MAX_WAITS} waits; run aborted`);
      }
      const hadGates = held.size > 0;
      if (hadGates) await releaseAll();
      logger.warn({ job: def.id, runId: a.instanceId }, '[jobs] write freeze: run parked');
      await step.sleep(`freeze-wait-${freezeSleeps++}`, FREEZE_PARK_SECONDS * 1000);
      if (hadGates) await acquireAll();
    }
  };
  await waitUnfrozen();

  // A DO store's job that still reads/writes its Postgres tables does not run (Ruling CF-JOBS-1).
  // The lookup needs a database connection, which code outside a step does not have on a Workflow: it is its own step.
  const runStore = (await needsStoreLookup(def, event))
    ? await step.do(
        'resolve-run-store',
        NO_RETRY,
        async () => (await resolveRunStore(def, event)) ?? null
      )
    : (jobTargetStore(event) ?? null);
  const decision = await decideRunForStore(def, runStore ?? undefined);
  if (!decision.run) {
    await step.do('do-guard-refusal', NO_RETRY, async () => {
      await reportRefusal(def, event, a.instanceId, decision);
      return null;
    });
    return;
  }

  if (gates.length > 0) await acquireAll();

  const jstep = durableStep(step, {
    retries: def.options.retries ?? 4,
    withContext: fn => a.withContext(() => guardedRun(def, event, fn)),
    beforeStepWait: waitUnfrozen,
    dispatch: p => dispatchEventsToAll(p),
    NonRetryable: a.NonRetryable,
    ...(gates.length > 0
      ? {
          beforeStep: renewAll,
          aroundSleep: { before: releaseAll, after: acquireAll },
        }
      : {}),
  });
  try {
    await def.handler({ event, step: jstep, runId: a.instanceId, attempt: 0 });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: error, job: def.id, runId: a.instanceId }, '[jobs] run failed');
    await step.do('on-failure', NO_RETRY, () =>
      a.withContext(async () => {
        await runOnFailure(def, event, a.instanceId, error);
        // The step output is the proof of delivery: alert outcome + Sentry event id + flush result.
        return reportJobFailure(def, event, a.instanceId, error);
      })
    );
    if (isNonRetriable(error)) throw new a.NonRetryable(error.message);
    throw error;
  } finally {
    await releaseAll();
  }
}
