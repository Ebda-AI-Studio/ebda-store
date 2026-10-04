/**
 * ai-pricing.ts — converts token counts into money.
 *
 * Closes audit finding 25.3 (docs/audits/2026-08-08-reel-lens-audit.md): AI
 * spend was recorded in TOKENS and never in currency, so nothing could divide
 * cost by the revenue it served and per-tenant margin did not exist as a number.
 *
 * WHY RATES ARE ENV-CONFIGURED AND NOT HARDCODED
 * ----------------------------------------------
 * Provider prices change, differ per region and per contract, and a wrong
 * constant compiled into the app produces confident, wrong margin figures —
 * which is worse than none, because people act on them. So there are NO
 * built-in default prices. An unconfigured model yields `null`, and `null` is
 * stored as-is.
 *
 * `null` (no rate configured) is deliberately NOT the same as `0` (genuinely
 * free — a cached hit). Reports must not sum them together, and the admin
 * surface shows unpriced usage separately rather than folding it into 0.
 *
 * CONFIGURING
 * -----------
 * `AI_MODEL_RATES` is a JSON object mapping model id → per-MILLION-token price
 * in the billing currency, e.g.
 *
 *   AI_MODEL_RATES='{"gemini-flash-lite-latest":{"in":0.10,"out":0.40}}'
 *
 * Take the numbers from the provider's current pricing page for your region.
 * Verify them when you set them; nothing here can validate that they are right.
 */
import logger from './logger';

export interface ModelRate {
  /** Price per 1,000,000 INPUT tokens, in the billing currency. */
  in: number;
  /** Price per 1,000,000 OUTPUT tokens, in the billing currency. */
  out: number;
}

const MICROS_PER_UNIT = 1_000_000;
const TOKENS_PER_RATE_UNIT = 1_000_000;

let cachedRates: Record<string, ModelRate> | null = null;
let warnedUnpriced = new Set<string>();

function loadRates(): Record<string, ModelRate> {
  if (cachedRates) return cachedRates;
  const raw = process.env.AI_MODEL_RATES;
  if (!raw) {
    cachedRates = {};
    return cachedRates;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelRate>;
    const clean: Record<string, ModelRate> = {};
    for (const [model, rate] of Object.entries(parsed)) {
      // Reject anything that would silently produce a garbage cost. A
      // malformed entry must behave like "unpriced", never like "free".
      if (
        rate &&
        typeof rate.in === 'number' &&
        typeof rate.out === 'number' &&
        Number.isFinite(rate.in) &&
        Number.isFinite(rate.out) &&
        rate.in >= 0 &&
        rate.out >= 0
      ) {
        clean[model] = { in: rate.in, out: rate.out };
      } else {
        logger.warn({ model }, '[ai-pricing] ignoring malformed rate entry');
      }
    }
    cachedRates = clean;
  } catch (err) {
    // A bad env value must not take AI features down — it just means unpriced.
    logger.error(
      { err },
      '[ai-pricing] AI_MODEL_RATES is not valid JSON — all usage will be unpriced'
    );
    cachedRates = {};
  }
  return cachedRates;
}

/** Test seam — rates are cached per process, so tests must be able to reset. */
export function __resetRateCacheForTests(): void {
  cachedRates = null;
  warnedUnpriced = new Set<string>();
}

/**
 * Cost of one call in MICROS of the billing currency, or `null` when the model
 * has no configured rate.
 *
 * Micros, not piastres: a single flash-lite call is routinely a small fraction of
 * one piastres, and integer piastres would round essentially every row to 0, making the
 * whole column useless for exactly the small-per-call/large-in-aggregate spend
 * it exists to measure.
 */
export function computeCostMicros(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number
): number | null {
  if (!model) return null;
  const rate = loadRates()[model];
  if (!rate) {
    if (!warnedUnpriced.has(model)) {
      warnedUnpriced.add(model);
      logger.warn(
        { model },
        '[ai-pricing] no rate configured for model — usage will be recorded unpriced. Set AI_MODEL_RATES.'
      );
    }
    return null;
  }
  const inTokens = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const outTokens = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const units =
    (inTokens / TOKENS_PER_RATE_UNIT) * rate.in + (outTokens / TOKENS_PER_RATE_UNIT) * rate.out;
  // Round rather than truncate so a long run of sub-micro calls does not
  // systematically under-report spend.
  return Math.round(units * MICROS_PER_UNIT);
}

/** True when at least one rate is configured — used to explain an empty cost column. */
export function hasAnyRateConfigured(): boolean {
  return Object.keys(loadRates()).length > 0;
}
