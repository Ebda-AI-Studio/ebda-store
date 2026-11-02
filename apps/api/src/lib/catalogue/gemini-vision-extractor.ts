/**
 * Default extractor: Gemini vision through the `*-latest` alias (never a versioned name), with
 * structured output. Quota first (`assertAiQuota` with bulk: true), usage recorded after.
 */
import { GeminiFailoverClient } from '../ai/gemini-keys';
import { assertAiQuota } from '../ai-quota';
import { rethrowAsAppError } from '../ai/gemini-errors';
import { recordUsage } from '../../services/ai.service';
import { AppError } from '../../middleware/error-handler';
import { CATALOGUE_RESPONSE_SCHEMA } from '@ebda/shared';
import { buildCataloguePrompt } from './prompt';
import type {
  CatalogueExtractionInput,
  CatalogueExtractionResult,
  CatalogueExtractor,
} from './extractor';

const model = () => process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

function parseJson(text: string): unknown {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    throw new AppError(502, 'AI_BAD_RESPONSE', 'The reply could not be read.');
  }
}

export class GeminiVisionExtractor implements CatalogueExtractor {
  readonly name = 'gemini-vision';
  private client: GeminiFailoverClient | null = null;

  async extract(input: CatalogueExtractionInput): Promise<CatalogueExtractionResult> {
    if (!process.env.GOOGLE_GENERATIVE_AI_KEY && !process.env.GEMINI_API_KEY) {
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI is not configured.');
    }
    await assertAiQuota({ storeId: input.storeId, bulk: true });
    this.client ??= new GeminiFailoverClient();
    const m = model();
    let result;
    try {
      result = await this.client
        .getGenerativeModel({
          model: m,
          generationConfig: {
            responseMimeType: 'application/json',
            // The SDK's schema enum types are strings at runtime.
            responseSchema: CATALOGUE_RESPONSE_SCHEMA as never,
            temperature: 0,
          },
        })
        .generateContent({
          contents: [
            {
              role: 'user',
              parts: [
                { text: buildCataloguePrompt(input) },
                { inlineData: { mimeType: input.mime, data: input.bytes.toString('base64') } },
              ],
            },
          ],
        });
    } catch (err) {
      rethrowAsAppError(err, 'catalogue extraction failed');
    }
    const usage = result.response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    await recordUsage(input.storeId, 'catalog-import', inputTokens, outputTokens, false, {
      model: m,
    });
    return { raw: parseJson(result.response.text()), inputTokens, outputTokens, model: m };
  }
}

let current: CatalogueExtractor | null = null;
export function getCatalogueExtractor(): CatalogueExtractor {
  return (current ??= new GeminiVisionExtractor());
}
/** Tests swap the extractor for a recorded replay. */
export function setCatalogueExtractorForTests(e: CatalogueExtractor | null): void {
  current = e;
}
