/**
 * OpenAI answer-engine provider (AEO/GEO insights feature) — DORMANT
 * until an admin enables it and sets an API key (Task 5 builds that
 * write path; this adapter just needs to work once keyed).
 *
 * Uses OpenAI's Responses API with the built-in `web_search_preview`
 * tool so answers can be grounded in live search results, mirroring how
 * a shopper would actually see an AI answer. Chosen over plain
 * `chat/completions` because that endpoint has no built-in web-search
 * tool or citation annotations to report — the Responses API is the
 * only shape that lets us honestly set `grounded` per-call.
 *
 * API shape targeted (current as of 2026-07 — no SDK, plain `fetch`,
 * per the task constraint):
 *   POST https://api.openai.com/v1/responses
 *   Request:  { model, input: prompt, tools: [{ type: 'web_search_preview' }] }
 *   Response: {
 *     output: [
 *       // present only when the model actually invoked the tool
 *       { type: 'web_search_call', status: 'completed' },
 *       {
 *         type: 'message',
 *         content: [
 *           {
 *             type: 'output_text',
 *             text: string,
 *             annotations: [{ type: 'url_citation', url: string }]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * `grounded` is true only when a `web_search_call` output item is
 * present — the model can ignore the tool and answer from parametric
 * knowledge, and we must not claim a stronger signal than what actually
 * happened. citedUrls prefers `url_citation` annotations; if none are
 * present (tool wasn't used, or nothing was cited inline) we fall back
 * to scanning the answer text for bare URLs, same defensive spirit as
 * `detectCitation` in provider.ts.
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
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from '../../lib/fetch-timeout';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MODEL = process.env.ANSWER_ENGINE_OPENAI_MODEL || 'gpt-4o-mini';

const EMPTY_ANSWER: EngineAnswer = { text: '', citedUrls: [], grounded: false };

// Last-resort citation extraction when the response carries no
// structured annotations — matches bare http(s) URLs in free text.
const URL_REGEX = /https?:\/\/[^\s)"'<>]+/g;

export class OpenAiAnswerEngineProvider implements AnswerEngineProvider {
  readonly engine = 'openai';
  readonly modelId = MODEL;

  constructor(private readonly apiKey: string) {}

  async query(_storeId: string, prompt: string): Promise<EngineAnswer> {
    let res: Response;
    try {
      res = await fetchWithTimeout(ENDPOINT, {
        timeoutMs: LLM_FETCH_TIMEOUT_MS,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          input: prompt,
          tools: [{ type: 'web_search_preview' }],
        }),
      });
    } catch (err) {
      logger.error({ err }, 'OpenAI answer-engine request failed');
      return { ...EMPTY_ANSWER };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body: bodyText },
        'OpenAI answer-engine returned a non-OK response'
      );
      return { ...EMPTY_ANSWER };
    }

    try {
      const data: unknown = await res.json();
      return parseOpenAiResponse(data);
    } catch (err) {
      logger.error({ err }, 'Failed to parse OpenAI answer-engine response');
      return { ...EMPTY_ANSWER };
    }
  }
}

function parseOpenAiResponse(data: unknown): EngineAnswer {
  if (!data || typeof data !== 'object') return { ...EMPTY_ANSWER };

  const output = Array.isArray((data as { output?: unknown }).output)
    ? (data as { output: unknown[] }).output
    : [];

  const grounded = output.some(
    item =>
      !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'web_search_call'
  );

  const textParts: string[] = [];
  const citedUrls: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'message')
      continue;
    const content = (item as { content?: unknown }).content;
    const parts = Array.isArray(content) ? content : [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { type?: unknown; text?: unknown; annotations?: unknown };
      if (p.type !== 'output_text') continue;
      if (typeof p.text === 'string') textParts.push(p.text);

      const annotations = Array.isArray(p.annotations) ? p.annotations : [];
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== 'object') continue;
        const a = annotation as { type?: unknown; url?: unknown };
        if (a.type === 'url_citation' && typeof a.url === 'string' && a.url.length > 0) {
          citedUrls.push(a.url);
        }
      }
    }
  }

  const text = textParts.join('\n');

  if (citedUrls.length === 0 && text) {
    const fallback = text.match(URL_REGEX) ?? [];
    citedUrls.push(...fallback);
  }

  return { text, citedUrls, grounded, raw: data };
}
