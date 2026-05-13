import crypto from 'crypto';
import { config } from '../config';
import logger from '../lib/logger';
import { redis } from './redis.service';

/**
 * Out-of-band alerting channel (iceberg item #12 / CLAUDE.md rule #6).
 *
 * Sentry catches errors but requires the server to be alive to phone
 * home — it cannot tell you the API is unreachable at 3am. This service
 * complements Sentry by pushing structured alerts to a Telegram chat
 * for events the operator needs to see live (P0 outages, payment
 * webhook integrity fails, scheduled-job failures, etc).
 *
 * Companion to the external UptimeRobot monitor on `/health` which
 * fires the "server is down" case. Together: UptimeRobot catches
 * "process is gone", Sentry catches "code threw", this service
 * catches "code ran but the answer means I have to wake someone up".
 *
 * Telegram is the transport because it's free, has a real mobile push
 * channel (instant), supports group chats so multiple operators can
 * see the same alert, and the API is a single POST. No SDK.
 *
 * Graceful degrade: when `TELEGRAM_BOT_TOKEN` or `TELEGRAM_ALERT_CHAT_ID`
 * are missing, every send is a no-op + a single warn line at boot.
 * The service NEVER throws — alert delivery failure must never take
 * down the calling code path (the alternative is "the alert about the
 * server being broken also breaks the server").
 */

export type AlertLevel = 'p0' | 'p1' | 'info';

export interface AlertOptions {
  /** P0 = wake someone now. P1 = degraded, can wait until morning. info = log-only style. */
  level: AlertLevel;
  /** Short human-readable headline. Used for de-duplication, so keep it stable per event class. */
  title: string;
  /** Free-form body. Newlines preserved. Truncated to 3500 chars (Telegram's 4096 cap minus headers). */
  body?: string;
  /** Structured context appended as a code block. */
  context?: Record<string, unknown>;
}

// Each (level + title) combo is throttled — a flapping payment provider
// firing the same alert 100x/min must not fan out 100 Telegram messages.
// 5 min covers the most common flap window without delaying a genuinely
// new event class.
const THROTTLE_TTL_SECONDS = 300;

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  p0: '🔴',
  p1: '🟠',
  info: '🔵',
};

const TELEGRAM_MAX_LEN = 4096;
const BODY_MAX_LEN = 3500;

let bootWarningEmitted = false;

function emitBootWarningOnce(reason: string): void {
  if (bootWarningEmitted) return;
  bootWarningEmitted = true;
  logger.warn(
    { reason },
    'alerts.service: Telegram alert channel not configured — sendAlert() is a no-op'
  );
}

function isConfigured(): boolean {
  return Boolean(config.telegramBotToken && config.telegramAlertChatId);
}

/**
 * MarkdownV2 needs every reserved character escaped, even inside code
 * blocks for some clients. We use plain text mode (no parse_mode) to
 * sidestep escaping bugs that would silently drop messages.
 */
function buildMessage(opts: AlertOptions): string {
  const emoji = LEVEL_EMOJI[opts.level];
  const env = config.nodeEnv;
  const header = `${emoji} [${opts.level.toUpperCase()}] ${opts.title}\nenv=${env}`;

  const lines: string[] = [header];
  if (opts.body) {
    const trimmed =
      opts.body.length > BODY_MAX_LEN ? `${opts.body.slice(0, BODY_MAX_LEN)}…` : opts.body;
    lines.push('', trimmed);
  }
  if (opts.context && Object.keys(opts.context).length > 0) {
    try {
      const ctx = JSON.stringify(opts.context, null, 2);
      lines.push('', ctx);
    } catch {
      // context unrenderable (circular refs etc) — skip silently
    }
  }

  const message = lines.join('\n');
  return message.length > TELEGRAM_MAX_LEN ? `${message.slice(0, TELEGRAM_MAX_LEN - 1)}…` : message;
}

function throttleKey(level: AlertLevel, title: string): string {
  const hash = crypto.createHash('sha1').update(`${level}:${title}`).digest('hex').slice(0, 16);
  return `alert-throttle:${hash}`;
}

/**
 * Send an alert. Always safe to call — never throws, returns the
 * delivery outcome for observability but callers should generally
 * ignore the result.
 *
 * Returns:
 *   - 'sent'        → delivered to Telegram
 *   - 'throttled'   → same (level, title) sent within the last 5 min
 *   - 'skipped'     → channel not configured
 *   - 'failed'      → Telegram API rejected or fetch errored (logged)
 */
export async function sendAlert(
  opts: AlertOptions
): Promise<'sent' | 'throttled' | 'skipped' | 'failed'> {
  if (!isConfigured()) {
    emitBootWarningOnce('TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID missing');
    return 'skipped';
  }

  // Per-(level,title) Redis throttle. acquireLock returns true when the
  // key didn't exist (we got the slot) and false when it did (someone
  // else holds the cooldown). Fail-open when Redis is unavailable so a
  // Redis outage doesn't suppress alerts about the Redis outage.
  const lockName = throttleKey(opts.level, opts.title);
  const slot = await redis.acquireLock(lockName, THROTTLE_TTL_SECONDS);
  if (!slot) {
    return 'throttled';
  }

  const text = buildMessage(opts);
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    // Telegram occasionally hangs on the connection — cap with a 5s
    // timeout so a P0 alert path doesn't block on a flaky network.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramAlertChatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error(
        { status: res.status, level: opts.level, title: opts.title, detail: detail.slice(0, 500) },
        'alerts.service: Telegram sendMessage rejected'
      );
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    logger.error(
      { err, level: opts.level, title: opts.title },
      'alerts.service: Telegram sendMessage threw'
    );
    return 'failed';
  }
}
