/**
 * AI cost-gate logic (fleet AI-CI/CD standard, Addition 2 — foundation PR #57).
 *
 * "A prompt change that doubles the context window should not sneak into
 * production." Estimates $/day per AI feature from the feature's REAL prompt
 * builder (see features.ts) x a pinned price table x expected daily calls, and
 * gates on (a) any feature rising > maxDeltaPct vs the committed baseline, or
 * (b) total exceeding an absolute ceiling. The gate is enforced by the unit
 * test (ai-cost-gate.test.ts) so it runs in the existing CI unit job — no new
 * workflow, no live API call.
 *
 * Token counting is the char/4 heuristic (deterministic, offline). It doesn't
 * need to be exact — it needs to be STABLE, so a real prompt-size change moves
 * the number enough to trip the gate.
 */

export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  inPerM: number;
  /** USD per 1,000,000 output tokens. */
  outPerM: number;
}

/** Pinned price table. Update when Google changes Gemini pricing. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Gemini Flash Lite — Ebda's default AI model (gemini-flash-lite-latest).
  'gemini-flash-lite-latest': { inPerM: 0.1, outPerM: 0.4 },
};

export interface FeatureCostInput {
  feature: string;
  model: string;
  /** Assembled prompt from the feature's REAL builder — measured for input tokens. */
  prompt: string;
  /** Expected output tokens per call (rough, from goldens/observation). */
  outputTokensEst: number;
  /** Expected calls/day for $/day weighting. */
  callsPerDay: number;
}

export interface FeatureCost {
  feature: string;
  usdPerDay: number;
}

/** ~4 chars/token heuristic — stable, offline, no tokenizer dependency. */
export const countTokens = (t: string): number => Math.ceil((t?.length ?? 0) / 4);

export function estimateFeatureCost(f: FeatureCostInput, prices = MODEL_PRICES): FeatureCost {
  const price = prices[f.model];
  if (!price) throw new Error(`cost: no price for model "${f.model}" — add it to MODEL_PRICES`);
  const inputTokens = countTokens(f.prompt);
  const perCallUsd =
    (inputTokens / 1e6) * price.inPerM + (Math.max(0, f.outputTokensEst) / 1e6) * price.outPerM;
  return { feature: f.feature, usdPerDay: perCallUsd * Math.max(0, f.callsPerDay) };
}

export interface CostBudget {
  /** Fail if any feature's $/day rises more than this fraction vs baseline (e.g. 0.25 = 25%). */
  maxDeltaPct: number;
  /** Fail if total $/day exceeds this absolute ceiling. */
  maxTotalUsdPerDay: number;
}

export interface GateViolation {
  feature: string;
  message: string;
}

export interface GateResult {
  ok: boolean;
  costs: FeatureCost[];
  totalUsdPerDay: number;
  violations: GateViolation[];
}

/**
 * Compare current estimates against the committed baseline (feature -> $/day).
 * A NEW feature (absent from baseline) never trips the delta rule but counts
 * toward the total. A legitimate increase is resolved by regenerating the
 * baseline in the same PR (visible in the diff, like a snapshot test).
 */
export function evaluateCostGate(
  features: FeatureCostInput[],
  baseline: Record<string, number>,
  budget: CostBudget,
  prices = MODEL_PRICES
): GateResult {
  const costs = features.map(f => estimateFeatureCost(f, prices));
  const violations: GateViolation[] = [];
  let total = 0;
  for (const c of costs) {
    total += c.usdPerDay;
    const base = baseline[c.feature];
    if (base != null && base > 0) {
      const delta = (c.usdPerDay - base) / base;
      if (delta > budget.maxDeltaPct) {
        violations.push({
          feature: c.feature,
          message: `${c.feature}: $${c.usdPerDay.toFixed(5)}/day is +${(delta * 100).toFixed(1)}% vs baseline $${base.toFixed(5)} (max +${(budget.maxDeltaPct * 100).toFixed(0)}%). If intentional, regenerate cost-baseline.json.`,
        });
      }
    }
  }
  if (total > budget.maxTotalUsdPerDay) {
    violations.push({
      feature: '(total)',
      message: `total $${total.toFixed(5)}/day exceeds budget $${budget.maxTotalUsdPerDay.toFixed(5)}`,
    });
  }
  return { ok: violations.length === 0, costs, totalUsdPerDay: total, violations };
}
