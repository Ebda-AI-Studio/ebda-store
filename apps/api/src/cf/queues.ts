/**
 * Cloudflare Queues consumers (R-EBDA-001, design section 5): the email and SMS queues.
 *
 * The producer side is `emailQueue.enqueue` / `smsQueue.enqueue` (EMAIL_QUEUE / SMS_QUEUE).
 * Here, per message:
 *   - main queue: ONE delivery attempt. Success acks; failure retries with a delay that grows
 *     with the attempt number. `max_retries` (wrangler.jsonc) then moves it to the DLQ.
 *   - DLQ: the message is parked on the dead-letter list the super-admin replay pages read
 *     (`email:failed` / `sms:failed`) and an operator is paged. Browsing a Cloudflare DLQ is not
 *     possible, so the list is the read side; "Retry all" produces back to the main queue.
 *
 * At-least-once: an email can be delivered twice if the Worker dies between send and ack.
 * That is the upgrade from today's at-most-once (RPOP then send); the SMS path is idempotent
 * through its NotificationLog key.
 */
import { runInStoreScope } from '@ebda/database';
import { emailQueue, isQueuedEmail } from '../services/email-queue.service';
import { EmailSendError, isBadRecipientError } from '../services/mail-transport';
import { smsQueue, isQueuedSms } from '../services/sms-queue.service';
import logger from '../lib/logger';
import { handleJobsBatch } from '../lib/jobs/run-queue';
import { JOBS_DLQ_NAME, JOBS_QUEUE_NAME } from '../lib/jobs/start';

export const EMAIL_QUEUE_NAME = 'ebda-email';
export const SMS_QUEUE_NAME = 'ebda-sms';
export const EMAIL_DLQ_NAME = 'ebda-email-dlq';
export const SMS_DLQ_NAME = 'ebda-sms-dlq';

/** Retry delay for attempt n (1-based): 5 s, 10 s, 20 s... capped at 5 min. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

export interface QueueMessageLike {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}

export interface MessageBatchLike {
  queue: string;
  messages: ReadonlyArray<QueueMessageLike>;
}

export async function handleQueueBatch(batch: MessageBatchLike): Promise<void> {
  // Background jobs (G5) own their ack/retry/failure handling.
  if (batch.queue === JOBS_QUEUE_NAME || batch.queue === JOBS_DLQ_NAME) {
    await handleJobsBatch(batch);
    return;
  }
  for (const msg of batch.messages) {
    try {
      switch (batch.queue) {
        case EMAIL_QUEUE_NAME: {
          if (!isQueuedEmail(msg.body)) throw new PoisonMessage('unreadable email message');
          const email = { ...msg.body, attempts: msg.attempts - 1 };
          // The sender reads the store's email settings: run it in that store's scope.
          try {
            if (email.storeId)
              await runInStoreScope(email.storeId, () => emailQueue.deliver(email));
            else await emailQueue.deliver(email);
          } catch (err) {
            if (!(err instanceof EmailSendError && err.permanent)) throw err;
            // A retry cannot fix this (bad payload, suppressed recipient). A suppressed recipient
            // (hard bounce / complaint, Cloudflare's own list) is routine: no page. Anything else
            // permanent is a bug: park it on the replay list and page once, now, not after 3 retries.
            if (err.code === 'E_RECIPIENT_SUPPRESSED') {
              logger.warn(
                { id: msg.id, code: err.code },
                '[queues] recipient suppressed, email dropped'
              );
            } else if (isBadRecipientError(err)) {
              await emailQueue.recordBadRecipient(email, 'bad recipient: E_VALIDATION_ERROR');
            } else {
              await emailQueue.parkDeadLetter(email, `permanent send error ${err.code}`);
            }
          }
          break;
        }
        case SMS_QUEUE_NAME: {
          if (!isQueuedSms(msg.body)) throw new PoisonMessage('unreadable sms message');
          const sms = { ...msg.body, attempts: msg.attempts - 1 };
          await runInStoreScope(sms.storeId, () => smsQueue.deliver(sms));
          break;
        }
        case EMAIL_DLQ_NAME:
          if (isQueuedEmail(msg.body)) await emailQueue.parkDeadLetter(msg.body);
          else
            logger.error(
              { id: msg.id, queue: batch.queue },
              '[queues] unreadable DLQ message dropped'
            );
          break;
        case SMS_DLQ_NAME:
          if (isQueuedSms(msg.body)) {
            await runInStoreScope(msg.body.storeId, () =>
              smsQueue.parkDeadLetter(msg.body as never)
            );
          } else {
            logger.error(
              { id: msg.id, queue: batch.queue },
              '[queues] unreadable DLQ message dropped'
            );
          }
          break;
        default:
          logger.error({ queue: batch.queue }, '[queues] message for an unknown queue acked');
      }
      msg.ack();
    } catch (err) {
      if (err instanceof PoisonMessage) {
        // A retry cannot fix a malformed body: ack it (a DLQ copy would be just as unreadable).
        logger.error(
          { id: msg.id, queue: batch.queue, why: err.message },
          '[queues] poison message dropped'
        );
        msg.ack();
        continue;
      }
      logger.warn(
        { err, id: msg.id, queue: batch.queue, attempt: msg.attempts },
        '[queues] delivery failed, retrying'
      );
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
    }
  }
}

class PoisonMessage extends Error {}
