import { isAiQuotaCapError } from '../ai-quota';
import logger from '../logger';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_MAX_ATTEMPTS = 6;
const MAX_DELAY_MS = 90_000;
const BASE_DELAY_MS = 2_000;
const JITTER_MS = 750;

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
        (err as { status?: number; response?: { status?: number } })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
      const msg = (err instanceof Error ? err.message : String(err)) ?? '';
      const transient =
        status === 503 ||
        (status === 429 && !isAiQuotaCapError(err)) ||
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
