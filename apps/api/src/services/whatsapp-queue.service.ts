/**
 * WhatsApp Queue Service
 * Async WhatsApp processing with Redis queue
 */

import crypto from 'crypto';
import { prisma } from '@force/database';
import { redis } from './redis.service';
import { whatsappService, WhatsAppConfig } from './whatsapp.service';
import { withCircuitBreaker } from './circuit-breaker.service';
import logger from '../lib/logger';

export interface QueuedWhatsAppMessage {
  id: string;
  storeId: string;
  event: string;
  recipientPhone: string;
  templateName: string;
  variables: string[];
  config: WhatsAppConfig;
  idempotencyKey?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  lastAttempt?: string;
  error?: string;
}

const QUEUE_KEY = 'whatsapp:queue';
const FAILED_KEY = 'whatsapp:failed';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

class WhatsAppQueueService {
  private processing = false;
  private intervalId?: NodeJS.Timeout;

  /**
   * Add a WhatsApp message to the queue
   */
  async enqueue(message: {
    storeId: string;
    event: string;
    recipientPhone: string;
    templateName: string;
    variables: string[];
    config: WhatsAppConfig;
    idempotencyKey?: string;
  }): Promise<string> {
    const id = `whatsapp_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;

    const queued: QueuedWhatsAppMessage = {
      id,
      storeId: message.storeId,
      event: message.event,
      recipientPhone: message.recipientPhone,
      templateName: message.templateName,
      variables: message.variables,
      config: message.config,
      idempotencyKey: message.idempotencyKey,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      createdAt: new Date().toISOString(),
    };

    if (redis.isAvailable()) {
      await redis.getClient()?.lpush(QUEUE_KEY, JSON.stringify(queued));
    } else {
      // Fallback: send immediately if Redis is not available
      logger.warn('[WHATSAPP QUEUE] Redis unavailable, sending immediately');
      await this.sendMessage(queued);
    }

    return id;
  }

  /**
   * Start processing queue
   */
  startProcessing(intervalMs: number = 2000): void {
    if (this.intervalId) return;

    logger.info('[WHATSAPP QUEUE] Starting queue processor');
    this.intervalId = setInterval(() => this.processQueue(), intervalMs);
  }

  /**
   * Stop processing queue
   */
  stopProcessing(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info('[WHATSAPP QUEUE] Stopped queue processor');
    }
  }

  /**
   * Process messages in queue
   */
  async processQueue(): Promise<void> {
    if (this.processing || !redis.isAvailable()) return;

    this.processing = true;

    try {
      const client = redis.getClient();
      if (!client) return;

      // Get next message from queue
      const messageJson = await client.rpop(QUEUE_KEY);
      if (!messageJson) {
        this.processing = false;
        return;
      }

      const message: QueuedWhatsAppMessage = JSON.parse(messageJson);
      await this.sendMessage(message);
    } catch (error) {
      logger.error({ err: error }, '[WHATSAPP QUEUE] Error processing queue');
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send WhatsApp message with idempotency check, retry logic, and NotificationLog
   */
  private async sendMessage(message: QueuedWhatsAppMessage): Promise<void> {
    message.attempts++;
    message.lastAttempt = new Date().toISOString();

    // Idempotency check — skip if already processed
    if (message.idempotencyKey) {
      const existing = await prisma.notificationLog.findUnique({
        where: { idempotencyKey: message.idempotencyKey },
      });

      if (existing) {
        logger.info(
          { id: message.id, idempotencyKey: message.idempotencyKey },
          '[WHATSAPP QUEUE] Duplicate detected, skipping'
        );
        return;
      }
    }

    const recipientPhoneHash = crypto
      .createHash('sha256')
      .update(message.recipientPhone)
      .digest('hex');

    try {
      const result = await withCircuitBreaker('whatsapp', async () => {
        return whatsappService.sendTemplateMessage(
          message.config,
          message.recipientPhone,
          message.templateName,
          'en',
          message.variables
        );
      });

      // Record success in NotificationLog
      await prisma.notificationLog.create({
        data: {
          storeId: message.storeId,
          channel: 'whatsapp',
          event: message.event,
          recipientPhoneHash,
          status: 'sent',
          providerMessageId: result.messageId,
          idempotencyKey: message.idempotencyKey,
          metadata: {
            templateName: message.templateName,
            queueId: message.id,
          },
        },
      });

      logger.info(
        { messageId: result.messageId, queueId: message.id, to: message.recipientPhone },
        '[WHATSAPP QUEUE] Message sent'
      );
    } catch (error) {
      message.error = error instanceof Error ? error.message : 'Unknown error';

      if (message.attempts < message.maxAttempts) {
        // Re-queue for retry with exponential backoff
        logger.warn(
          {
            queueId: message.id,
            attempt: message.attempts,
            maxAttempts: message.maxAttempts,
          },
          '[WHATSAPP QUEUE] Message failed, retrying'
        );

        const delay = RETRY_DELAY_MS * Math.pow(2, message.attempts - 1);
        setTimeout(() => {
          if (redis.isAvailable()) {
            redis
              .getClient()
              ?.lpush(QUEUE_KEY, JSON.stringify(message))
              .catch(() => {});
          }
        }, delay);
      } else {
        // Move to failed queue
        logger.error(
          { queueId: message.id, attempts: message.attempts },
          '[WHATSAPP QUEUE] Message failed permanently'
        );

        // Record failure in NotificationLog
        try {
          await prisma.notificationLog.create({
            data: {
              storeId: message.storeId,
              channel: 'whatsapp',
              event: message.event,
              recipientPhoneHash,
              status: 'failed',
              idempotencyKey: message.idempotencyKey,
              error: message.error,
              metadata: {
                templateName: message.templateName,
                queueId: message.id,
                attempts: message.attempts,
              },
            },
          });
        } catch (logError) {
          logger.error({ err: logError }, '[WHATSAPP QUEUE] Failed to write NotificationLog');
        }

        if (redis.isAvailable()) {
          await redis.getClient()?.lpush(FAILED_KEY, JSON.stringify(message));
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
   * Get failed messages for retry or inspection
   */
  async getFailedMessages(limit: number = 10): Promise<QueuedWhatsAppMessage[]> {
    if (!redis.isAvailable()) return [];

    const client = redis.getClient();
    const messages = await client?.lrange(FAILED_KEY, 0, limit - 1);

    return (messages || []).reduce<QueuedWhatsAppMessage[]>((acc, m) => {
      try {
        acc.push(JSON.parse(m));
      } catch {
        // Skip corrupted entries
      }
      return acc;
    }, []);
  }

  /**
   * Retry failed messages
   */
  async retryFailed(): Promise<number> {
    if (!redis.isAvailable()) return 0;

    const client = redis.getClient();
    let retried = 0;

    while (true) {
      const messageJson = await client?.rpop(FAILED_KEY);
      if (!messageJson) break;

      const message: QueuedWhatsAppMessage = JSON.parse(messageJson);
      message.attempts = 0;
      message.error = undefined;

      await client?.lpush(QUEUE_KEY, JSON.stringify(message));
      retried++;
    }

    logger.info({ retried }, '[WHATSAPP QUEUE] Retrying failed messages');
    return retried;
  }
}

// Singleton instance
export const whatsappQueue = new WhatsAppQueueService();

/**
 * Convenience function to queue a WhatsApp message
 */
export async function queueWhatsAppMessage(message: {
  storeId: string;
  event: string;
  recipientPhone: string;
  templateName: string;
  variables: string[];
  config: WhatsAppConfig;
  idempotencyKey?: string;
}): Promise<string> {
  return whatsappQueue.enqueue(message);
}
