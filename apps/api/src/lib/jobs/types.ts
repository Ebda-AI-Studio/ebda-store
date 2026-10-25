/**
 * The shape of a background job, independent of who runs it (Inngest today, Cloudflare Workflows /
 * Queues after G5). Handlers keep the Inngest `({ event, step })` contract, so a function body
 * moves between runtimes without being rewritten; only `step` is implemented twice.
 */
export interface JobEvent {
  id?: string;
  name: string;
  data?: Record<string, unknown>;
  ts?: number;
}

export interface JobStep {
  /** One durable, retried unit. Its result is JSON (Dates become strings), as on Inngest. */
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  /** `'30s'`, `'5m'`, `'2h'`, `'1d'` or milliseconds. */
  sleep(id: string, duration: string | number): Promise<void>;
  sleepUntil(id: string, until: Date | string | number): Promise<void>;
  /** Emit follow-up events through the job dispatcher (routes per group). */
  sendEvent(id: string, payload: JobEvent | JobEvent[]): Promise<unknown>;
}

export interface JobCtx {
  event: JobEvent;
  step: JobStep;
  runId: string;
  /** Function-level attempt (0-based). Workflows retry per step, so this is 0 there. */
  attempt: number;
}

export type JobHandler = (ctx: JobCtx) => Promise<unknown>;

export interface JobFailureCtx {
  /** `inngest/function.failed`-shaped: `event.data.event` is the original trigger. */
  event: { name: string; data: Record<string, unknown> };
  error: Error;
}

export type JobTrigger = { event?: string; cron?: string };

export interface JobOptions {
  id: string;
  name?: string;
  retries?: number;
  triggers?: JobTrigger[];
  concurrency?: ConcurrencySpec | ConcurrencySpec[];
  debounce?: { key?: string; period: string; timeout?: string };
  idempotency?: string;
  onFailure?: (ctx: JobFailureCtx) => Promise<unknown> | unknown;
}

export interface ConcurrencySpec {
  limit: number;
  /** `event.data.storeId`-style path; absent = one global bucket. */
  key?: string;
}

export interface JobDef {
  id: string;
  options: JobOptions;
  handler: JobHandler;
}
