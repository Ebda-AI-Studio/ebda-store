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
/** Dead-lettered entries that could not be parsed on replay (issue 2292) — kept, never re-popped. */
const FAILED_CORRUPT_KEY = 'email:failed:corrupt';
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
            void this.reportPermanentFailure(email, 'redis unavailable at retry', 'lost');
            return;
          }
          client.lpush(QUEUE_KEY, JSON.stringify(email)).catch(async err => {
            // Redis is still reachable (only this push was rejected), so park
            // the email in the dead-letter list before paging: the P1 sends
            // the operator to the Email queue page, which lists ONLY
            // `email:failed` — without this push it was empty (issue 2292).
            const parked = await client
              .lpush(FAILED_KEY, JSON.stringify(email))
              .then(() => true)
              .catch(() => false);
            void this.reportPermanentFailure(
              email,
              `re-queue failed: ${String(err)}`,
              parked ? 'listed' : 'lost'
            );
          });
        }, RETRY_DELAY_MS * email.attempts);
      } else {
        // Move to failed queue
        let parked = false;
        if (redis.isAvailable()) {
          parked = await (
            redis.getClient()?.lpush(FAILED_KEY, JSON.stringify(email)) ?? Promise.resolve(null)
          )
            .then(r => r !== null)
            .catch(() => false);
        }
        await this.reportPermanentFailure(
          email,
          'max attempts reached',
          parked ? 'listed' : 'lost'
        );
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
  private async reportPermanentFailure(
    email: QueuedEmail,
    why: string,
    // Whether the email is in `email:failed` (replayable from the page) — the
    // alert must never send the operator to a page that cannot show it.
    where: 'listed' | 'lost'
  ): Promise<void> {
    logger.error(
      { emailId: email.id, storeId: email.storeId, attempts: email.attempts, why, where },
      '[EMAIL QUEUE] Email failed permanently'
    );
    await sendAlert({
      level: 'p1',
      source: 'email.queue.permanent_failure',
      title: 'Queued email failed permanently',
      body:
        `Email ${email.id} was not delivered after ${email.attempts} attempt(s) (${why}). ` +
        (where === 'listed'
          ? 'Replay it from the super-admin Email queue page once the provider recovers.'
          : 'It could NOT be saved to the Email queue page (Redis unavailable) — use the ' +
            'subject and store below to identify the order and resend it by hand.'),
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
   * Re-queue every dead-lettered email.
   *
   * Issue 2292: a single unreadable entry used to throw out of the loop AFTER
   * `rpop` had removed it — that record destroyed, everything behind it never
   * retried, the route 500ing with no audit row. Each entry is now parsed on
   * its own; an unreadable one is moved to `email:failed:corrupt` (kept, never
   * re-popped here) and counted as skipped. The loop is bounded by the list's
   * length when it started, so it always terminates.
   */
  async retryFailed(): Promise<{ retried: number; skipped: number }> {
    if (!redis.isAvailable()) return { retried: 0, skipped: 0 };

    const client = redis.getClient();
    if (!client) return { retried: 0, skipped: 0 };
    let retried = 0;
    let skipped = 0;

    const total = await client.llen(FAILED_KEY);
    for (let i = 0; i < total; i++) {
      const emailJson = await client.rpop(FAILED_KEY);
      if (!emailJson) break;

      let email: QueuedEmail;
      try {
        email = JSON.parse(emailJson) as QueuedEmail;
        if (!email || typeof email !== 'object' || !email.options) throw new Error('bad shape');
      } catch {
        await client.lpush(FAILED_CORRUPT_KEY, emailJson);
        skipped++;
        logger.error(
          { bytes: emailJson.length },
          '[EMAIL QUEUE] unreadable dead-lettered email moved to email:failed:corrupt'
        );
        continue;
      }
      email.attempts = 0;
      email.error = undefined;

      await client.lpush(QUEUE_KEY, JSON.stringify(email));
      retried++;
    }

    logger.info({ retried, skipped }, '[EMAIL QUEUE] Retrying failed emails');
    if (skipped > 0) {
      // Set aside is not silent (PR 2335 audit): an operator is told how many
      // unreadable entries were parked and where, so they are not invisible.
      await sendAlert({
        level: 'p1',
        source: 'email.queue.corrupt_entries',
        title: 'Unreadable dead-lettered emails set aside',
        body:
          `${skipped} dead-lettered email entr(ies) could not be parsed during "Retry all" and ` +
          `were moved to Redis list \`${FAILED_CORRUPT_KEY}\` (not replayed). Inspect with ` +
          '`railway connect Redis` → `LRANGE email:failed:corrupt 0 -1`.',
        context: { skipped, list: FAILED_CORRUPT_KEY },
      }).catch(() => undefined);
    }
    return { retried, skipped };
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
