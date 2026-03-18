/**
 * SMS Queue Service
 * Async SMS processing with Redis queue
 */

import crypto from 'crypto';
import { prisma } from '@force/database';
import { redis } from './redis.service';
import { smsService, SmsConfig } from './sms.service';
import { withCircuitBreaker } from './circuit-breaker.service';
import logger from '../lib/logger';

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
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

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

    if (redis.isAvailable()) {
      await redis.getClient()?.lpush(QUEUE_KEY, JSON.stringify(queuedSms));
    } else {
      // Fallback: send immediately if Redis is not available
      logger.warn('[SMS QUEUE] Redis unavailable, sending immediately');
      await this.sendSms(queuedSms);
    }

    return id;
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

      const sms: QueuedSms = JSON.parse(smsJson);
      await this.sendSms(sms);
    } catch (error) {
      logger.error({ err: error }, '[SMS QUEUE] Error processing queue');
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send SMS with idempotency check, retry logic, and NotificationLog
   */
  private async sendSms(sms: QueuedSms): Promise<void> {
    // Idempotency check
    const existing = await prisma.notificationLog.findUnique({
      where: { idempotencyKey: sms.idempotencyKey },
    });

    if (existing && existing.status === 'sent') {
      logger.info(
        { idempotencyKey: sms.idempotencyKey, smsId: sms.id },
        '[SMS QUEUE] Duplicate SMS skipped (idempotent)'
      );
      return;
    }

    sms.attempts++;
    sms.lastAttempt = new Date().toISOString();

    const recipientPhoneHash = crypto.createHash('sha256').update(sms.recipientPhone).digest('hex');

    try {
      const result = await withCircuitBreaker('sms', async () => {
        return smsService.sendSms(sms.config, sms.recipientPhone, sms.messageText);
      });

      // Log success
      await prisma.notificationLog.upsert({
        where: { idempotencyKey: sms.idempotencyKey },
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
      sms.error = error instanceof Error ? error.message : 'Unknown error';

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

        await prisma.notificationLog
          .upsert({
            where: { idempotencyKey: sms.idempotencyKey },
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
          })
          .catch(err => {
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
    processing: boolean;
  }> {
    if (!redis.isAvailable()) {
      return { pending: 0, failed: 0, processing: this.processing };
    }

    const client = redis.getClient();
    const [pending, failed] = await Promise.all([
      client?.llen(QUEUE_KEY) || 0,
      client?.llen(FAILED_KEY) || 0,
    ]);

    return {
      pending: pending || 0,
      failed: failed || 0,
      processing: this.processing,
    };
  }

  /**
   * Get failed SMS messages for retry or inspection
   */
  async getFailedMessages(limit: number = 10): Promise<QueuedSms[]> {
    if (!redis.isAvailable()) return [];

    const client = redis.getClient();
    const messages = await client?.lrange(FAILED_KEY, 0, limit - 1);

    return (messages || []).reduce<QueuedSms[]>((acc, m) => {
      try {
        acc.push(JSON.parse(m));
      } catch {
        // Skip corrupted entries
      }
      return acc;
    }, []);
  }

  /**
   * Retry failed SMS messages
   */
  async retryFailed(): Promise<number> {
    if (!redis.isAvailable()) return 0;

    const client = redis.getClient();
    let retried = 0;

    while (true) {
      const smsJson = await client?.rpop(FAILED_KEY);
      if (!smsJson) break;

      const sms: QueuedSms = JSON.parse(smsJson);
      sms.attempts = 0;
      sms.error = undefined;

      await client?.lpush(QUEUE_KEY, JSON.stringify(sms));
      retried++;
    }

    logger.info({ retried }, '[SMS QUEUE] Retrying failed SMS messages');
    return retried;
  }
}

// Singleton instance
export const smsQueue = new SmsQueueService();

/**
 * Convenience function to queue an SMS
 */
export async function queueSms(message: {
  storeId: string;
  event: string;
  recipientPhone: string;
  messageText: string;
  config: SmsConfig;
  idempotencyKey: string;
}): Promise<string> {
  return smsQueue.enqueue(message);
}
