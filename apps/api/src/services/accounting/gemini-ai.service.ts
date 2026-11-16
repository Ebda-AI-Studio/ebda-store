/**
 * Shared Gemini AI client for the accounting smart layer (Batch 3).
 *
 * Responsibilities:
 *   - callGemini<T>      — single JSON-mode call, optional vision (base64 image)
 *   - callGeminiBatch<T> — chunked + throttled batch, respects Store.aiBulkThrottleMs
 *
 * Quota / usage:
 *   - assertAiQuota() from lib/ai-quota.ts is called before every non-cached request.
 *   - Token counts are recorded through ai.service.ts's `recordUsage` (the one
 *     writer of ai_usage), so the daily/monthly caps stay consistent AND each
 *     row carries model + cost like every other AI call (#1037).
 *
 * Design:
 *   - Reuses the same singleton GoogleGenerativeAI client strategy as ai.service.ts
 *     but keyed separately so the two clients don't share module-private state.
 *   - JSON-mode (responseMimeType: 'application/json') + stripJsonFences() guard
 *     matches the established pattern — Gemini occasionally wraps JSON in code fences
 *     even when responseMimeType is set.
 *   - Vision: accepts optional imageBase64 + imageMimeType; parts order is prompt first
 *     so the text instruction anchors the model before the image data.
 *   - Error classification uses the shared rethrowAsAppError from lib/ai/gemini-errors.ts
 *     (2026-07-05 — was a duplicated local copy).
 */

import { GeminiFailoverClient } from '../../lib/ai/gemini-keys';
import { assertAiQuota } from '../../lib/ai-quota';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';
import { rethrowAsAppError } from '../../lib/ai/gemini-errors';
import { recordUsage, type AccountingAiFeature } from '../ai.service';

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';

let _client: GeminiFailoverClient | null = null;

function getClient(): GeminiFailoverClient {
  // Accept GEMINI_API_KEY as a fallback so a prod deploy that set the shorter
  // var name still works without a reconfig (trap: silent 503 if neither is set).
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'GOOGLE_GENERATIVE_AI_KEY is not set.');
  }
  if (!_client) _client = new GeminiFailoverClient();
  return _client;
}

// ---------------------------------------------------------------------------
// Internal helpers (mirrors ai.service.ts pattern, kept module-private)
// ---------------------------------------------------------------------------

/** Strip Markdown code fences Gemini sometimes emits even in JSON mode. */
function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallGeminiOpts {
  /** Full prompt text (system + user combined, or just user if you prefer). */
  prompt: string;
  /** Feature label written to AiUsage. */
  feature: AccountingAiFeature;
  /** storeId for quota attribution + AiUsage row. */
  storeId: string;
  /** Optional base64-encoded image bytes for vision calls. */
  imageBase64?: string;
  /** MIME type of the image, e.g. 'image/jpeg'. Required when imageBase64 is set. */
  imageMimeType?: string;
}

export interface CallGeminiBatchOpts<TItem> {
  /** Array of items to process. */
  items: TItem[];
  /**
   * Called per item to produce the prompt text.
   * The service batches these into chunks and calls Gemini once per chunk.
   * For simplicity each item gets its own call — callers that need multi-item
   * responses should compose a multi-item prompt inside perItemPrompt and
   * return an array from the parser.
   */
  perItemPrompt: (item: TItem) => string;
  /** Feature label for AiUsage. */
  feature: AccountingAiFeature;
  /** storeId for quota attribution. */
  storeId: string;
  /**
   * Milliseconds to wait between calls. Defaults to 2500 (Gemini free-tier
   * ~30 RPM = 2s min gap; 2.5s is the established Ebda default).
   * Pass `Store.aiBulkThrottleMs` here for per-store tuning.
   */
  throttleMs?: number;
}

// ---------------------------------------------------------------------------
// callGemini — single call, returns parsed T
// ---------------------------------------------------------------------------

