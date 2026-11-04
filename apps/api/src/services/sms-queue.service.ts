/**
 * SMS Queue Service
 * Async SMS processing with Redis queue
 */

import crypto from 'crypto';
import { prisma, runInStoreScope } from '@ebda/database';
import { redis } from './redis.service';
import { smsService, SmsConfig } from './sms.service';
import { withCircuitBreaker, circuitBreaker } from './circuit-breaker.service';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';
import { CORRUPT_CAP, replayDeadLetters, setAsideUnreadable } from '../lib/dead-letter';
import { isWorkers } from '../lib/runtime';
import { cfBindings } from '../cf/bindings';
import { analyticsRead, analyticsWrite } from '../lib/analytics-backend';

type SmsLogUpsert = Parameters<typeof prisma.notificationLog.upsert>[0];
/** The SMS delivery log row, keyed by its idempotency key; in the store's DO once its analytics moved (Ruling NZ-AN-1). */
const smsLogUpsert = (storeId: string, args: SmsLogUpsert) =>
  analyticsWrite(
    storeId,
    w =>
      w.notificationLog.upsert({
        where: { idempotencyKey: args.where.idempotencyKey as string },
        create: args.create,
        update: args.update,
      }),
    () => prisma.notificationLog.upsert(args)
  );

export interface QueuedSms {
  id: string;
  storeId: string;
  event: string;
  recipientPhone: string;
  messageText: string;
  config: SmsConfig;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  lastAttempt?: string;
  error?: string;
}

const QUEUE_KEY = 'sms:queue';
const FAILED_KEY = 'sms:failed';
const FAILED_CORRUPT_KEY = 'sms:failed:corrupt';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

/**
 * The ONE definition of a readable queued SMS (issues 2371, 2374): every field
 * `sendSms` dereferences (`idempotencyKey` for the NotificationLog lookup,
 * `recipientPhone` for the hash + send, `messageText`, `config`, `storeId` for
 * the breaker key) plus the list route's `id`. Used by the live-queue
 * processor, the dead-letter reader AND the replayer — the replayer used to
 * accept any object, so `{}` was re-queued and then destroyed by a Prisma
 * validation error on `idempotencyKey: undefined`.
 */
export function isQueuedSms(v: unknown): v is QueuedSms {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Partial<QueuedSms>;
  return (
    typeof m.id === 'string' &&
    typeof m.storeId === 'string' &&
    typeof m.idempotencyKey === 'string' &&
    typeof m.recipientPhone === 'string' &&
    typeof m.messageText === 'string' &&
    !!m.config &&
    typeof m.config === 'object'
  );
}

class SmsQueueService {
  private processing = false;
  private intervalId?: NodeJS.Timeout;

