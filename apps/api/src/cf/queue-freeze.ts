/**
 * Queue consumers under the write freeze (Ruling CF-JOBS-2, docs/runbooks/cutover-cf.md 5.1).
 *
 * While `WRITES_FROZEN=1` no consumer may run its handler (email status rows, jobs, WhatsApp/CI events all write).
 * Each message is PARKED, never dropped:
 *   - a queue this Worker also produces to (email, sms, jobs, CI) is re-sent to the same queue with a 5 minute delay and the
 *     original is acked. A re-send does not spend a delivery attempt, so a long window cannot push it into the DLQ;
 *   - a queue only another Worker produces to (WhatsApp store events) and every DLQ is retried with an exponential delay
 *     (5, 10, 20, 40, 80 min ... capped at 12 h). That spends attempts: 5 on store-events (about 2.5 h of freeze before the
 *     DLQ), 2 on the DLQs (the DLQ consumers only park a row for the replay page, which can wait).
 * If a re-send throws, the message is retried instead; it is never acked unless it is safely queued again.
 */
import logger from '../lib/logger';
import { FREEZE_PARK_SECONDS, writesFrozen } from '../lib/jobs/freeze';
import type { CfBindings } from './bindings';

export interface ParkableMessage {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}
export interface ParkableBatch {
  queue: string;
  messages: ReadonlyArray<ParkableMessage>;
}

/** Queues this Worker produces to: consumer queue name -> producer binding. */
const PRODUCER_BINDING: Record<
  string,
  'EMAIL_QUEUE' | 'SMS_QUEUE' | 'JOBS_QUEUE' | 'CI_EVENTS_QUEUE'
> = {
  'ebda-email': 'EMAIL_QUEUE',
  'ebda-sms': 'SMS_QUEUE',
  'ebda-jobs': 'JOBS_QUEUE',
  'ebda-ci-events': 'CI_EVENTS_QUEUE',
};

export function parkRetryDelaySeconds(attempts: number): number {
  return Math.min(43_200, FREEZE_PARK_SECONDS * 2 ** Math.max(0, attempts - 1));
}

/** True when the batch was parked (the caller must not run its handlers). */
export async function parkIfFrozen(batch: ParkableBatch, env: CfBindings): Promise<boolean> {
  if (!writesFrozen(env)) return false;
  const binding = PRODUCER_BINDING[batch.queue];
  const producer = binding ? env[binding] : undefined;
  for (const msg of batch.messages) {
    if (producer && typeof (producer as { send?: unknown }).send === 'function') {
      try {
        await (producer as { send: (m: unknown, o?: object) => Promise<void> }).send(msg.body, {
          contentType: 'json',
          delaySeconds: FREEZE_PARK_SECONDS,
        });
        msg.ack();
        continue;
      } catch (err) {
        logger.error({ err, queue: batch.queue, id: msg.id }, '[freeze] re-send failed, retrying');
      }
    }
    msg.retry({ delaySeconds: parkRetryDelaySeconds(msg.attempts) });
  }
  logger.warn({ queue: batch.queue, messages: batch.messages.length }, '[freeze] batch parked');
  return true;
}
