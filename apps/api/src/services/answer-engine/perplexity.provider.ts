/**
 * Perplexity (Sonar) answer-engine provider (AEO/GEO insights feature) —
 * DORMANT until an admin enables it and sets an API key (Task 5 builds
 * that write path; this adapter just needs to work once keyed).
 *
 * Perplexity's Sonar models are search-grounded by design: every
 * successful `chat/completions` call performs live web retrieval and
 * returns the retrieved URLs in a top-level `citations` array, so a
 * successfully-parsed response is always `grounded: true` — there is no
 * per-response signal (unlike Gemini) that grounding was skipped.
 *
 * API shape targeted (Perplexity `chat/completions`, current as of
 * 2026-07 — no SDK, plain `fetch`, per the task constraint):
 *   POST https://api.perplexity.ai/chat/completions
 *   Request:  { model, messages: [{ role: 'user', content: prompt }] }
 *   Response: {
 *     citations: string[],
 *     choices: [{ message: { role: 'assistant', content: string } }]
 *   }
 *
 * Untrusted input: the response is a third-party API and must never
 * crash this adapter — network errors, non-2xx responses, and malformed
 * JSON/shape all degrade to a safe empty/ungrounded EngineAnswer rather
 * than throwing.
 *
 * The API key is a DECRYPTED constructor argument (never read from a
 * global/env here) so the adapter stays unit-testable and the registry
 * remains the single owner of decryption.
 */
import logger from '../../lib/logger';
import type { AnswerEngineProvider, EngineAnswer } from './provider';
import { timedFetch } from '../../lib/fetch-with-timeout';

const ENDPOINT = 'https://api.perplexity.ai/chat/completions';
const MODEL = process.env.ANSWER_ENGINE_PERPLEXITY_MODEL || 'sonar';

const EMPTY_ANSWER: EngineAnswer = { text: '', citedUrls: [], grounded: false };

export class PerplexityAnswerEngineProvider implements AnswerEngineProvider {
  readonly engine = 'perplexity';
  readonly modelId = MODEL;

  constructor(private readonly apiKey: string) {}

  async query(_storeId: string, prompt: string): Promise<EngineAnswer> {
    let res: Response;
    try {
      res = await timedFetch('perplexity.answer', 'ai')(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (err) {
      logger.error({ err }, 'Perplexity answer-engine request failed');
      return { ...EMPTY_ANSWER };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body: bodyText },
        'Perplexity answer-engine returned a non-OK response'
      );
      return { ...EMPTY_ANSWER };
    }

    try {
      const data: unknown = await res.json();
      return parsePerplexityResponse(data);
    } catch (err) {
      logger.error({ err }, 'Failed to parse Perplexity answer-engine response');
      return { ...EMPTY_ANSWER };
    }
  }
}

function parsePerplexityResponse(data: unknown): EngineAnswer {
  if (!data || typeof data !== 'object') return { ...EMPTY_ANSWER };

  const choices = Array.isArray((data as { choices?: unknown }).choices)
    ? (data as { choices: unknown[] }).choices
    : [];
  const firstChoice = choices[0] as { message?: { content?: unknown } } | undefined;
  const text = typeof firstChoice?.message?.content === 'string' ? firstChoice.message.content : '';

  const rawCitations = (data as { citations?: unknown }).citations;
  const citedUrls = Array.isArray(rawCitations)
    ? rawCitations.filter((url): url is string => typeof url === 'string' && url.length > 0)
    : [];

  return { text, citedUrls, grounded: true, raw: data };
}
