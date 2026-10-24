/**
 * One Workflow instance = one run of one job. Pure of `cloudflare:*` imports (the thin
 * `JobWorkflow` class in worker.ts injects the step, the context wrapper and NonRetryableError),
 * so the whole flow is unit-testable with a fake WorkflowStep.
 *
 *   debounce wait -> concurrency gates -> handler (each step.run = one durable step)
 *   -> on failure: onFailure + `inngest/function.failed` -> rethrow (instance shows errored)
 */
import logger from '../logger';
import { dispatchEventsToAll } from './dispatch-all';
import { failedEvent, runOnFailure } from './failure';
import { debounceClient, debounceFor, gateClient, gatesFor, type Gate } from './gate';
import { getJob } from './registry';
import { durableStep, isNonRetriable, type WorkflowStepLike } from './step-adapter';
import type { JobParams } from './start';

const NO_RETRY = {
  retries: { limit: 0, delay: '1 second' as const },
  timeout: '1 minute' as const,
};
const GATE_TTL_MS = 2 * 60 * 60_000;
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

  const held: Array<{ gate: Gate; token: string }> = [];
  for (const [i, gate] of gatesFor(def, event).entries()) {
    let token: string | null = null;
    for (let w = 0; w <= GATE_MAX_WAITS && !token; w++) {
      token = await step.do(`gate-${i}-try-${w}`, NO_RETRY, () =>
        gateClient.acquire(gate, GATE_TTL_MS)
      );
      if (!token) await step.sleep(`gate-${i}-wait-${w}`, Math.min(120_000, 10_000 * (w + 1)));
    }
    if (!token) {
      await releaseAll(step, held);
      throw new a.NonRetryable(
        `concurrency gate ${gate.gateId} not free after ${GATE_MAX_WAITS} waits`
      );
    }
    held.push({ gate, token });
  }

  const dispatch = (p: Parameters<typeof dispatchEventsToAll>[0]) => dispatchEventsToAll(p);
  const jstep = durableStep(step, {
    retries: def.options.retries ?? 4,
    withContext: a.withContext,
    dispatch,
    NonRetryable: a.NonRetryable,
  });
  try {
    await def.handler({ event, step: jstep, runId: a.instanceId, attempt: 0 });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: error, job: def.id, runId: a.instanceId }, '[jobs] run failed');
    await step.do('on-failure', NO_RETRY, () =>
      a.withContext(async () => {
        await runOnFailure(def, event, a.instanceId, error);
        await dispatchEventsToAll(failedEvent(def, event, a.instanceId, error));
        return null;
      })
    );
    if (isNonRetriable(error)) throw new a.NonRetryable(error.message);
    throw error;
  } finally {
    await releaseAll(step, held);
  }
}

async function releaseAll(step: WorkflowStepLike, held: Array<{ gate: Gate; token: string }>) {
  for (const [i, h] of held.entries()) {
    await step
      .do(`gate-release-${i}`, NO_RETRY, async () => {
        await gateClient.release(h.gate, h.token);
        return null;
      })
      .catch(err => logger.warn({ err }, '[jobs] gate release failed (lease will expire)'));
  }
}
