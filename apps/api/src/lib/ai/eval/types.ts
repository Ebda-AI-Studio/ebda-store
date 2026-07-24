/**
 * AI-output evaluation harness — shared types.
 *
 * Every distinct AI generation path in FWB (product FAQs, excerpts, alt
 * text, category/tag suggestions, translation, SEO meta, section copy,
 * description balancing, logo palette extraction, AEO/GEO content sweeps,
 * product recommendations, and review tools) gets an entry in
 * `criteria.ts` keyed by `AiOutputType`. Each entry pairs:
 *
 *   - DETERMINISTIC checks — pure functions, no model call, always run,
 *     always fast, always free. These are the CI-gate layer.
 *   - MODEL-AS-JUDGE dimensions — a Gemini call scores the output against
 *     named criteria (grounding, no-duplication, relevance, tone). These
 *     are the manual/nightly layer (costs quota, non-deterministic).
 *
 * See `judge.ts` for the runner that executes both layers, and
 * `criteria.ts` for the per-type registry.
 */

export type AiOutputType =
  | 'product-faq'
  | 'product-excerpt'
  | 'product-alt-text'
  | 'product-category-suggestion'
  | 'product-tags'
  | 'translation'
  | 'seo-meta'
  | 'section-copy'
  | 'description-balance'
  | 'logo-palette'
  | 'store-faq'
  | 'howto-guide'
  | 'meta-aeo'
  | 'llms-txt'
  | 'citation-copy'
  | 'brand-facts'
  | 'product-recommendations'
  | 'review-translation'
  | 'review-spam-detection'
  | 'review-summary'
  | 'review-owner-response'
  | 'expense-ocr';

/** Result of a single check (deterministic or model-judge). */
export interface CheckResult {
  pass: boolean;
  reason: string;
}

/** A single named model-judge score, as returned by the judge model. */
export interface ModelJudgeScore extends CheckResult {
  name: string;
  score: number; // 0-100
}

/** A single named deterministic check result. */
export interface DeterministicCheckResult extends CheckResult {
  name: string;
}

/**
 * A pure, offline check. Runs on the (input, output) pair with NO network
 * call. Every deterministic check across every type must be safe to run
 * in CI on every push — no Gemini, no DB, no fetch.
 */
export interface DeterministicCheck<TInput = unknown, TOutput = unknown> {
  name: string;
  run: (input: TInput, output: TOutput) => CheckResult;
}

/**
 * A named dimension the judge model is asked to score. `instruction` is
 * spliced into the judge prompt verbatim — keep it a single clear sentence
 * telling the model exactly what a FAIL looks like.
 */
export interface ModelJudgeDimension {
  name: string;
  instruction: string;
}

/** The full criteria spec for one AI output type. */
export interface CriteriaSpec<TInput = unknown, TOutput = unknown> {
  type: AiOutputType;
  /** Short description shown in reports / judge prompts. */
  description: string;
  deterministic: DeterministicCheck<TInput, TOutput>[];
  /** Empty array = this type has no model-judge layer (e.g. logo-palette). */
  modelJudgeDimensions: ModelJudgeDimension[];
}

/** Aggregate result of evaluating one (input, output) pair. */
export interface EvalResult {
  type: AiOutputType;
  /** True only when every deterministic check AND every model-judge dimension (if run) passed. */
  passed: boolean;
  deterministic: DeterministicCheckResult[];
  /** null when the model-judge layer was skipped (no API key / parse failure). */
  modelJudge: ModelJudgeScore[] | null;
  /** Names of every failed check, deterministic + model-judge combined. */
  failedChecks: string[];
  skippedModelJudge: boolean;
  skipReason?: string;
}
