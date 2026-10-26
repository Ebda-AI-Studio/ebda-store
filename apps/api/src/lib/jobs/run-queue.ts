/**
 * The `ebda-jobs` Queue consumer: runs `queue`-kind jobs (at most one step) and the DLQ.
 * Retries are the job's own `retries` (Inngest semantics: N retries = N+1 attempts) with the
 * queue's exponential delay; a NonRetriableError or the last failed attempt runs the failure
 * path (onFailure + `inngest/function.failed`) and acks. A gate that is busy re-sends the
 * message with a delay instead of burning an attempt.
 */
import logger from '../logger';
import { dispatchEventsToAll } from './dispatch-all';
import { failedEvent, runOnFailure } from './failure';
import {
  debounceClient,
  debounceFor,
  GATE_LEASE_TTL_MS,
  gateClient,
  gatesFor,
  type Gate,
} from './gate';
import { getJob } from './registry';
import { inlineStep, isNonRetriable } from './step-adapter';
import { isJobQueueMessage, JOBS_DLQ_NAME, type JobQueueMessage } from './start';
import { cfBindings } from '../../cf/bindings';

const GATE_MAX_WAITS = 120;

export interface QueueMessageLike {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}

export interface JobsBatchLike {
  queue: string;
  messages: ReadonlyArray<QueueMessageLike>;
}

/** 5 s, 10 s, 20 s ... capped at 5 min (same curve as the email queue). */
export function jobRetryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

export async function handleJobsBatch(batch: JobsBatchLike): Promise<void> {
  for (const msg of batch.messages) {
    if (batch.queue === JOBS_DLQ_NAME) {
      await handleDeadLetter(msg);
      continue;
    }
    await handleOne(msg);
  }
}

async function handleOne(msg: QueueMessageLike): Promise<void> {
  if (!isJobQueueMessage(msg.body)) {
    logger.error({ id: msg.id }, '[jobs] unreadable queue message dropped');
    msg.ack();
    return;
  }
  const body = msg.body;
  const def = getJob(body.fn);
  if (!def) {
    logger.error({ id: msg.id, job: body.fn }, '[jobs] message for an unknown job dropped');
    msg.ack();
    return;
  }
  const event = body.event;

  const deb = debounceFor(def, event);
  if (deb && body.debounceToken && !(await debounceClient.isLatest(deb, body.debounceToken))) {
    msg.ack();
    return;
  }

  const held: Array<{ gate: Gate; token: string }> = [];
  try {
    for (const gate of gatesFor(def, event)) {
      const token = await gateClient.acquire(gate, GATE_LEASE_TTL_MS);
      if (!token) {
        await release(held);
        await parkForGate(msg, body, gate);
        return;
      }
      held.push({ gate, token });
    }
    await def.handler({
      event,
      step: inlineStep({ dispatch: dispatchEventsToAll }),
      runId: msg.id,
      attempt: msg.attempts - 1,
    });
    msg.ack();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const retries = def.options.retries ?? 4;
    if (isNonRetriable(error) || msg.attempts > retries) {
      logger.error({ err: error, job: def.id, attempts: msg.attempts }, '[jobs] run failed');
      await runOnFailure(def, event, msg.id, error);
      await dispatchEventsToAll(failedEvent(def, event, msg.id, error)).catch(e =>
        logger.error({ err: e, job: def.id }, '[jobs] failure event not dispatched')
      );
      msg.ack();
    } else {
      logger.warn({ err: error, job: def.id, attempt: msg.attempts }, '[jobs] failed, retrying');
      msg.retry({ delaySeconds: jobRetryDelaySeconds(msg.attempts) });
    }
  } finally {
    await release(held);
  }
}

async function release(held: Array<{ gate: Gate; token: string }>) {
  for (const h of held) {
    await gateClient
      .release(h.gate, h.token)
      .catch(err => logger.warn({ err }, '[jobs] gate release failed (lease will expire)'));
  }
}

/** A busy gate is not a failure: re-send later, up to ~2 h, without spending an attempt. */
async function parkForGate(msg: QueueMessageLike, body: JobQueueMessage, gate: Gate) {
  const waits = (body.waits ?? 0) + 1;
  if (waits > GATE_MAX_WAITS) {
    logger.error(
      { job: body.fn, gate: gate.gateId },
      '[jobs] gate never freed, dropping to failure path'
    );
    const def = getJob(body.fn)!;
    const error = new Error(
      `concurrency gate ${gate.gateId} not free after ${GATE_MAX_WAITS} waits`
    );
    await runOnFailure(def, body.event, msg.id, error);
    await dispatchEventsToAll(failedEvent(def, body.event, msg.id, error)).catch(() => undefined);
    msg.ack();
    return;
  }
  const q = cfBindings()?.JOBS_QUEUE;
  if (!q) {
    msg.retry({ delaySeconds: 30 });
    return;
  }
  await q.send(
    { ...body, waits },
    { contentType: 'json', delaySeconds: Math.min(120, 10 * waits) }
  );
  msg.ack();
}

/** Retries exhausted at the platform level (a crash loop): same failure path, once. */
async function handleDeadLetter(msg: QueueMessageLike): Promise<void> {
  if (isJobQueueMessage(msg.body)) {
    const def = getJob(msg.body.fn);
    if (def) {
      const error = new Error('queue delivery attempts exhausted');
      await runOnFailure(def, msg.body.event, msg.id, error);
      await dispatchEventsToAll(failedEvent(def, msg.body.event, msg.id, error)).catch(
        () => undefined
      );
    }
  }
  logger.error({ id: msg.id }, '[jobs] dead-lettered job processed');
  msg.ack();
}
