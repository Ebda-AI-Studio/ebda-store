/**
 * Gemini answer-engine provider — the free/active default for the AEO/GEO
 * "answer engine insights" feature. Asks Gemini a representative shopper
 * prompt and reports which URLs it cited (if grounded web search worked).
 *
 * GROUNDING FEASIBILITY (verified 2026-07-22, Task 3):
 * The installed SDK is `@google/generative-ai@0.24.1`. Its `Tool` union
 * (`dist/types/requests.d.ts`) is
 * `FunctionDeclarationsTool | CodeExecutionTool | GoogleSearchRetrievalTool`
 * — there is NO `googleSearch: {}` shape in this SDK version. The only
 * grounding tool it types is the legacy
 * `{ googleSearchRetrieval: { dynamicRetrievalConfig? } }`
 * (`dist/types/search-grounding.d.ts`), and the response DOES carry
 * `candidates[].groundingMetadata.groundingChunks[].web.uri`
 * (`dist/types/responses.d.ts`). That is outcome (b) from the task brief:
 * the tool shape compiles and the response type supports parsing citations,
 * but `googleSearchRetrieval` is the OLDER Gemini 1.x-era grounding tool —
 * newer 2.x-family models (which `gemini-flash-lite-latest` aliases to) use
 * a different `google_search` tool that this SDK version does not expose.
 * Sending `googleSearchRetrieval` to a model that doesn't support it is not
 * a compile-time error; whether it actually grounds is a live-API question
 * this task's mocked tests cannot settle.
 *
 * Because of that, this adapter:
 *   - Passes `tools: [{ googleSearchRetrieval: {} }]` as the SDK's most
 *     current available shape (parseable, forward-compatible).
 *   - Reads the model from `ANSWER_ENGINE_GEMINI_MODEL`, defaulting to the
 *     platform's `gemini-flash-lite-latest` — but flash-lite is NOT
 *     verified to support grounding. An operator who needs real grounded
 *     citations should override this env var to a grounding-capable model
 *     once one is confirmed live against this SDK/account.
 *   - Sets `grounded: true` only when the response actually carries
 *     `groundingMetadata` for the first candidate, so a model/tool
 *     combination that silently ignores the tool degrades to
 *     `grounded: false` (never claims a stronger signal than what came
 *     back) rather than throwing or lying about groundedness.
 */
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { config } from '../../config';
import { AppError } from '../../middleware/error-handler';
import { assertAiQuota } from '../../lib/ai-quota';
import { recordUsage } from '../ai.service';
import type { AnswerEngineProvider, EngineAnswer } from './provider';

const MODEL = process.env.ANSWER_ENGINE_GEMINI_MODEL || 'gemini-flash-lite-latest';

/** The minimal shape this adapter needs from a Gemini model — narrow enough
 * that tests can inject a plain mock object instead of the real SDK client. */
export type GeminiQueryModel = Pick<GenerativeModel, 'generateContent'>;

let cachedClient: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI {
  if (!config.googleAiKey) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI features are not configured on this server.');
  }
  if (!cachedClient) cachedClient = new GoogleGenerativeAI(config.googleAiKey);
  return cachedClient;
}

function getDefaultModel(): GeminiQueryModel {
  return getClient().getGenerativeModel({
    model: MODEL,
    tools: [{ googleSearchRetrieval: {} }],
  });
}

export class GeminiAnswerEngineProvider implements AnswerEngineProvider {
  readonly engine = 'gemini';
  private readonly model: GeminiQueryModel;

  /**
   * `model` is injectable (constructor arg) so tests can pass a mock and
   * never touch the real Gemini API / require `GOOGLE_GENERATIVE_AI_KEY`.
   * Omit it in production to lazily build the real client on first use.
   */
  constructor(model?: GeminiQueryModel) {
    this.model = model ?? getDefaultModel();
  }

  async query(storeId: string, prompt: string): Promise<EngineAnswer> {
    await assertAiQuota();

    const result = await this.model.generateContent(prompt);
    const response = result.response;

    let text = '';
    try {
      text = response.text();
    } catch {
      // Blocked prompt/candidate (safety filters etc.) — degrade to an
      // empty, ungrounded answer rather than throwing through to the caller.
      text = '';
    }

    const candidate = response.candidates?.[0];
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const citedUrls = groundingChunks
      .map(chunk => chunk?.web?.uri)
      .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);
    const grounded = candidate?.groundingMetadata !== undefined;

    const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const candidateTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    await recordUsage(storeId, 'answer_engine_gemini', promptTokens, candidateTokens, false);

    return { text, citedUrls, grounded, raw: result };
  }
}
