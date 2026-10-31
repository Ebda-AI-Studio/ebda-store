/**
 * Start one Cloudflare run of a job for an event: a Workflow instance (kind `workflow`) or a
 * message on the jobs Queue (kind `queue`). Throws when the start fails, so callers keep the
 * Inngest-era contract: an enqueue error reaches the code that marks its row `failed`.
 */
import { cfBindings } from '../../cf/bindings';
import { JOBS_MAP } from './jobs-map';
import { debounceClient, debounceFor } from './gate';
import { instanceId, readEventKey } from './path';
import type { JobDef, JobEvent } from './types';

export const JOBS_QUEUE_NAME = 'ebda-jobs';
export const JOBS_DLQ_NAME = 'ebda-jobs-dlq';

export interface JobParams {
  fn: string;
  event: JobEvent;
  /** Debounce: the token this event registered with the gate. */
  debounceToken?: string;
}

export interface JobQueueMessage extends JobParams {
  kind: 'job';
  /** Times this message was parked waiting for a concurrency gate. */
  waits?: number;
}

export function isJobQueueMessage(v: unknown): v is JobQueueMessage {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { kind?: unknown }).kind === 'job' &&
    typeof (v as { fn?: unknown }).fn === 'string' &&
    typeof (v as { event?: { name?: unknown } }).event?.name === 'string'
  );
}

/** A rare legacy cron (cf/cron.ts CRON_SCHEDULE) that fell in a write freeze: parked on the jobs queue, run after it. */
export interface LegacyCronMessage {
  kind: 'legacy-cron';
  name: string;
  cron: string;
}

export function isLegacyCronMessage(v: unknown): v is LegacyCronMessage {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { kind?: unknown }).kind === 'legacy-cron' &&
    typeof (v as { name?: unknown }).name === 'string' &&
    typeof (v as { cron?: unknown }).cron === 'string'
  );
}

const ALREADY_EXISTS = /already.*exist|exists|duplicate/i;

export async function startJob(def: JobDef, event: JobEvent): Promise<'started' | 'duplicate'> {
  const b = cfBindings();
  const entry = JOBS_MAP[def.id];
  if (!b || !entry)
    throw new Error(`job ${def.id} cannot start on Cloudflare (binding or map entry missing)`);
  const ev: JobEvent = {
    ...event,
    id: event.id ?? crypto.randomUUID(),
    ts: event.ts ?? Date.now(),
  };
  const deb = debounceFor(def, ev);
  const debounceToken = deb ? await debounceClient.touch(deb) : undefined;
  const params: JobParams = { fn: def.id, event: ev, ...(debounceToken ? { debounceToken } : {}) };

  if (entry.kind === 'queue') {
    if (!b.JOBS_QUEUE) throw new Error('JOBS_QUEUE binding missing');
    const message: JobQueueMessage = { kind: 'job', ...params };
    await b.JOBS_QUEUE.send(message, {
      contentType: 'json',
      ...(deb ? { delaySeconds: Math.min(43_200, Math.ceil(deb.periodMs / 1000)) } : {}),
    });
    return 'started';
  }

  if (!b.JOBS_WORKFLOW) throw new Error('JOBS_WORKFLOW binding missing');
  // The id is the dedupe key: Inngest `idempotency` (e.g. a delivery id) or the event id.
  const idem = readEventKey(ev, def.options.idempotency);
  const id = await instanceId([def.id, idem ?? ev.id!]);
  try {
    await b.JOBS_WORKFLOW.create({ id, params });
    return 'started';
  } catch (err) {
    // A re-create of the same id is a no-op for ANY deterministic id: an idempotency key, a cron tick
    // (`cron-<job>-<ts>`) or a store alarm occurrence (`alarm-<job>-<store>-<at>`). Random ids never collide.
    if (ALREADY_EXISTS.test(err instanceof Error ? err.message : String(err))) {
      return 'duplicate';
    }
    throw err;
  }
}
