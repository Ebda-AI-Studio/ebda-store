/**
 * Gemini answer-engine provider — the free/active default for the AEO/GEO
 * "answer engine insights" feature. Asks Gemini a representative shopper
 * prompt and reports which URLs it cited (if grounded web search worked).
 *
 * GROUNDING, LIVE-VERIFIED (2026-09-26, issue #929 — was P2 "unverified"):
 * `@google/generative-ai@0.24.1`'s only grounding tool shape is the legacy
 * `{ googleSearchRetrieval: {} }` (Gemini 1.x-era grounding). Measured live
 * against the production key, every 2.x-family model now REJECTS that shape
 * with HTTP 400 ("google_search_retrieval is not supported. Please use
 * google_search tool instead.") — so the grounded signal had never actually
 * fired; every check silently degraded to `grounded: false`.
 *
 * `{ google_search: {} }` (the current tool name) returned HTTP 200 with
 * `candidates[0].groundingMetadata.groundingChunks[].web.uri` populated (4
 * web chunks) on `gemini-2.5-flash-lite` — and it's FREE on the current key.
 * The SAME tool on `gemini-flash-lite-latest` / `gemini-flash-latest` /
 * `gemini-3.5-flash-lite` returned HTTP 429 ("exceeded your current quota")
 * — grounding is paid-only on those aliases — and `gemini-2.5-flash`
 * returned 404 (retired for new users). Per owner decision (free option),
 * this adapter defaults to the verified-free model rather than a paid one.
 *
 * SDK CHOICE — plain `fetch`, not a new SDK dependency: `@google/genai` (the
 * maintained SDK that exposes `googleSearch: {}`) would fix this too, but
 * pulling in a whole new SDK for one provider's one tool shape means a
 * lockfile regen + dependency-discipline pass (registry/license/audit) for
 * a call this codebase already makes without an SDK elsewhere — the sibling
 * `perplexity.provider.ts` / `openai.provider.ts` adapters in this same
 * directory both call their provider's REST API directly with `fetch`, no
 * SDK, specifically "per the task constraint" (see their headers). Calling
 * Gemini's `v1beta/models/{model}:generateContent` REST endpoint the same
 * way is the smaller, safer, more consistent change: zero new dependencies,
 * zero lockfile/audit surface, one less SDK version to track for drift.
 *
 * FALLBACK CONTRACT: a versioned/aliased model can be retired or rationed
 * without notice (see the 429/404 cases above) — this must never take down
 * the whole citation scan or silently misreport groundedness. If the
 * grounded call returns HTTP 400/404/429, this adapter retries ONCE with NO
 * tools (an ordinary ungrounded call on the same model) instead of failing
 * the scan or pretending it grounded. The result is `grounded: false` +
 * `groundingUnavailableReason: 'http_<status>'` — a distinct, persisted
 * signal from a plain `grounded: false` (which also covers "grounding ran
 * fine but cited nothing"), so the dashboard can show "search grounding
 * unavailable" instead of the generic "no live citations" caveat. A warning
 * is logged at most ONCE PER STORE SCAN for this condition — a single
 * citation scan queries every enabled prompt (~8) against Gemini, and a
 * retired model/tripped quota fails identically on every one of them, so
 * per-query logging would spam 8 near-duplicate warnings for one root cause.
 * The weekly cron resets the throttle per store (`scanStoreCitations`) and
 * raises a P1 alert when any check in a run was ungrounded (issue 2119).
 *
 * Any OTHER non-2xx response (5xx, auth failure, malformed request, etc.)
 * is a real error and throws — `citation-scan.service.ts`'s per-engine
 * fail-soft catch already treats a throw as `provider_error` and skips only
 * this engine's remaining prompts for this store, same as before.
 */
import { config } from '../../config';
import { AppError } from '../../middleware/error-handler';
import { assertAiQuota } from '../../lib/ai-quota';
import { recordUsage } from '../ai.service';
import logger from '../../lib/logger';
import { isGeminiQuotaError, withGeminiFailover } from '../../lib/ai/gemini-keys';
import type { AnswerEngineProvider, EngineAnswer } from './provider';
import { timedFetch } from '../../lib/fetch-with-timeout';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Free, live-verified grounding model (2026-09-26) — see file header. The
// `-latest` aliases ration grounding behind a paid quota and `gemini-2.5-flash`
// is retired for new users on the current key; override via
// ANSWER_ENGINE_GEMINI_MODEL if this model is ever retired in turn.
const MODEL = process.env.ANSWER_ENGINE_GEMINI_MODEL || 'gemini-2.5-flash-lite';

// HTTP statuses that mean "this model/key combination can't ground right
// now" (retired alias, rejected tool shape, or exhausted quota) rather than
// a hard outage — see file header. Only ever checked on the GROUNDED call;
// the ungrounded fallback call re-using the same status would otherwise
// loop forever trying to "fall back" from an already-ungrounded call.
const GROUNDING_UNAVAILABLE_STATUSES = new Set([400, 404, 429]);

