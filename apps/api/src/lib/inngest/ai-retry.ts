import { AppError } from '../../middleware/error-handler';
import { AI_QUOTA_DAILY_CODE, isPlatformQuotaCap } from '../ai-quota';
import logger from '../logger';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_MAX_ATTEMPTS = 6;
const MAX_DELAY_MS = 90_000;
const BASE_DELAY_MS = 2_000;
const JITTER_MS = 750;
// A per-minute RPM throttle reports a retryDelay of a few seconds; a
// genuine daily free-tier quota exhaustion routinely reports minutes to
// hours. Anything at/above this floor is treated as a day-scale signal —
// see isDailyQuotaExhaustion below.
const DAILY_QUOTA_RETRY_DELAY_FLOOR_MS = 60_000;

function parseRetryDelayMs(msg: string): number | null {
  const m = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (!m) return null;
  const seconds = parseFloat(m[1]);
  if (!isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.ceil(seconds * 1000), MAX_DELAY_MS);
}

function expBackoffMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

/**
 * Best-effort text extraction for classifying a Gemini error. The SDK
 * usually throws an Error whose `.message` already embeds the raw
 * `error.details` JSON (quotaId, quotaMetric, RetryInfo), but the error
 * may also arrive as a plain object or bare string — parse defensively.
 */
function errorSurfaceText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? '';
  } catch {
    return String(err);
  }
}

/**
 * A genuine Gemini free-tier DAILY quota exhaustion is unrecoverable
 * within the retry window — retrying it up to 6x with up-to-90s backoff
 * just burns ~71 minutes before giving up anyway. Distinguish it from a
 * normal per-minute RPM throttle (short retryDelay, seconds) using the
 * signals Google's quota error actually carries:
 *   - quotaId / quotaMetric mentioning "PerDay" + "FreeTier"/"free_tier"
 *     (e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
 *     ".../generate_content_free_tier_requests")
 *   - a RetryInfo.retryDelay at/above DAILY_QUOTA_RETRY_DELAY_FLOOR_MS
 */
function isDailyQuotaExhaustion(text: string): boolean {
  if (/PerDay/i.test(text) && /free[_-]?tier/i.test(text)) return true;
  const retryDelayMs = parseRetryDelayMs(text);
  return retryDelayMs !== null && retryDelayMs >= DAILY_QUOTA_RETRY_DELAY_FLOOR_MS;
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status =
        (err as { status?: number; statusCode?: number; response?: { status?: number } })?.status ??
        (err as { statusCode?: number })?.statusCode ??
        (err as { response?: { status?: number } })?.response?.status;
      const msg = errorSurfaceText(err);

      // Abort immediately on a genuine daily free-tier exhaustion instead of
      // retry-storming — the bulk-loop stop check (isAiQuotaCapError)
      // recognizes AI_QUOTA_DAILY_CODE and halts the whole sweep cleanly.
      if (status === 429 && !isPlatformQuotaCap(err) && isDailyQuotaExhaustion(msg)) {
        logger.warn(
          { label, attempt, err: msg.slice(0, 300) },
          '[bulk-ai] Gemini daily free-tier quota exhausted — aborting instead of retrying'
        );
        throw new AppError(
          429,
          AI_QUOTA_DAILY_CODE,
          'Gemini daily free-tier quota reached. The sweep has stopped and will resume automatically once quota resets.'
        );
      }

      // A 429 is retry-worthy UNLESS it's a deterministic platform daily/monthly
      // cap (retrying within the window can't succeed) or the Gemini-side daily
      // exhaustion detected above. A Gemini-wrapped 429 (AI_QUOTA_EXCEEDED) may
      // be a per-minute RPM throttle, so we DO retry it with backoff (honouring
      // Gemini's retryDelay) — only genuinely stuck cases are terminal.
      const transient =
        status === 503 ||
        (status === 429 && !isPlatformQuotaCap(err)) ||
        /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg);

      if (!transient || attempt === maxAttempts) throw err;

      const explicit = parseRetryDelayMs(msg);
      const baseDelay = explicit ?? expBackoffMs(attempt);
      const delayMs = baseDelay + Math.floor(Math.random() * JITTER_MS);

      logger.warn(
        {
          label,
          attempt,
          maxAttempts,
          status,
          delayMs,
          honoringServerRetryDelay: explicit !== null,
          err: msg.slice(0, 300),
        },
        '[bulk-ai] transient gemini failure, retrying'
      );

      await sleep(delayMs);
    }
  }
  throw new Error(`callWithRetry: exhausted ${maxAttempts} attempts for ${label}`);
}
