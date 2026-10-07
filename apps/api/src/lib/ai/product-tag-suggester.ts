/**
 * Shared product-tag suggestion core.
 *
 * Suggests up to 5 short tags from a product's name + description, biased
 * towards REUSING the store's existing tags (case-insensitive match) before
 * proposing a new one. Never returns duplicates or empty strings. Used by
 * the `bulk-ai-tags` catalogue sweep.
 */
import { GeminiFailoverClient } from './gemini-keys';
import { parseAiJson } from './parse-ai-json';
import { rethrowAsAppError } from './gemini-errors';
import { recordUsage } from '../../services/ai.service';

export const MAX_TAGS_PER_PRODUCT = 5;

export interface SuggestProductTagsInput {
  /** storeId for AI quota-usage attribution (AiUsage row). */
  storeId: string;
  storeName: string;
  product: {
    name: string;
    description?: string | null;
  };
  /** The store's existing tag names, for reuse-bias in the prompt. */
  existingTagNames: string[];
}

export function buildTagsPrompt(input: SuggestProductTagsInput): string {
  const { storeName, product, existingTagNames } = input;
  const existingList =
    existingTagNames.length > 0 ? existingTagNames.join(', ') : '(no tags yet in this store)';

  return `You suggest product tags for an Egypt-based e-commerce store called ${storeName}.

Product name: ${product.name}
Product description: ${product.description || '(none)'}

The store already uses these tags: ${existingList}

Suggest up to ${MAX_TAGS_PER_PRODUCT} short, relevant tags for this product
(single words or short phrases, e.g. "cotton", "summer", "best-seller").
STRONGLY PREFER reusing one of the store's existing tags above when it fits —
only propose a brand-new tag when nothing existing applies.

Return ONLY valid JSON — no markdown, no explanation:
{ "tags": ["tag1", "tag2"] }`;
}

/**
 * Suggest up to MAX_TAGS_PER_PRODUCT tag names for a product. Returns
 * trimmed, de-duplicated (case-insensitive), non-empty strings — the caller
 * matches each against the store's existing `Tag` rows and creates any that
 * are genuinely new.
 */
export async function suggestProductTags(
  input: SuggestProductTagsInput,
  apiKey: string,
  modelName: string
): Promise<string[]> {
  const genai = new GeminiFailoverClient(apiKey);
  const model = genai.getGenerativeModel({ model: modelName });

  const prompt = buildTagsPrompt(input);
  let result;
  try {
    result = await model.generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI tag suggestion failed');
  }

  const usage = result.response.usageMetadata;
  await recordUsage(
    input.storeId,
    'tags',
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0,
    false,
    { model: modelName }
  );

  const raw = result.response.text();

  const parsed = parseAiJson<{ tags?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.tags)) {
    throw new Error('AI returned unexpected format');
  }

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of parsed.tags) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim().slice(0, 50);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(trimmed);
    if (tags.length >= MAX_TAGS_PER_PRODUCT) break;
  }

  return tags;
}
