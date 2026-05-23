/**
 * Shared Gemini AI client for the accounting smart layer (Batch 3).
 *
 * Responsibilities:
 *   - callGemini<T>      — single JSON-mode call, optional vision (base64 image)
 *   - callGeminiBatch<T> — chunked + throttled batch, respects Store.aiBulkThrottleMs
 *
 * Quota / usage:
 *   - assertAiQuota() from lib/ai-quota.ts is called before every non-cached request.
 *   - Token counts are written to AiUsage (same table as ai.service.ts) so the
 *     global daily/monthly cap tracking stays consistent.
 *
 * Design:
 *   - Reuses the same singleton GoogleGenerativeAI client strategy as ai.service.ts
 *     but keyed separately so the two clients don't share module-private state.
 *   - JSON-mode (responseMimeType: 'application/json') + stripJsonFences() guard
 *     matches the established pattern — Gemini occasionally wraps JSON in code fences
 *     even when responseMimeType is set.
 *   - Vision: accepts optional imageBase64 + imageMimeType; parts order is prompt first
 *     so the text instruction anchors the model before the image data.
 *   - Error classification mirrors rethrowAsAppError in ai.service.ts.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { prisma } from '@force/database';
import { assertAiQuota } from '../../lib/ai-quota';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';

let _client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_KEY;
  if (!apiKey) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'GOOGLE_GENERATIVE_AI_KEY is not set.');
  }
  if (!_client) _client = new GoogleGenerativeAI(apiKey);
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

/** Map SDK errors → AppError so Express errorHandler produces useful HTTP status. */
function rethrowAsAppError(err: unknown, fallback: string): never {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429) {
    throw new AppError(
      429,
      'AI_QUOTA_EXCEEDED',
      'AI quota reached for this minute or day. Try again shortly.'
    );
  }
  if (e?.status === 401 || e?.status === 403) {
    throw new AppError(
      503,
      'AI_NOT_CONFIGURED',
      'AI auth failed — check GOOGLE_GENERATIVE_AI_KEY.'
    );
  }
  if (e?.status === 400) {
    throw new AppError(
      502,
      'AI_BAD_REQUEST',
      e.message?.slice(0, 240) ?? 'AI rejected the request shape.'
    );
  }
  logger.error({ err }, fallback);
  throw new AppError(502, 'AI_UPSTREAM_ERROR', fallback);
}

/** Record token usage in AiUsage. Never throws — a logging failure must not surface to callers. */
async function recordUsage(
  storeId: string,
  feature: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  try {
    await prisma.aiUsage.create({
      data: { storeId, feature, inputTokens, outputTokens, cachedHit: false },
    });
  } catch (err) {
    logger.warn({ err, storeId, feature }, 'gemini-ai.service: failed to record AI usage');
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallGeminiOpts {
  /** Full prompt text (system + user combined, or just user if you prefer). */
  prompt: string;
  /** Feature label written to AiUsage. e.g. 'reorder-scan' | 'deadstock-scan' | 'expense-ocr' */
  feature: string;
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
  feature: string;
  /** storeId for quota attribution. */
  storeId: string;
  /**
   * Milliseconds to wait between calls. Defaults to 2500 (Gemini free-tier
   * ~30 RPM = 2s min gap; 2.5s is the established FWB default).
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
  await assertAiQuota();

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
  await recordUsage(
    opts.storeId,
    opts.feature,
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0
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