// Module-level flag: see the FALLBACK CONTRACT note above for why this is
// throttled rather than logged per query. Reset at every store-scan
// boundary by `scanStoreCitations` (answer-engine-citation-scan.ts).
let hasWarnedGroundingUnavailable = false;
export function resetGeminiGroundingWarnOnce(): void {
  hasWarnedGroundingUnavailable = false;
}

type GeminiRestCandidate = {
  content?: { parts?: Array<{ text?: string }> };
  groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
};

type GeminiRestResponse = {
  candidates?: GeminiRestCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};

type GeminiCallResult =
  | { ok: true; body: GeminiRestResponse }
  | { ok: false; status: number; errorMessage?: string };

/** Untrusted third-party response — every accessor is defensive by design,
 * same spirit as `detectCitation` in `provider.ts`. */
function extractText(response: GeminiRestResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('');
}

function extractCitedUrls(response: GeminiRestResponse): string[] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return chunks
    .map(chunk => chunk?.web?.uri)
    .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);
}

export class GeminiAnswerEngineProvider implements AnswerEngineProvider {
  readonly engine = 'gemini';
  // The model actually called, recorded as usage provenance (#1038).
  readonly modelId = MODEL;

  async query(storeId: string, prompt: string): Promise<EngineAnswer> {
    await assertAiQuota({ storeId });

    if (!config.googleAiKey) {
      throw new AppError(
        503,
        'AI_NOT_CONFIGURED',
        'AI features are not configured on this server.'
      );
    }

    let response: GeminiRestResponse;
    let grounded: boolean;
    let groundingUnavailableReason: string | undefined;

    const groundedCall = await this.callGemini(prompt, [{ google_search: {} }]);

    if (groundedCall.ok) {
      response = groundedCall.body;
      grounded = response.candidates?.[0]?.groundingMetadata !== undefined;
    } else if (GROUNDING_UNAVAILABLE_STATUSES.has(groundedCall.status)) {
      if (!hasWarnedGroundingUnavailable) {
        hasWarnedGroundingUnavailable = true;
        logger.warn(
          { status: groundedCall.status, model: MODEL, message: groundedCall.errorMessage },
          'answer-engine gemini: search grounding unavailable on this model/key (retired ' +
            'alias, rejected tool shape, or quota) — falling back to an ungrounded call for ' +
            'the rest of this scan'
        );
      }
      groundingUnavailableReason = `http_${groundedCall.status}`;

      const fallback = await this.callGemini(prompt, []);
      if (!fallback.ok) {
        throw new AppError(
          502,
          'GEMINI_API_ERROR',
          fallback.errorMessage ?? `Gemini API returned HTTP ${fallback.status}`
        );
      }
      response = fallback.body;
      grounded = false;
    } else {
      throw new AppError(
        502,
        'GEMINI_API_ERROR',
        groundedCall.errorMessage ?? `Gemini API returned HTTP ${groundedCall.status}`
      );
    }

    const text = extractText(response);
    const citedUrls = grounded ? extractCitedUrls(response) : [];

    const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const candidateTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    // Provenance is the model actually invoked: ANSWER_ENGINE_GEMINI_MODEL may
    // differ from GEMINI_MODEL, which recordUsage would otherwise assume (#1038).
    await recordUsage(storeId, 'answer_engine_gemini', promptTokens, candidateTokens, false, {
      model: MODEL,
    });

    return {
      text,
      citedUrls,
      grounded,
      ...(groundingUnavailableReason ? { groundingUnavailableReason } : {}),
      raw: response,
    };
  }

  private async callGemini(
    prompt: string,
    tools: Record<string, unknown>[]
  ): Promise<GeminiCallResult> {
    // Key failover (RULINGS GEMINI-FAILOVER-1): a 429 on one key retries with the next.
    // Search grounding has its own quota, so a grounded call benches only the 'grounding'
    // scope: its 429 never stops the ungrounded fallback in query() (Ruling B0-51).
    let res: Response;
    try {
      res = await withGeminiFailover(
        async apiKey => {
          const r = await timedFetch('gemini.generate', 'ai')(
            `${GEMINI_API_BASE}/${MODEL}:generateContent`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
              },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                ...(tools.length ? { tools } : {}),
              }),
            }
          );
          if (r.status === 429) {
            const ra = Number(r.headers.get('retry-after'));
            throw Object.assign(new Error('RESOURCE_EXHAUSTED'), {
              status: 429,
              retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? ra : undefined,
              response: r,
            });
          }
          return r;
        },
        config.googleAiKey,
        tools.length ? { benchScope: 'grounding' } : undefined
      );
    } catch (err) {
      if (!isGeminiQuotaError(err)) throw err;
      const r = (err as { response?: Response }).response;
      if (!r) return { ok: false, status: 429, errorMessage: 'all Gemini keys rate limited' };
      res = r;
    }

    const json = (await res.json().catch(() => ({}))) as GeminiRestResponse;

    if (!res.ok) {
      return { ok: false, status: res.status, errorMessage: json?.error?.message };
    }
    return { ok: true, body: json };
  }
}
