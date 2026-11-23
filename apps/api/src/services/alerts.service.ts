import { BRAND } from '@ebda/shared';
import { config } from '../config';
import logger from '../lib/logger';
import { cfWaitUntil } from '../cf/bindings';
import { isDemoStore } from '../lib/demo-store';
import { redis } from './redis.service';
import { buildAlertText, telegramAlert, type AlertMessage } from '@ebda/shared/observe';

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

/**
 * Scope distinguishes "the platform broke" from "one tenant broke".
 * Platform alerts indicate something every store will feel (Railway,
 * Neon, Redis, Inngest dispatcher). Store alerts isolate the blast
 * radius to the named tenant so the operator can act on the right
 * store without guessing.
 */
export type AlertScope = 'platform' | 'store';

export interface AlertStoreContext {
  /** Store.id — the UUID. Required so logs/joins resolve uniquely. */
  id: string;
  /** Store.name — what shows up in the Telegram header. */
  name: string;
  /** Store.slug — the URL-path identifier; renders in the header next to name. */
  slug?: string;
}

export interface AlertOptions {
  /** P0 = wake someone now. P1 = degraded, can wait until morning. info = log-only style. */
  level: AlertLevel;
  /** 'platform' (default) = infra/global. 'store' = single tenant; requires `store`. */
  scope?: AlertScope;
  /** Required when scope='store'. Identifies the tenant in the alert header + throttle key. */
  store?: AlertStoreContext;
  /**
   * Canonical code location the alert originated from (e.g.
   * `payment.webhook.hmac_fail`, `cron.abandoned-cart-purge`,
   * `process.uncaughtException`). Surfaced in the header so an
   * operator can grep the codebase or runbook instantly.
   */
  source?: string;
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
 * The alert as the foundation's shared shape (Ruling FDN-OBSERVE-1: ONE message layout for every product, title/body/context masked for
 * phones and e-mails, credential keys dropped from context). Header:
 *   🔴 Ebda Store: payment.webhook.hmac_fail
 *   [P0 STORE]
 *   store=Demo Shop (demo-shop · 00000000…)
 *   env=production · source=payment.webhook.hmac_fail
 * The scope tag (`PLATFORM` or `STORE`) makes "is this everyone or just one merchant?" the first thing the operator sees; the store line
 * carries the slug so it can be copy-pasted into an admin URL. Plain text, no parse_mode (MarkdownV2 escaping bugs silently drop messages).
 */
function toAlertMessage(opts: AlertOptions): AlertMessage {
  const scope = opts.scope ?? 'platform';
  let scopeLine: string | undefined;
  if (scope === 'store' && opts.store) {
    const idSuffix = opts.store.id.length > 8 ? `${opts.store.id.slice(0, 8)}…` : opts.store.id;
    scopeLine = `${opts.store.name} (${opts.store.slug ? `${opts.store.slug} · ` : ''}${idSuffix})`;
  }
  return {
    // Product name FIRST (Ahmad 2026-10-14): one Ebda AI Studio bot serves every product, so each alert says which one broke.
    product: BRAND.product.nameEn,
    level: opts.level,
    scope,
    ...(scopeLine ? { scopeLine } : {}),
    title: opts.title,
    ...(opts.source ? { source: opts.source } : {}),
    env: config.nodeEnv,
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  };
}

/**
 * Throttle bucket includes storeId so a flapping store A doesn't
 * suppress a genuinely-new alert for store B that happens to share
 * a title. Platform alerts share a single bucket (no storeId).
 */
