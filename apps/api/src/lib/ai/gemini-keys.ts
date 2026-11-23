import { GoogleGenerativeAI, type GenerativeModel, type ModelParams } from '@google/generative-ai';
import logger from '../logger';
import { LLM_FETCH_TIMEOUT_MS } from '../fetch-timeout';

/**
 * Gemini key failover (Ruling GEMINI-FAILOVER-1).
 *
 * Production holds several Gemini keys from SEPARATE Google Cloud projects
 * (separate quotas): GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3 ...
 * Every Gemini call routes through here. On a quota error (HTTP 429 /
 * RESOURCE_EXHAUSTED) the SAME request is retried with the next key, and the
 * exhausted key is remembered (in-memory, per isolate) until its Retry-After
 * or the next UTC day (daily-quota errors) so it is not hammered.
 *
 * Key VALUES are never logged — only the key index.
 */

const SHORT_COOLDOWN_MS = 60_000;
const MAX_NUMBERED_KEYS = 20;

/** Ordered, de-duplicated key list read from the environment at call time. */
export function getGeminiKeys(extraFirst?: string): string[] {
  const env = process.env;
  const raw: Array<string | undefined> = [
    extraFirst,
    env.GOOGLE_GENERATIVE_AI_KEY,
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_2,
  ];
  for (let n = 3; n <= MAX_NUMBERED_KEYS; n++) raw.push(env[`GEMINI_API_KEY_${n}`]);
  const out: string[] = [];
  for (const k of raw) {
    const v = k?.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// bench id -> epoch ms until which it is skipped. Keyed by key VALUE (not index) so
// a re-ordered list keeps its memory; the value itself is never logged. A scoped call
// (e.g. Google Search grounding, which has its own quota) benches `<scope>\0<key>`
// only, so its 429 never benches the key for plain calls.
const exhaustedUntil = new Map<string, number>();

function benchId(key: string, scope?: string): string {
  return scope ? `${scope}\u0000${key}` : key;
}

export function resetGeminiKeyState(): void {
  exhaustedUntil.clear();
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function isGeminiQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; message?: unknown };
  if (e.status === 429) return true;
  return typeof e.message === 'string' && /RESOURCE_EXHAUSTED|\b429\b/.test(e.message);
}

/** How long to bench a key after a quota error: Retry-After > daily quota > 60s. */
export function cooldownFor(err: unknown, now: number): number {
  const e = err as {
    message?: string;
    retryAfterSeconds?: number;
    errorDetails?: Array<{ retryDelay?: string }>;
  };
  let seconds = typeof e?.retryAfterSeconds === 'number' ? e.retryAfterSeconds : undefined;
  if (seconds === undefined) {
    const delay = e?.errorDetails?.find(d => typeof d?.retryDelay === 'string')?.retryDelay;
    const m = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
    if (m) seconds = parseFloat(m[1]);
  }
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    return now + Math.ceil(seconds) * 1000;
  }
  if (typeof e?.message === 'string' && /PerDay|per day|daily/i.test(e.message)) {
    return nextUtcMidnight(now);
  }
  return now + SHORT_COOLDOWN_MS;
}

/**
 * Run `fn` with each usable key in order until one does not hit a quota error.
 * Non-quota errors propagate immediately (a 400 on key 1 is a 400 on key 2).
 * When every key is benched, throws a 429-shaped error without calling Google.
 * `benchScope` isolates the bench for calls with a separate quota (search grounding):
 * a quota error there benches only that scope, never the key for unscoped calls.
 */
export async function withGeminiFailover<T>(
  fn: (apiKey: string, keyIndex: number) => Promise<T>,
  firstKey?: string,
  opts?: { benchScope?: string }
): Promise<T> {
  const keys = getGeminiKeys(firstKey);
  if (keys.length === 0) {
    throw Object.assign(new Error('no Gemini API key configured'), { status: 503 });
  }
  let lastErr: unknown;
  let tried = 0;
  for (let i = 0; i < keys.length; i++) {
    const now = Date.now();
    const id = benchId(keys[i], opts?.benchScope);
    const until = exhaustedUntil.get(id);
    if (until !== undefined) {
      if (until > now) continue;
      exhaustedUntil.delete(id);
    }
    tried++;
    try {
      return await fn(keys[i], i);
    } catch (err) {
      if (!isGeminiQuotaError(err)) throw err;
      lastErr = err;
      exhaustedUntil.set(id, cooldownFor(err, now));
      logger.warn(
        { keyIndex: i, keyCount: keys.length, scope: opts?.benchScope },
        'gemini key hit quota, failing over'
      );
    }
  }
  if (tried === 0) {
    logger.warn(
      { keyCount: keys.length, scope: opts?.benchScope },
      'all gemini keys benched, not calling Google'
    );
    throw Object.assign(new Error('all Gemini keys are rate limited (RESOURCE_EXHAUSTED)'), {
      status: 429,
    });
  }
  throw lastErr;
}

type GenerateArgs = Parameters<GenerativeModel['generateContent']>;

/**
 * Drop-in for `new GoogleGenerativeAI(key)`. `getGenerativeModel(params)`
 * returns a model whose `generateContent` fails over across the key list.
 * `firstKey` (the caller's configured key) is tried first, de-duplicated.
 */
export class GeminiFailoverClient {
  constructor(private readonly firstKey?: string) {}

  getGenerativeModel(params: ModelParams): Pick<GenerativeModel, 'generateContent'> {
    return {
      generateContent: (...args: GenerateArgs) =>
        withGeminiFailover(
          apiKey =>
            new GoogleGenerativeAI(apiKey)
              .getGenerativeModel(params, { timeout: LLM_FETCH_TIMEOUT_MS })
              .generateContent(...args),
          this.firstKey
        ),
    };
  }
}
