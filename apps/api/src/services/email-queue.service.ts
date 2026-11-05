/**
 * Email Queue Service
 * Async email processing with Redis queue
 */

import crypto from 'crypto';
import { redis } from './redis.service';
import { EmailService, EmailOptions } from './email.service';
import { SKIPPED_UNDELIVERABLE_ID } from './mail-transport';
import { withCircuitBreaker } from './circuit-breaker.service';
import logger from '../lib/logger';
import { maskEmailList } from '../lib/pii-mask';
import { sendAlert } from './alerts.service';
import { CORRUPT_CAP, replayDeadLetters, setAsideUnreadable } from '../lib/dead-letter';
import { isWorkers } from '../lib/runtime';
import { cfBindings } from '../cf/bindings';

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

/**
 * The ONE definition of a readable queued email (issues 2371, 2374): every
 * field a consumer dereferences — `sendEmail` (`options.to/subject/html`), the
 * dead-letter list route (`id`, `options.to`, `options.subject`). Used by the
 * live-queue processor, the dead-letter reader AND the replayer, so they can
 * never disagree about what "unreadable" means: an entry that parses but fails
 * this is set aside (`email:failed:corrupt`), never sent, listed or 500ed on.
 */
export function isQueuedEmail(v: unknown): v is QueuedEmail {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Partial<QueuedEmail>;
  const o = e.options as Partial<EmailOptions> | undefined;
  if (typeof e.id !== 'string' || !o || typeof o !== 'object' || Array.isArray(o)) return false;
  const toOk =
    typeof o.to === 'string' || (Array.isArray(o.to) && o.to.every(t => typeof t === 'string'));
  return toOk && typeof o.subject === 'string' && typeof o.html === 'string';
}

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

    if (isWorkers) {
      // Cloudflare Queues: durable, at-least-once, retried by the platform, dead-lettered
      // into `ebda-email-dlq` (see `deliver` / `parkDeadLetter`, wired in cf/queues.ts).
      const queue = cfBindings()?.EMAIL_QUEUE;
      if (queue) {
        await queue.send(queuedEmail, { contentType: 'json' });
      } else {
        logger.warn('[EMAIL QUEUE] EMAIL_QUEUE binding missing, sending immediately');
        await this.sendEmail(queuedEmail, { inline: true });
      }
    } else if (redis.isAvailable()) {
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
   * Cloudflare Queues consumer: ONE attempt, and it THROWS on failure so the platform
   * retries the message (`max_retries`, `retry_delay` in wrangler.jsonc) and, once those
   * are spent, moves it to the dead-letter queue (`parkDeadLetter`).
   */
  async deliver(email: QueuedEmail): Promise<void> {
    await this.sendEmail(email, { inline: true });
  }

  /**
   * Dead-letter queue consumer: park the exhausted email on the `email:failed` list the
   * super-admin Email queue page reads (replayable), and page an operator. Cloudflare Queues
   * has no API to browse a DLQ, which is why the list is the read side.
   */
  async parkDeadLetter(email: QueuedEmail, why = 'max attempts reached'): Promise<void> {
    let parked = false;
    if (redis.isAvailable()) {
      parked = await (
        redis.getClient()?.lpush(FAILED_KEY, JSON.stringify(email)) ?? Promise.resolve(null)
      )
        .then(r => r !== null)
        .catch(() => false);
    }
    await this.reportPermanentFailure(email, why, parked ? 'listed' : 'lost');
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

      let email: unknown;
      try {
        email = JSON.parse(emailJson);
      } catch {
        email = undefined;
      }
      if (!isQueuedEmail(email)) {
        // Unreadable: sending would throw after the rpop and destroy it.
        // Set it aside with the replay's unreadable entries (issue 2371).
        // Issue 2378: the rpop already removed it, so a rejected park must
        // not propagate — it is put back on the live queue, and only if
        // that write fails too is it lost (P1, size only: no payload).
        const outcome = await setAsideUnreadable(
          client,
          { corrupt: FAILED_CORRUPT_KEY, queue: QUEUE_KEY },
          emailJson,
          logger
        );
        if (outcome === 'lost') {
          await sendAlert({
            level: 'p1',
            source: 'email.queue.unreadable_lost',
            title: 'Unreadable queued email lost',
            body:
              `An unreadable entry (${emailJson.length} bytes) was removed from \`${QUEUE_KEY}\` and ` +
              'Redis rejected both the set-aside and the put-back, so it is gone. It could not be ' +
              'parsed, so there is no id or recipient to resend from.',
            context: { bytes: emailJson.length, list: QUEUE_KEY },
          }).catch(() => undefined);
        }
        return;
      }
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
      const sent = await withCircuitBreaker('email', () =>
        email.storeId
          ? EmailService.sendRaw(email.storeId, email.options)
          : EmailService.sendPlatformRaw(email.options)
      );

      if (sent?.id === SKIPPED_UNDELIVERABLE_ID) {
        // Every recipient was a reserved-TLD placeholder: nothing left the process, so it is not a send.
        logger.warn(
          { emailId: email.id, to: maskEmailList(email.options.to) },
          '[EMAIL QUEUE] Email dropped, no deliverable recipient (not sent)'
        );
        return;
      }
      logger.info(
        { emailId: email.id, to: maskEmailList(email.options.to) },
        '[EMAIL QUEUE] Sent email'
      );
    } catch (error) {
      email.error = error instanceof Error ? error.message : 'Unknown error';

      if (opts.inline) {
        logger.error(
          { emailId: email.id, storeId: email.storeId, err: error },
          '[EMAIL QUEUE] Send failed (inline, or a Queues consumer attempt) — rethrowing to the caller'
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
   * The unreadable set-aside entries (issue 2353), for the super-admin page.
   * They cannot be parsed, so no recipient can be masked — only their size is
   * returned, never the payload (the page's "body is never returned" rule).
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
   * Get failed emails for retry or inspection
   */
  async getFailedEmails(limit: number = 10): Promise<QueuedEmail[]> {
    if (!redis.isAvailable()) return [];

    const client = redis.getClient();
    const emails = await client?.lrange(FAILED_KEY, 0, limit - 1);

    // An entry that does not parse, or parses to the wrong shape, is skipped
    // here exactly as the replayer would set it aside (issue 2374): it stays
    // counted in `stats.failed`, so the page shows "unreadable", never a 500.
    return (emails || []).reduce<QueuedEmail[]>((acc, e) => {
      try {
        const parsed: unknown = JSON.parse(e);
        if (isQueuedEmail(parsed)) acc.push(parsed);
      } catch {
        // unparseable — same as above
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
   * re-popped here) and counted as skipped. Issue 2361: a Redis write that
   * rejects AFTER the `rpop` (a blip mid-"Retry all") no longer destroys the
   * entry or aborts the loop — it is put back on `email:failed` (`kept`). The
   * loop lives in `replayDeadLetters` (lib/dead-letter.ts), shared with the
   * SMS twin, and is bounded by the list's length when it started.
   */
  async retryFailed(): Promise<{ retried: number; skipped: number; kept: number }> {
    if (!redis.isAvailable()) return { retried: 0, skipped: 0, kept: 0 };

    const client = redis.getClient();
    if (!client) return { retried: 0, skipped: 0, kept: 0 };

    // Workers: "re-queue" means producing to Cloudflare Queues, not LPUSH-ing a list nobody consumes.
    const queue = isWorkers ? cfBindings()?.EMAIL_QUEUE : undefined;
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
    const { retried, skipped, kept, lost } = await replayDeadLetters<QueuedEmail>(
      replayClient,
      { failed: FAILED_KEY, corrupt: FAILED_CORRUPT_KEY, queue: QUEUE_KEY },
      isQueuedEmail,
      logger
    );

    logger.info({ retried, skipped, kept, lost }, '[EMAIL QUEUE] Retrying failed emails');
    if (lost > 0) {
      await sendAlert({
        level: 'p1',
        source: 'email.queue.replay_lost',
        title: 'Dead-lettered emails lost during retry',
        body:
          `${lost} dead-lettered email(s) were removed from \`${FAILED_KEY}\` during "Retry all" and ` +
          'Redis rejected both the re-queue and the put-back, so they are gone. Their ids are in ' +
          'the error log ("[dead-letter] replay write AND put-back failed").',
        context: { lost, list: FAILED_KEY },
      }).catch(() => undefined);
    }
    if (skipped > 0) {
      // Set aside is not silent (PR 2335 audit): an operator is told how many
      // unreadable entries were parked and where, so they are not invisible.
      await sendAlert({
        level: 'p1',
        source: 'email.queue.corrupt_entries',
        title: 'Unreadable dead-lettered emails set aside',
        body:
          `${skipped} dead-lettered email entr(ies) could not be parsed during "Retry all" and ` +
          `were moved to Redis list \`${FAILED_CORRUPT_KEY}\` (not replayed; newest ${CORRUPT_CAP}, ` +
          'kept 30 days). Count + discard: super-admin Email queue page. Raw payload: ' +
          '`railway connect Redis` → `LRANGE email:failed:corrupt 0 -1`.',
        context: { skipped, list: FAILED_CORRUPT_KEY },
      }).catch(() => undefined);
    }
    return { retried, skipped, kept };
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