export function throttleKey(level: AlertLevel, title: string, storeId?: string): string {
  // No hash at all: the bucket name IS the identity, so two distinct (level, store, title) can never share a bucket and a crafted
  // title cannot suppress a real P1. `level` is a fixed set, and the store id and the title each carry their own length, so no field can
  // spill into another. (The previous sha1 digest raised CodeQL js/weak-cryptographic-algorithm and js/insufficient-password-hash
  // on every PR touching this file, because alert titles carry sign-in and password wording; a digest of any speed would still
  // trip the second rule, and nothing here needs one.)
  const store = storeId ?? '';
  return `alert-throttle:${level}:${store.length}:${store}:${title.length}:${title}`;
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
export function sendAlert(opts: AlertOptions): Promise<AlertOutcome> {
  // Hard deadline on the WHOLE send (throttle lock + POST + body read), so a
  // tracked entry can never outlive it (issue 2393): a Redis or Telegram call
  // that never settles resolves as 'failed' here and leaves the set, instead
  // of pinning `opts` for the life of the process and eating the full
  // shutdown drain window on every SIGTERM.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<AlertOutcome>(resolve => {
    deadline = setTimeout(() => {
      logger.error(
        { level: opts.level, title: opts.title, deadlineMs: ALERT_SEND_DEADLINE_MS },
        'alerts.service: send exceeded its deadline; abandoned'
      );
      resolve('failed');
    }, ALERT_SEND_DEADLINE_MS);
    deadline.unref?.();
  });
  const p: Promise<AlertOutcome> = Promise.race([deliverAlert(opts), timedOut]).finally(() => {
    clearTimeout(deadline);
    inFlightAlerts.delete(p);
  });
  inFlightAlerts.add(p);
  // On a Worker, `void sendAlert(..)` (47 call sites, incl. the P1 "Refund needs review", webhook and orphaned-invoice
  // alerts) is cancelled when the response returns: inFlightAlerts only serves a Node SIGTERM drain. Keep it alive past the
  // response (ctx.waitUntil); outside a Worker request this is a detached no-op.
  cfWaitUntil(p);
  return p;
}

/** Telegram request cap: connect + headers + body read, one AbortController. */
const TELEGRAM_TIMEOUT_MS = 5000;

/**
 * Upper bound on one `sendAlert`, lock included. `gracefulShutdown` drains
 * with exactly this budget, so every send tracked at SIGTERM has settled (or
 * been abandoned) by the time the drain returns.
 */
export const ALERT_SEND_DEADLINE_MS = 6000;

type AlertOutcome = 'sent' | 'throttled' | 'skipped' | 'failed';

/**
 * Every send still in flight, so a graceful shutdown can wait for them
 * (issue 2387). Most call sites DETACH the send (`void sendAlert(...)`, the
 * orphaned-invoice page, the queue dead-letter pages): nothing awaits them, so
 * on SIGTERM `redis.disconnect()` killed an in-flight throttle lock and
 * `process.exit(0)` cut the Telegram POST — and the incidents that page are
 * exactly the ones followed by a Railway restart. Tracking here, at the one
 * function every page goes through, covers every detached caller at once.
 */
const inFlightAlerts = new Set<Promise<AlertOutcome>>();

/**
 * Wait for every in-flight alert send to settle, up to `timeoutMs`. Call from
 * `gracefulShutdown` BEFORE `redis.disconnect()` (the throttle lock needs it).
 * Never rejects: `deliverAlert` itself never rejects, and a timeout means
 * "stop waiting".
 */
