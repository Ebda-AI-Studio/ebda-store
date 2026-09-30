/**
 * Email Queue Service
 * Async email processing with Redis queue
 */

import crypto from 'crypto';
import { redis } from './redis.service';
import { EmailService, EmailOptions } from './email.service';
import { withCircuitBreaker } from './circuit-breaker.service';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';

export interface QueuedEmail {
  id: string;
  storeId: string | null;
  options: EmailOptions;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  lastAttempt?: string;
  error?: string;
}

const QUEUE_KEY = 'email:queue';
const FAILED_KEY = 'email:failed';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

class EmailQueueService {
  private processing = false;
  private intervalId?: NodeJS.Timeout;

  /**
   * Add email to queue
   */
  async enqueue(storeId: string | null, options: EmailOptions): Promise<string> {
    const id = `email_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;

    const queuedEmail: QueuedEmail = {
      id,
      storeId,
      options,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      createdAt: new Date().toISOString(),
    };

    if (redis.isAvailable()) {
      await redis.getClient()?.lpush(QUEUE_KEY, JSON.stringify(queuedEmail));
    } else {
      // Fallback: send immediately if Redis is not available. There is no
      // queue to retry from, so a failed send REJECTS here (issue 2142): the
      // caller's own failure handling (e.g. the refund fanout's #1935 gate,
      // an Inngest step retry) is the only retry left, and resolving would
      // tell it the email went out.
      logger.warn('[EMAIL QUEUE] Redis unavailable, sending immediately');
      await this.sendEmail(queuedEmail, { inline: true });
    }

    return id;
  }

  /**
   * Start processing queue
   */
  startProcessing(intervalMs: number = 1000): void {
    if (this.intervalId) return;

    logger.info('[EMAIL QUEUE] Starting queue processor');
    this.intervalId = setInterval(() => this.processQueue(), intervalMs);
  }

  /**
   * Stop processing queue
   */
  stopProcessing(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info('[EMAIL QUEUE] Stopped queue processor');
    }
  }

  /**
   * Process emails in queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing || !redis.isAvailable()) return;

    this.processing = true;

    try {
      const client = redis.getClient();
      if (!client) return;

      // Get next email from queue
      const emailJson = await client.rpop(QUEUE_KEY);
      if (!emailJson) {
        this.processing = false;
        return;
      }

      const email: QueuedEmail = JSON.parse(emailJson);
      await this.sendEmail(email);
    } catch (error) {
      logger.error({ err: error }, '[EMAIL QUEUE] Error processing queue');
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send email with retry logic — dispatches to the right sender based on storeId.
   */
  private async sendEmail(email: QueuedEmail, opts: { inline?: boolean } = {}): Promise<void> {
    email.attempts++;
    email.lastAttempt = new Date().toISOString();

    try {
      await withCircuitBreaker('email', async () => {
        if (email.storeId) {
          await EmailService.sendRaw(email.storeId, email.options);
        } else {
          await EmailService.sendPlatformRaw(email.options);
        }
      });

      logger.info({ emailId: email.id, to: email.options.to }, '[EMAIL QUEUE] Sent email');
    } catch (error) {
      email.error = error instanceof Error ? error.message : 'Unknown error';

      if (opts.inline) {
        logger.error(
          { emailId: email.id, storeId: email.storeId, err: error },
          '[EMAIL QUEUE] Inline send failed (Redis unavailable) — rethrowing to the caller'
        );
        throw error;
      }

      if (email.attempts < email.maxAttempts && redis.isAvailable()) {
        // Re-queue for retry with delay
        logger.warn(
          { emailId: email.id, attempt: email.attempts, maxAttempts: email.maxAttempts },
          '[EMAIL QUEUE] Email failed, retrying'
        );

        setTimeout(() => {
          const client = redis.isAvailable() ? redis.getClient() : null;
          if (!client) {
            // Redis went away between the failure and the retry: the email
            // would vanish here, so it is a permanent failure, loudly.
            void this.reportPermanentFailure(email, 'redis unavailable at retry');
            return;
          }
          client.lpush(QUEUE_KEY, JSON.stringify(email)).catch(err => {
            void this.reportPermanentFailure(email, `re-queue failed: ${String(err)}`);
          });
        }, RETRY_DELAY_MS * email.attempts);
      } else {
        // Move to failed queue
        if (redis.isAvailable()) {
          await redis
            .getClient()
            ?.lpush(FAILED_KEY, JSON.stringify(email))
            .catch(() => undefined);
        }
        await this.reportPermanentFailure(email, 'max attempts reached');
      }
    }
  }

  /**
   * A queued email that will never be sent (issue 2142). `enqueue` resolved
   * long ago — the caller (an order / refund / return email step) was told
   * it went out — so this is the ONLY place the failure can surface. It used
   * to be a log line; it is now a P1 alert, and the email sits in
   * `email:failed`, listed and replayable at the super-admin Email queue page
   * (`GET /admin/email-queue/failed`). No recipient address in the alert.
   */
  private async reportPermanentFailure(email: QueuedEmail, why: string): Promise<void> {
    logger.error(
      { emailId: email.id, storeId: email.storeId, attempts: email.attempts, why },
      '[EMAIL QUEUE] Email failed permanently'
    );
    await sendAlert({
      level: 'p1',
      source: 'email.queue.permanent_failure',
      title: 'Queued email failed permanently',
      body:
        `Email ${email.id} was not delivered after ${email.attempts} attempt(s) (${why}). ` +
        'Replay it from the super-admin Email queue page once the provider recovers.',
      context: {
        emailId: email.id,
        storeId: email.storeId,
        subject: email.options.subject,
        error: email.error,
      },
    }).catch(() => undefined);
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
   * Get failed emails for retry or inspection
   */
  async getFailedEmails(limit: number = 10): Promise<QueuedEmail[]> {
    if (!redis.isAvailable()) return [];

    const client = redis.getClient();
    const emails = await client?.lrange(FAILED_KEY, 0, limit - 1);

    return (emails || []).reduce<QueuedEmail[]>((acc, e) => {
      try {
        acc.push(JSON.parse(e));
      } catch {
        // Skip corrupted entries
      }
      return acc;
    }, []);
  }

  /**
   * Retry failed emails
   */
  async retryFailed(): Promise<number> {
    if (!redis.isAvailable()) return 0;

    const client = redis.getClient();
    let retried = 0;

    while (true) {
      const emailJson = await client?.rpop(FAILED_KEY);
      if (!emailJson) break;

      const email: QueuedEmail = JSON.parse(emailJson);
      email.attempts = 0;
      email.error = undefined;

      await client?.lpush(QUEUE_KEY, JSON.stringify(email));
      retried++;
    }

    logger.info({ retried }, '[EMAIL QUEUE] Retrying failed emails');
    return retried;
  }
}

// Singleton instance
export const emailQueue = new EmailQueueService();

/**
 * Convenience function to queue an email (no store context — platform sender).
 */
async function queueEmail(options: EmailOptions): Promise<string> {
  return emailQueue.enqueue(null, options);
}