/**
 * Make a single Gemini JSON-mode call. Returns parsed T.
 *
 * Quota is checked via assertAiQuota() before the call.
 * Token usage is written to AiUsage after the call.
 *
 * Vision: supply imageBase64 + imageMimeType to attach an inline image.
 *
 * @throws AppError on missing API key, quota exceeded, API error, or malformed JSON.
 */
export async function callGemini<T>(opts: CallGeminiOpts): Promise<T> {
  const aiSlot = await assertAiQuota({ storeId: opts.storeId });
  try {
    const model = getClient().getGenerativeModel({
      model: MODEL,
      generationConfig: { responseMimeType: 'application/json' },
    });

    // Build parts: prompt text first so the instruction anchors the model
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: opts.prompt },
    ];
    if (opts.imageBase64 && opts.imageMimeType) {
      parts.push({ inlineData: { mimeType: opts.imageMimeType, data: opts.imageBase64 } });
    }

    let result;
    try {
      result = await model.generateContent({
        contents: [{ role: 'user', parts }],
      });
    } catch (err) {
      rethrowAsAppError(err, `callGemini(${opts.feature}) failed`);
    }

    const raw = stripJsonFences(result.response.text());
    const usage = result.response.usageMetadata;
    // The central writer (ai.service.ts) — not a local copy — so the row
    // carries `model` and `costMicros` and accounting AI spend is counted in
    // the per-store AI cost reporting (#1037). MODEL is passed explicitly: this
    // module resolves GEMINI_MODEL itself and may not match the central default.
    await recordUsage(
      opts.storeId,
      opts.feature,
      usage?.promptTokenCount ?? 0,
      usage?.candidatesTokenCount ?? 0,
      false,
      { model: MODEL }
    );

    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.error(
        { err, raw, storeId: opts.storeId, feature: opts.feature },
        'callGemini: malformed JSON'
      );
      throw new AppError(
        502,
        'AI_BAD_RESPONSE',
        `Gemini returned malformed JSON for feature "${opts.feature}".`
      );
    }
  } finally {
    await aiSlot?.release(); // `?.`: test doubles of assertAiQuota resolve to undefined
  }
}

// ---------------------------------------------------------------------------
// callGeminiBatch — chunked + throttled, returns T[] matching items[]
// ---------------------------------------------------------------------------

/**
 * Process an array of items through Gemini, one call per item with throttle
 * pauses between calls to respect free-tier rate limits.
 *
 * Failed items are returned as null in the result array — callers should
 * handle nulls (typically: skip or mark as failed, continue the scan).
 *
 * Token usage is recorded per successful call. assertAiQuota() is called
 * before EACH call so a mid-batch quota hit stops the sweep cleanly.
 *
 * @param opts.throttleMs — milliseconds to sleep between calls (default 2500)
 */
export async function callGeminiBatch<TItem, TResult>(
  opts: CallGeminiBatchOpts<TItem>
): Promise<Array<TResult | null>> {
  const throttleMs = opts.throttleMs ?? 2500;
  const results: Array<TResult | null> = [];

  for (let i = 0; i < opts.items.length; i++) {
    if (i > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, throttleMs));
    }

    const item = opts.items[i];
    const prompt = opts.perItemPrompt(item);

    try {
      const parsed = await callGemini<TResult>({
        prompt,
        feature: opts.feature,
        storeId: opts.storeId,
      });
      results.push(parsed);
    } catch (err) {
      // Quota cap errors should abort the entire batch (let it bubble)
      if (err instanceof AppError && err.code.startsWith('AI_QUOTA')) {
        throw err;
      }
      // All other errors: log + push null so the scan continues
      logger.warn(
        { err, storeId: opts.storeId, feature: opts.feature, itemIndex: i },
        'callGeminiBatch: item failed, skipping'
      );
      results.push(null);
    }
  }

  return results;
}
