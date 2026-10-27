import { sendAlert } from '../../services/alerts.service';
import logger from '../logger';
import { STORE_EVENTS_DLQ, STORE_EVENTS_QUEUE } from './config';
import { handleStoreEvent } from './store-events-consumer';
import { retryDelaySeconds, type MessageBatchLike } from '../../cf/queues';

/**
 * `ebda-store-events`: a message is applied once; a transient failure retries with backoff (the
 * queue's `max_retries`, then the DLQ); an unreadable or unknown-order message is acked (a retry
 * cannot fix it) after being logged. The DLQ side only logs loudly: the Store never guesses at a
 * COD answer it could not apply.
 */
export async function handleStoreEventsBatch(batch: MessageBatchLike): Promise<void> {
  for (const msg of batch.messages) {
    if (batch.queue === STORE_EVENTS_DLQ) {
      logger.error({ id: msg.id }, '[wa-store-events] dead-lettered message (not applied)');
      // A COD answer that could not be applied is a customer waiting on a decision: page, no PII.
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'wa.store_events.dead_letter',
        title: 'A WhatsApp COD answer could not be applied to its order',
        body:
          `Message ${msg.id} on ${STORE_EVENTS_QUEUE} exhausted its retries and was dead-lettered. ` +
          'The order was NOT changed; check the order and answer the buyer by hand.',
      }).catch(() => undefined);
      msg.ack();
      continue;
    }
    try {
      await handleStoreEvent(msg.body);
      msg.ack();
    } catch (err) {
      logger.warn({ err, id: msg.id, attempt: msg.attempts }, '[wa-store-events] failed, retrying');
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
    }
  }
}
