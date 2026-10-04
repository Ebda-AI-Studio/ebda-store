/**
 * AI-output evaluation runner — deterministic layer (always) + model-as-
 * judge layer (when a Gemini API key is available).
 *
 * `runDeterministicChecks()` is the pure, offline half — used directly by
 * the vitest unit suite (tests/unit/ai-eval-*.test.ts), which runs on
 * every push with ZERO network calls.
 *
 * `judgeOutput()` additionally calls Gemini once per (input, output) pair
 * to score every model-judge dimension registered for that type in a
 * single structured-JSON call, then merges both layers into one
 * `EvalResult`. This is the manual/nightly layer — see
 * `tests/ai-eval/live.eval.ts` and `npm run ai:eval`. It degrades
 * gracefully (skips the model layer, keeps the deterministic result) when
 * no API key is configured or the judge response fails to parse.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../../config';
import logger from '../../logger';
import { parseAiJson } from '../parse-ai-json';
import { getCriteria } from './criteria';
import type {
  AiOutputType,
  CheckResult,
  DeterministicCheckResult,
  EvalResult,
  ModelJudgeDimension,
  ModelJudgeScore,
} from './types';

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const JUDGE_PASS_THRESHOLD = 60;

/** Run only the deterministic checks for `type` against (input, output). Offline, no network. */
export function runDeterministicChecks<TInput, TOutput>(
  type: AiOutputType,
  input: TInput,
  output: TOutput
): DeterministicCheckResult[] {
  const spec = getCriteria(type);
  return spec.deterministic.map(
    (check: { name: string; run: (i: TInput, o: TOutput) => CheckResult }) => {
      try {
        const result = check.run(input, output);
        return { name: check.name, pass: result.pass, reason: result.reason };
      } catch (err) {
        // A throwing check (e.g. accessing a field on a malformed/missing
        // output) is itself a FAILED check, not a harness crash — the whole
        // point of this layer is to catch malformed AI output.
        return {
          name: check.name,
          pass: false,
          reason: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  );
}

function buildJudgePrompt(
  type: AiOutputType,
  description: string,
  dimensions: ModelJudgeDimension[],
  input: unknown,
  output: unknown
): string {
  const dimLines = dimensions.map(d => `- "${d.name}": ${d.instruction}`).join('\n');
  const shape = dimensions.reduce<Record<string, string>>((acc, d) => {
    acc[d.name] = '{ "score": 0-100, "pass": true|false, "reason": "one concise sentence" }';
    return acc;
  }, {});

  return `You are a strict, skeptical QA judge evaluating AI-generated e-commerce content for an Egypt-based store-builder platform. Your job is to catch REAL defects — hallucinated facts, duplicated content, irrelevant output, tone mismatches. Do not be lenient; a plausible-sounding but ungrounded claim is still a failure.

CONTENT TYPE: ${type} — ${description}

INPUT GIVEN TO THE GENERATOR (the ONLY source of truth — anything in the output not traceable to this input, or to generic always-safe policy, counts as a hallucination):
${JSON.stringify(input, null, 2)}

GENERATED OUTPUT TO EVALUATE:
${JSON.stringify(output, null, 2)}

Score the output on EACH of the following dimensions:
${dimLines}

Rules:
- "score" is 0-100. "pass" must be true only when score >= ${JUDGE_PASS_THRESHOLD}.
- Be specific in "reason" — name the exact invented fact / duplicated phrase / irrelevant item when failing a dimension.

Return ONLY valid JSON, no markdown fences, no explanation, matching exactly this shape:
{
${dimensions.map(d => `  "${d.name}": ${shape[d.name]}`).join(',\n')}
}`;
}

interface JudgeModelResponse {
  [dimension: string]: { score?: number; pass?: boolean; reason?: string };
}

/**
 * Evaluate one (input, output) pair for `type`: always runs the
 * deterministic checks; runs the model-judge dimensions via Gemini when
 * `apiKey` (or `config.googleAiKey`) is available and the type has any
 * registered. Never throws — a judge-call failure degrades to
 * `skippedModelJudge: true` with the deterministic result intact.
 */
export async function judgeOutput<TInput, TOutput>(params: {
  type: AiOutputType;
  input: TInput;
  output: TOutput;
  apiKey?: string;
  modelName?: string;
}): Promise<EvalResult> {
  const { type, input, output } = params;
  const spec = getCriteria(type);
  const deterministic = runDeterministicChecks(type, input, output);

  const apiKey = params.apiKey ?? config.googleAiKey;
  const modelName = params.modelName ?? DEFAULT_MODEL;

  if (spec.modelJudgeDimensions.length === 0) {
    return finalize(
      type,
      deterministic,
      null,
      true,
      'type has no model-judge dimensions registered'
    );
  }
  if (!apiKey) {
    return finalize(
      type,
      deterministic,
      null,
      true,
      'no GOOGLE_GENERATIVE_AI_KEY / GEMINI_API_KEY configured'
    );
  }

  try {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json' },
    });
    const prompt = buildJudgePrompt(
      type,
      spec.description,
      spec.modelJudgeDimensions,
      input,
      output
    );
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    const parsed = parseAiJson<JudgeModelResponse>(raw);

    const modelJudge: ModelJudgeScore[] = spec.modelJudgeDimensions.map(dim => {
      const entry = parsed?.[dim.name];
      const score = typeof entry?.score === 'number' ? entry.score : 0;
      return {
        name: dim.name,
        score,
        pass: entry?.pass === true && score >= JUDGE_PASS_THRESHOLD,
        reason: entry?.reason ?? 'judge response missing this dimension',
      };
    });

    return finalize(type, deterministic, modelJudge, false);
  } catch (err) {
    // Log only the message, never the raw SDK error object — a Gemini request
    // error can carry the request URL (with the API key) in its serialized form.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), type },
      '[ai-eval] model-judge call failed, degrading to deterministic-only'
    );
    return finalize(
      type,
      deterministic,
      null,
      true,
      `judge call failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function finalize(
  type: AiOutputType,
  deterministic: DeterministicCheckResult[],
  modelJudge: ModelJudgeScore[] | null,
  skippedModelJudge: boolean,
  skipReason?: string
): EvalResult {
  const failedChecks = [
    ...deterministic.filter(c => !c.pass).map(c => c.name),
    ...(modelJudge ?? []).filter(c => !c.pass).map(c => c.name),
  ];
  const passed = deterministic.every(c => c.pass) && (modelJudge ?? []).every(c => c.pass);
  return {
    type,
    passed,
    deterministic,
    modelJudge,
    failedChecks,
    skippedModelJudge,
    ...(skipReason ? { skipReason } : {}),
  };
}