  /**
   * Add SMS to queue
   */
  async enqueue(message: {
    storeId: string;
    event: string;
    recipientPhone: string;
    messageText: string;
    config: SmsConfig;
    idempotencyKey: string;
  }): Promise<string> {
    const id = `sms_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;

    const queuedSms: QueuedSms = {
      id,
      storeId: message.storeId,
      event: message.event,
      recipientPhone: message.recipientPhone,
      messageText: message.messageText,
      config: message.config,
      idempotencyKey: message.idempotencyKey,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      createdAt: new Date().toISOString(),
    };

    const queue = isWorkers ? cfBindings()?.SMS_QUEUE : undefined;
    if (queue) {
      // Cloudflare Queues: durable, retried by the platform, dead-lettered into
      // `ebda-sms-dlq` (`deliver` / `parkDeadLetter`, wired in cf/queues.ts).
      await queue.send(queuedSms, { contentType: 'json' });
    } else if (!isWorkers && redis.isAvailable()) {
      await redis.getClient()?.lpush(QUEUE_KEY, JSON.stringify(queuedSms));
    } else {
      // Fallback: send immediately if Redis is not available
      logger.warn('[SMS QUEUE] Redis unavailable, sending immediately');
      await this.sendSms(queuedSms);
    }

    return id;
  }

  /**
   * Cloudflare Queues consumer: ONE attempt. A provider failure THROWS so the platform retries
   * the message and, once `max_retries` is spent, dead-letters it (`parkDeadLetter`). A send
   * that the provider accepted never throws (sendSms logs and returns): retrying it would text
   * the customer twice.
   */
  async deliver(sms: QueuedSms): Promise<void> {
    await this.sendSms(sms, { rethrow: true });
  }

  /** Dead-letter queue consumer: the permanent-failure half of `sendSms`, for a Queues-exhausted message. */
  async parkDeadLetter(sms: QueuedSms, why = 'max attempts reached'): Promise<void> {
    logger.error({ smsId: sms.id, why }, '[SMS QUEUE] SMS failed permanently');
    const recipientPhoneHash = crypto.createHash('sha256').update(sms.recipientPhone).digest('hex');
    await smsLogUpsert(sms.storeId, {
      where: { idempotencyKey: sms.idempotencyKey, storeId: sms.storeId },
      create: {
        storeId: sms.storeId,
        channel: 'sms',
        event: sms.event,
        recipientPhoneHash,
        status: 'failed',
        idempotencyKey: sms.idempotencyKey,
        error: sms.error ?? why,
        metadata: { attempts: sms.attempts },
      },
      update: { status: 'failed', error: sms.error ?? why, metadata: { attempts: sms.attempts } },
    }).catch(err => logger.error({ err }, '[SMS QUEUE] Failed to write failure log'));
    if (redis.isAvailable()) {
      await redis.getClient()?.lpush(FAILED_KEY, JSON.stringify(sms));
    }
  }

  /**
   * Start processing queue
   */
  startProcessing(intervalMs: number = 2000): void {
    if (this.intervalId) return;

    logger.info('[SMS QUEUE] Starting queue processor');
    this.intervalId = setInterval(() => this.processQueue(), intervalMs);
  }

  /**
   * Stop processing queue
   */
  stopProcessing(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info('[SMS QUEUE] Stopped queue processor');
    }
  }

  /**
   * Process SMS messages in queue
   */
  async processQueue(): Promise<void> {
    if (this.processing || !redis.isAvailable()) return;

    this.processing = true;

    try {
      const client = redis.getClient();
      if (!client) return;

      // Get next SMS from queue
      const smsJson = await client.rpop(QUEUE_KEY);
      if (!smsJson) {
        this.processing = false;
        return;
      }

      let sms: unknown;
      try {
        sms = JSON.parse(smsJson);
      } catch {
        sms = undefined;
      }
      if (!isQueuedSms(sms)) {
        // Unreadable: sending would throw after the rpop and destroy it.
        // Set it aside with the replay's unreadable entries (issue 2371).
        // Issue 2378: the rpop already removed it, so a rejected park must
        // not propagate — it is put back on the live queue, and only if
        // that write fails too is it lost (P1, size only: no payload).
        const outcome = await setAsideUnreadable(
          client,
          { corrupt: FAILED_CORRUPT_KEY, queue: QUEUE_KEY },
          smsJson,
          logger
        );
        if (outcome === 'lost') {
          await sendAlert({
            level: 'p1',
            source: 'sms.queue.unreadable_lost',
            title: 'Unreadable queued SMS lost',
            body:
              `An unreadable entry (${smsJson.length} bytes) was removed from \`${QUEUE_KEY}\` and ` +
              'Redis rejected both the set-aside and the put-back, so it is gone. It could not be ' +
              'parsed, so there is no id or recipient to resend from.',
            context: { bytes: smsJson.length, list: QUEUE_KEY },
          }).catch(() => undefined);
        }
        return;
      }
      await runInStoreScope(sms.storeId, () => this.sendSms(sms));
    } catch (error) {
      logger.error({ err: error }, '[SMS QUEUE] Error processing queue');
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send SMS with idempotency check, retry logic, and NotificationLog
   */
  private async sendSms(sms: QueuedSms, opts: { rethrow?: boolean } = {}): Promise<void> {
    sms.attempts++;
    sms.lastAttempt = new Date().toISOString();

    const recipientPhoneHash = crypto.createHash('sha256').update(sms.recipientPhone).digest('hex');
    // Set once the provider has accepted the message (issue 2382). Anything
    // that throws after that point must NOT retry or dead-letter: the
    // idempotency row below is what the retry would look for, and it is the
    // write that just failed — a retry would text the customer (and spend the
    // merchant's SMS credit) a second time.
    // undefined = the provider has not accepted the SMS; string | null = it
    // has (null: accepted without a messageId, issue 2389).
    let sentMessageId: string | null | undefined;

    try {
      // Idempotency check — INSIDE the try (issue 2371): a throw here (a DB
      // blip) used to escape to processQueue's catch after the rpop, and the
      // SMS was gone. It now retries and, on the last attempt, dead-letters.
      const existing = await analyticsRead(
        sms.storeId,
        r => r.notificationLog.findFirst({ where: { idempotencyKey: sms.idempotencyKey } }),
        () =>
          prisma.notificationLog.findUnique({
            where: { idempotencyKey: sms.idempotencyKey, storeId: sms.storeId },
          })
      );

      if (existing && existing.status === 'sent') {
        logger.info(
          { idempotencyKey: sms.idempotencyKey, smsId: sms.id },
          '[SMS QUEUE] Duplicate SMS skipped (idempotent)'
        );
        return;
      }

      // Per-store circuit breaker prevents one store's failing API key
      // from tripping the breaker for all stores
      const breakerKey = `sms:${sms.storeId}`;
      if (!circuitBreaker.getState(breakerKey)) {
        circuitBreaker.register(breakerKey, { failureThreshold: 5, timeout: 30000 });
      }

      const result = await withCircuitBreaker(breakerKey, async () => {
        return smsService.sendSms(sms.config, sms.recipientPhone, sms.messageText);
      });
      sentMessageId = result.messageId;

      // Log success
      await smsLogUpsert(sms.storeId, {
        where: { idempotencyKey: sms.idempotencyKey, storeId: sms.storeId },
        create: {
          storeId: sms.storeId,
          channel: 'sms',
          event: sms.event,
          recipientPhoneHash,
          status: 'sent',
          providerMessageId: result.messageId,
          idempotencyKey: sms.idempotencyKey,
          metadata: { attempts: sms.attempts },
        },
        update: {
          status: 'sent',
          providerMessageId: result.messageId,
          metadata: { attempts: sms.attempts },
        },
      });

      logger.info(
        { smsId: sms.id, messageId: result.messageId, event: sms.event },
        '[SMS QUEUE] SMS sent'
      );
    } catch (error) {
      if (sentMessageId !== undefined) {
        // Delivered; only the NotificationLog write failed. Log-only: the
        // row is missing from the admin log, which is far cheaper than a
        // duplicate text. No phone/text in the log (PII).
        logger.error(
          { err: error, smsId: sms.id, messageId: sentMessageId, event: sms.event },
          '[SMS QUEUE] SMS sent but NotificationLog write failed — not retried (would double-send)'
        );
        return;
      }
      sms.error = error instanceof Error ? error.message : 'Unknown error';

      // A Queues consumer attempt: the platform owns retry + dead-lettering.
      if (opts.rethrow) throw error;

      if (sms.attempts < sms.maxAttempts) {
        // Re-queue for retry with exponential backoff
        logger.warn(
          { smsId: sms.id, attempt: sms.attempts, maxAttempts: sms.maxAttempts },
          '[SMS QUEUE] SMS failed, retrying'
        );

        const delay = RETRY_DELAY_MS * Math.pow(2, sms.attempts - 1);
        setTimeout(() => {
          if (redis.isAvailable()) {
            redis
              .getClient()
              ?.lpush(QUEUE_KEY, JSON.stringify(sms))
              .catch(() => {});
          }
        }, delay);
      } else {
        // Move to failed queue and log failure
        logger.error(
          { smsId: sms.id, attempts: sms.attempts },
          '[SMS QUEUE] SMS failed permanently'
        );

        await smsLogUpsert(sms.storeId, {
          where: { idempotencyKey: sms.idempotencyKey, storeId: sms.storeId },
          create: {
            storeId: sms.storeId,
            channel: 'sms',
            event: sms.event,
            recipientPhoneHash,
            status: 'failed',
            idempotencyKey: sms.idempotencyKey,
            error: sms.error,
            metadata: { attempts: sms.attempts },
          },
          update: {
            status: 'failed',
            error: sms.error,
            metadata: { attempts: sms.attempts },
          },
        }).catch(err => {
          logger.error({ err }, '[SMS QUEUE] Failed to write failure log');
        });

        if (redis.isAvailable()) {
          await redis.getClient()?.lpush(FAILED_KEY, JSON.stringify(sms));
        }
      }
    }
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    pending: number;
    failed: number;
    /** Unreadable set-aside entries (issue 2353). */
    corrupt: number;
    processing: boolean;
  }> {
    if (!redis.isAvailable()) {
      return { pending: 0, failed: 0, corrupt: 0, processing: this.processing };
    }

    const client = redis.getClient();
    const [pending, failed, corrupt] = await Promise.all([
      client?.llen(QUEUE_KEY) || 0,
      client?.llen(FAILED_KEY) || 0,
      client?.llen(FAILED_CORRUPT_KEY) || 0,
    ]);

    return {
      pending: pending || 0,
      failed: failed || 0,
      corrupt: corrupt || 0,
      processing: this.processing,
    };
  }

  /**
   * The unreadable set-aside entries, for the super-admin SMS queue page
   * (issue 2363). Size only — they cannot be parsed, so nothing can be masked.
   */
  async getCorruptEntries(limit: number = 50): Promise<Array<{ position: number; bytes: number }>> {
    if (!redis.isAvailable()) return [];
    const raw = (await redis.getClient()?.lrange(FAILED_CORRUPT_KEY, 0, limit - 1)) || [];
    return raw.map((e, position) => ({ position, bytes: Buffer.byteLength(e, 'utf8') }));
  }

  /** Drop every set-aside entry. Returns how many were discarded. */
  async discardCorrupt(): Promise<number> {
    if (!redis.isAvailable()) return 0;
    const client = redis.getClient();
    if (!client) return 0;
    const count = await client.llen(FAILED_CORRUPT_KEY);
    await client.del(FAILED_CORRUPT_KEY);
    return count;
  }

  /**
   * Get failed SMS messages for retry or inspection
   */
  async getFailedMessages(limit: number = 10): Promise<QueuedSms[]> {
    if (!redis.isAvailable()) return [];

    const client = redis.getClient();
    const messages = await client?.lrange(FAILED_KEY, 0, limit - 1);

    // Same predicate as the replayer (issue 2374): a parseable-but-shapeless
    // entry is skipped (still counted in `stats.failed`), not a phantom row.
    return (messages || []).reduce<QueuedSms[]>((acc, m) => {
      try {
        const parsed: unknown = JSON.parse(m);
        if (isQueuedSms(parsed)) acc.push(parsed);
      } catch {
        // unparseable — same as above
      }
      return acc;
    }, []);
  }

  /**
   * Re-queue every dead-lettered SMS — the super-admin "Retry all" on
   * `/sms-queue` (issue 2363). Same loop as the email twin
   * (`replayDeadLetters`, lib/dead-letter.ts): each entry parsed on its own,
   * an unreadable one moved to `sms:failed:corrupt`, a Redis write that
   * rejects after the `rpop` puts the entry back instead of destroying it
   * (issue 2361), and the loop bounded by the list length at the start.
   */
  async retryFailed(): Promise<{ retried: number; skipped: number; kept: number }> {
    if (!redis.isAvailable()) return { retried: 0, skipped: 0, kept: 0 };

    const client = redis.getClient();
    if (!client) return { retried: 0, skipped: 0, kept: 0 };

    // Workers: "re-queue" means producing to Cloudflare Queues, not LPUSH-ing a list nobody consumes.
    const queue = isWorkers ? cfBindings()?.SMS_QUEUE : undefined;
    const replayClient = queue
      ? {
          lpush: (key: string, value: string) =>
            key === QUEUE_KEY
              ? queue.send(JSON.parse(value), { contentType: 'json' })
              : client.lpush(key, value),
          rpop: (key: string) => client.rpop(key),
          llen: (key: string) => client.llen(key),
          ltrim: (key: string, a: number, b: number) => client.ltrim(key, a, b),
          expire: (key: string, s: number) => client.expire(key, s),
        }
      : client;
    const { retried, skipped, kept, lost } = await replayDeadLetters<QueuedSms>(
      replayClient,
      { failed: FAILED_KEY, corrupt: FAILED_CORRUPT_KEY, queue: QUEUE_KEY },
      isQueuedSms,
      logger
    );

    logger.info({ retried, skipped, kept, lost }, '[SMS QUEUE] Retrying failed SMS messages');
    if (lost > 0) {
      await sendAlert({
        level: 'p1',
        source: 'sms.queue.replay_lost',
        title: 'Dead-lettered SMS lost during retry',
        body:
          `${lost} dead-lettered SMS were removed from \`${FAILED_KEY}\` during "Retry all" and ` +
          'Redis rejected both the re-queue and the put-back, so they are gone. Their ids are in ' +
          'the error log ("[dead-letter] replay write AND put-back failed").',
        context: { lost, list: FAILED_KEY },
      }).catch(() => undefined);
    }
    if (skipped > 0) {
      // Same as the email twin (issue 2353): set aside is never silent.
      await sendAlert({
        level: 'p1',
        source: 'sms.queue.corrupt_entries',
        title: 'Unreadable dead-lettered SMS set aside',
        body:
          `${skipped} dead-lettered SMS entr(ies) could not be parsed during a retry and were ` +
          `moved to Redis list \`${FAILED_CORRUPT_KEY}\` (not replayed; newest ${CORRUPT_CAP}, ` +
          'kept 30 days). Count + discard: super-admin SMS queue page. Raw payload: ' +
          '`railway connect Redis` → `LRANGE sms:failed:corrupt 0 -1`.',
        context: { skipped, list: FAILED_CORRUPT_KEY },
      }).catch(() => undefined);
    }
    return { retried, skipped, kept };
  }
}

// Singleton instance
export const smsQueue = new SmsQueueService();

/**
 * Convenience function to queue an SMS
 */
async function queueSms(message: {
  storeId: string;
  event: string;
  recipientPhone: string;
  messageText: string;
  config: SmsConfig;
  idempotencyKey: string;
}): Promise<string> {
  return smsQueue.enqueue(message);
}
