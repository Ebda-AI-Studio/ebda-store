/**
 * Shared product-category suggestion core.
 *
 * Mirrors the logic behind `AIService.suggestCategories` (used by the
 * per-product "Suggest categories" button at POST /ai/suggest-categories)
 * but is standalone so the catalogue-wide bulk sweep
 * (`bulk-ai-categorize` Inngest fn) can call it directly with the plain
 * `config.googleAiKey` + `callWithRetry` + `parseAiJson` bulk-AI plumbing,
 * matching the shape of `product-faq-generator.ts`.
 *
 * Never invents categories — only ever returns ids drawn from the
 * `existingCategories` list the caller passes in. If nothing is a
 * confident match, returns an empty match list (caller treats as skip).
 */
import { GeminiFailoverClient } from './gemini-keys';
import { parseAiJson } from './parse-ai-json';
import { rethrowAsAppError } from './gemini-errors';
import { recordUsage } from '../../services/ai.service';

export interface CategoryOption {
  id: string;
  name: string;
  nameAr?: string | null;
}

export interface SuggestProductCategoryInput {
  /** storeId for AI quota-usage attribution (AiUsage row). */
  storeId: string;
  storeName: string;
  product: {
    name: string;
    description?: string | null;
  };
  existingCategories: CategoryOption[];
}

export interface SuggestedCategoryMatch {
  id: string;
  confidence: 'high' | 'medium' | 'low';
}

function buildCategorizePrompt(input: SuggestProductCategoryInput): string {
  const { storeName, product, existingCategories } = input;
  const catList = existingCategories
    .map(c => `${c.id} :: ${c.name}${c.nameAr ? ` / ${c.nameAr}` : ''}`)
    .join('\n');

  return `You categorise products for an Egypt-based e-commerce store called ${storeName}.

Available categories (id :: name [/ name_ar]):
${catList}

Product name: ${product.name}
Product description: ${product.description || '(none)'}

Pick the SINGLE best-matching category for this product from the list above.
Never invent a category — only use ids from the list. If none of the
categories fit well, return an empty array.

Return ONLY valid JSON — no markdown, no explanation:
{ "matches": [{ "id": "<category-id-from-list>", "confidence": "high" | "medium" | "low" }] }`;
}

/**
 * Suggest the single best-matching category for a product, drawn only from
 * the store's own existing category list. Throws on a missing API key
 * (caller decides how to surface) and on an unparseable model response.
 */
export async function suggestProductCategory(
  input: SuggestProductCategoryInput,
  apiKey: string,
  modelName: string
): Promise<SuggestedCategoryMatch[]> {
  if (input.existingCategories.length === 0) return [];

  const genai = new GeminiFailoverClient(apiKey);
  const model = genai.getGenerativeModel({ model: modelName });

  const prompt = buildCategorizePrompt(input);
  let result;
  try {
    result = await model.generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI category suggestion failed');
  }

  const usage = result.response.usageMetadata;
  await recordUsage(
    input.storeId,
    'categorize',
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0,
    false,
    { model: modelName }
  );

  const raw = result.response.text();

  const parsed = parseAiJson<{ matches?: SuggestedCategoryMatch[] }>(raw);
  if (!parsed || !Array.isArray(parsed.matches)) {
    throw new Error('AI returned unexpected format');
  }

  const idSet = new Set(input.existingCategories.map(c => c.id));
  return parsed.matches.filter(m => m && idSet.has(m.id));
}
