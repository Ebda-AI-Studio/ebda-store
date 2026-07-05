import logger from '../logger';
import { AppError } from '../../middleware/error-handler';

/**
 * Translate Google Generative AI SDK errors into AppError so the
 * Express error handler (and every bulk-AI sweep's error persistence)
 * surfaces a clean, useful message instead of the raw provider error
 * text. Every direct GoogleGenerativeAI caller in the codebase MUST
 * route its `model.generateContent(...)` errors through this function
 * — raw SDK error messages (which can include upstream URLs, quota
 * metric ids, etc.) must never reach a merchant-facing surface.
 *
 * Extracted from ai.service.ts (2026-07-05) — this was duplicated in
 * accounting/gemini-ai.service.ts; both now import from here so the
 * surfaced message is consistent everywhere a Gemini call happens.
 *
 * Passes an existing AppError straight through unchanged — callers
 * that wrap a `callWithRetry(...)` result may already receive one of
 * our own AppErrors (e.g. the daily-quota-exhaustion abort thrown by
 * `callWithRetry` itself), and re-wrapping it here would downgrade a
 * well-classified quota error into a generic upstream error.
 */
export function rethrowAsAppError(err: unknown, fallback: string): never {
  if (err instanceof AppError) throw err;

  const e = err as { status?: number; message?: string };
  if (e?.status === 429) {
    throw new AppError(
      429,
      'AI_QUOTA_EXCEEDED',
      'AI quota reached for this minute or day. Try again shortly, or contact support to raise the limit.'
    );
  }
  if (e?.status === 401 || e?.status === 403) {
    throw new AppError(
      503,
      'AI_NOT_CONFIGURED',
      'AI features are misconfigured on this server (auth failed). Contact support.'
    );
  }
  if (e?.status === 400) {
    throw new AppError(
      502,
      'AI_BAD_REQUEST',
      e.message?.slice(0, 240) || 'AI rejected the request shape.'
    );
  }
  logger.error({ err }, fallback);
  throw new AppError(502, 'AI_UPSTREAM_ERROR', fallback);
}
