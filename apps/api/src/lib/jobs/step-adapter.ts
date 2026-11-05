/**
 * `step` for the two Cloudflare runtimes. Handler code is unchanged from Inngest:
 *  - `durableStep` (Workflows): `step.run` = one `step.do` (own retries, result persisted), sleeps
 *    are real Workflow sleeps (no CPU, no connection held).
 *  - `inlineStep` (Queues): `step.run` just runs; the whole handler is retried by the queue, so it
 *    is only used for handlers with at most one step (lib/jobs/jobs-map.ts `queue`).
 * Step results are JSON-normalised exactly like Inngest's (Date -> string, undefined -> null) so a
 * handler sees the same shape on the first run and on a replay.
 */
import type { JobEvent, JobStep } from './types';

/** The slice of Cloudflare's `WorkflowStep` used here (structural: the API does not load workers-types). */
export interface WorkflowStepLike {
  do<T>(
    name: string,
    config: {
      retries?: {
        limit: number;
        delay: string | number;
        backoff?: 'constant' | 'linear' | 'exponential';
      };
      timeout?: string | number;
    },
    callback: () => Promise<T>
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
}

/** Workflows persist each step result; keep well under the 1 MiB per-step limit. */
export const MAX_STEP_RESULT_BYTES = 900_000;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `'30s'`, `'5m'`, `'2 hours'`, `1500` (ms) -> milliseconds. */
export function parseDurationMs(d: string | number): number {
  if (typeof d === 'number') return Math.max(0, d);
  const m =
    /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\s*$/i.exec(
      d
    );
  if (!m) throw new Error(`unparseable duration: ${d}`);
  const u = m[2].toLowerCase();
  const key = u === 'ms' ? 'ms' : u[0];
  return Math.round(Number(m[1]) * UNITS[key]);
}

/** Inngest-style JSON result: what a replayed step would have returned. */
export function normaliseResult<T>(value: T): T {
  if (value === undefined) return null as T;
  const json = JSON.stringify(value);
  if (json === undefined) return null as T;
  if (json.length > MAX_STEP_RESULT_BYTES) {
    throw new StepResultTooLarge(json.length);
  }
  return JSON.parse(json) as T;
}

export class StepResultTooLarge extends Error {
  readonly name = 'NonRetriableError';
  constructor(bytes: number) {
    super(`step result is ${bytes} bytes (limit ${MAX_STEP_RESULT_BYTES}): return ids, not rows`);
  }
}

export function isNonRetriable(err: unknown): boolean {
  return err instanceof Error && err.name === 'NonRetriableError';
}

/** Names repeat in loops; the Nth use of `id` becomes `id#N` (stable across replays). */
function uniqueNamer(): (id: string) => string {
  const seen = new Map<string, number>();
  return id => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  };
}

export interface DurableStepOptions {
  /** Inngest `retries` (extra attempts after the first). Inngest's default is 4. */
  retries: number;
  /** Runs a step body inside a Worker context (bindings, leased database client). */
  withContext: <T>(fn: () => Promise<T>) => Promise<T>;
  dispatch: (payload: JobEvent | JobEvent[]) => Promise<unknown>;
  /** Runs before every step body (inside the step): renews the concurrency lease, throws if lost. */
  beforeStep?: () => Promise<void>;
  /** Awaited before every step starts (the write freeze parks the run here, outside the step). */
  beforeStepWait?: () => Promise<void>;
  /** Called around sleeps: release the gates before, re-acquire after. */
  aroundSleep?: { before: () => Promise<void>; after: () => Promise<void> };
  /** Cloudflare's `NonRetryableError` constructor (from `cloudflare:workflows`). */
  NonRetryable: new (message: string) => Error;
}

export function durableStep(wf: WorkflowStepLike, o: DurableStepOptions): JobStep {
  const name = uniqueNamer();
  const cfg = {
    retries: {
      limit: Math.max(0, o.retries),
      delay: '10 seconds',
      backoff: 'exponential' as const,
    },
    timeout: '15 minutes',
  };
  const run = async <T>(id: string, fn: () => Promise<T> | T, config = cfg): Promise<T> => {
    const stepName = name(id); // numbered synchronously: the Nth use of an id keeps its number across replays
    await o.beforeStepWait?.();
    return wf.do(stepName, config, () =>
      o.withContext(async () => {
        try {
          await o.beforeStep?.();
          return normaliseResult(await fn());
        } catch (err) {
          // Inngest's NonRetriableError = Workflows' NonRetryableError.
          if (isNonRetriable(err)) throw new o.NonRetryable((err as Error).message);
          throw err;
        }
      })
    );
  };
  return {
    run: run as JobStep['run'],
    // Marker read by `stepRunUnlessEmpty`: code between steps has no database on a Workflow.
    cfWorkflow: true,
    async sleep(id, duration) {
      await o.aroundSleep?.before();
      await wf.sleep(name(id), parseDurationMs(duration));
      await o.aroundSleep?.after();
    },
    async sleepUntil(id, until) {
      await o.aroundSleep?.before();
      await wf.sleepUntil(name(id), until instanceof Date ? until : new Date(until));
      await o.aroundSleep?.after();
    },
    // Dispatch must not repeat on replay: it is its own durable step.
    sendEvent: (id, payload) =>
      run(id, () => o.dispatch(payload).then(() => null), {
        ...cfg,
        retries: { ...cfg.retries, limit: 2 },
      }),
  };
}

export function inlineStep(o: {
  dispatch: (payload: JobEvent | JobEvent[]) => Promise<unknown>;
}): JobStep {
  return {
    async run<T>(_id: string, fn: () => T): Promise<Awaited<T>> {
      return normaliseResult(await fn());
    },
    async sleep() {
      throw new Error('step.sleep is not available on the queue runtime (job is mapped as queue)');
    },
    async sleepUntil() {
      throw new Error(
        'step.sleepUntil is not available on the queue runtime (job is mapped as queue)'
      );
    },
    async sendEvent(_id, payload) {
      await o.dispatch(payload);
      return null;
    },
  };
}