export async function awaitInFlightAlerts(timeoutMs: number): Promise<void> {
  if (inFlightAlerts.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.allSettled(Array.from(inFlightAlerts)).then(() => undefined);
  await Promise.race([pending, new Promise<void>(r => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
}

/**
 * Mirror one alert to the AI OS brain (`POST {EBDA_OS_BRAIN_URL}/alerts`, Bearer EBDA_OS_INGEST_TOKEN), Ruling ESC-AIOS-1 / AIOS-8.
 * Same text as the Telegram message. Unset token = no-op. A failure is logged and swallowed: Telegram stays the delivery path.
 */
export async function mirrorToBrain(opts: AlertOptions, text: string): Promise<boolean> {
  // an https brain URL and a token, or no mirror (never an alert body to a mistyped / plain-http host)
  if (!config.osIngestToken || !/^https:\/\/[^/\s]+/.test(String(config.osBrainUrl ?? '')))
    return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.osBrainUrl.replace(/\/$/, '')}/alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.osIngestToken}`,
      },
      body: JSON.stringify({
        source: 'ebda-store/api',
        level: opts.level,
        title: opts.title.slice(0, 300),
        text: text.slice(0, 4096),
        at: Date.now(),
      }),
      signal: controller.signal,
    });
    if (!res.ok)
      logger.warn(
        { status: res.status, level: opts.level },
        'alerts.service: brain mirror rejected'
      );
    return res.ok;
  } catch (err) {
    logger.warn({ err, level: opts.level }, 'alerts.service: brain mirror failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function deliverAlert(opts: AlertOptions): Promise<AlertOutcome> {
  if (!isConfigured()) {
    emitBootWarningOnce('TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID missing');
    return 'skipped';
  }

  // A demo store (the looks showroom) has no merchant and no revenue: its store-scoped alerts are noise (2026-11-05: the Dahab
  // showroom paged "selling paused"). Log at info, send nothing. Platform-scoped alerts are never affected.
  if (opts.scope === 'store' && opts.store) {
    if (await isDemoStore(opts.store.id)) {
      logger.info(
        { storeId: opts.store.id, source: opts.source, level: opts.level },
        'store alert skipped: demo store'
      );
      return 'skipped';
    }
  }

  // Caller-side scope/store sanity. We log + degrade rather than throw
  // because alert delivery must never break the calling code path —
  // if a P0 firing site forgot to attach store context, the alert
  // still goes out as platform-scoped (better than silent loss).
  if (opts.scope === 'store' && !opts.store) {
    logger.warn(
      { level: opts.level, title: opts.title, source: opts.source },
      'alerts.service: scope=store with no store context; degrading to platform'
    );
  }

  // Per-(level, title, storeId?) Redis throttle. acquireLock returns
  // true when the key didn't exist (we got the slot), false when held.
  // Fail-open when Redis is unavailable so a Redis outage doesn't
  // suppress alerts about the Redis outage itself. That includes a Redis
  // that is CONNECTED but rejecting writes (OOM, MISCONF, read-only):
  // acquireLock only short-circuits on "not connected", so its SET NX
  // throws — and that is exactly the state the dead-letter `lost` P1s
  // fire in (issue 2384). Fail-open stays local to the alert throttle;
  // acquireLock's other callers (cron leader locks) need fail-closed.
  const lockName = throttleKey(opts.level, opts.title, opts.store?.id);
  let slot: boolean;
  try {
    slot = await redis.acquireLock(lockName, THROTTLE_TTL_SECONDS);
  } catch (err) {
    logger.warn(
      { err, level: opts.level, source: opts.source },
      'alerts.service: throttle lock threw; sending unthrottled'
    );
    slot = true;
  }
  if (!slot) {
    return 'throttled';
  }

  const message = toAlertMessage(opts);
  const text = buildAlertText(message);
  // Mirror to the AI OS brain in parallel with Telegram. It is AWAITED before returning (it never throws and has its own 5 s cap):
  // on Workers a fetch still pending when the request or cron handler finishes is cancelled, so a fire-and-forget mirror was lost
  // (2026-11-11: the Sentry-bridge test alert reached Telegram but not the brain while the mirror was fire-and-forget). Its result never changes the outcome.
  const mirror = mirrorToBrain(opts, text);

  // The foundation owns the POST (5 s abort armed through the error-body read too, issue 2393; never throws); this file keeps the Redis throttle,
  // the demo-store skip, the brain mirror and the in-flight tracking above.
  const outcome = await telegramAlert(
    {
      token: config.telegramBotToken,
      chatId: config.telegramAlertChatId,
      timeoutMs: TELEGRAM_TIMEOUT_MS,
      disableWebPagePreview: true,
      onError: ({ status, detail, err }) => {
        if (status !== undefined)
          logger.error(
            { status, level: opts.level, title: opts.title, detail },
            'alerts.service: Telegram sendMessage rejected'
          );
        else
          logger.error(
            { err, level: opts.level, title: opts.title },
            'alerts.service: Telegram sendMessage threw'
          );
      },
    },
    message
  );
  await mirror;
  return outcome;
}
