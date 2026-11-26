/**
 * Shared AEO (Answer Engine Optimisation) meta-description generation core.
 *
 * `buildMetaAeoPrompt` is the single prompt source of truth for the
 * conversational "What is X?" style meta description Gemini drafts for a
 * store, product, or category — moved here from the bulk AEO sweep
 * (`bulk-ai-meta-aeo` in lib/inngest/functions/bulk-ai-aeo.ts) so the
 * per-product "Generate with AI" button (POST /ai/product-meta-aeo) and the
 * catalogue-wide bulk sweep share EXACTLY the same wording — no drift
 * between the two surfaces. Mirrors the product-FAQ generator's DRY shape
 * (lib/ai/product-faq-generator.ts).
 *
 * `generateProductMetaAeo` wraps the product-kind prompt with the
 * generateContent call + usage recording + hardened JSON parse for the
 * single-product path; the bulk sweep calls it too for the product branch
 * (store + category branches keep calling `buildMetaAeoPrompt` directly
 * since they persist/skip differently per-kind).
 */
import { GeminiFailoverClient } from './gemini-keys';
import { parseAiJson } from './parse-ai-json';
import { rethrowAsAppError } from './gemini-errors';
import { recordUsage } from '../../services/ai.service';
import { assertAiQuota } from '../ai-quota';
import { EGYPTIAN_ARABIC_REGISTER } from './arabic-register';

export type MetaAeoKind = 'store' | 'product' | 'category';

export interface GeneratedMetaAeo {
  en: string;
  ar: string;
}

/**
 * Build the AEO meta-description prompt for a store, product, or category.
 * Kept as a named function so the prompt is a single source of truth across
 * the synchronous per-product route and the async bulk sweep.
 */
export function buildMetaAeoPrompt(
  kind: MetaAeoKind,
  name: string,
  description: string,
  storeName?: string
): string {
  const context =
    kind === 'store'
      ? `Store name: "${name}"\nStore description: ${description || 'Not provided.'}`
      : kind === 'category'
        ? `Category: "${name}"\nFrom store: "${storeName ?? ''}"\nCategory description: ${
            description || 'Not provided.'
          }`
        : `Product: "${name}"\nFrom store: "${storeName ?? ''}"\nProduct description: ${
            description || 'Not provided.'
          }`;

  const naturalInclude =
    kind === 'store'
      ? 'the store name and its main product category'
      : kind === 'category'
        ? `the category name and the kinds of products it contains at ${storeName ?? 'the store'}`
        : 'the product name and what it does or is for';

  return `You are an AEO (Answer Engine Optimisation) expert writing meta descriptions for an Egypt-based e-commerce ${kind}.

${context}

Write a meta description that directly answers the question a user might ask an AI assistant — like "What is ${name}?" or "What does ${
    storeName ?? name
  } sell?". Requirements:
- Conversational, first-answer style — like the opening sentence of a Wikipedia article
- Factual and specific, no marketing fluff or keyword stuffing
- Between 130-160 characters (English)
- Naturally include ${naturalInclude}
- Both English and Arabic. ${EGYPTIAN_ARABIC_REGISTER}

Return ONLY a JSON object with keys "en" and "ar". No markdown, no code fences — pure JSON only.
Example: {"en": "Acme Souq is an Egypt-based online retailer ...", "ar": "أكمي سوق متجر مصري متخصص في ..."}`;
}

export interface GenerateProductMetaAeoInput {
  /** storeId for AI quota-usage attribution (AiUsage row). */
  storeId: string;
  /** Store display name for prompt context (falls back to storeId upstream). */
  storeName: string;
  product: {
    name: string;
    description?: string | null;
  };
  /** A background sweep: budgeted against the bulk ceiling (keeps the interactive reserve). */
  bulk?: boolean;
}

/**
 * Generate a bilingual AEO meta description for a single product via
 * Gemini. Same anti-hallucination discipline as `generateProductFaqs` —
 * the prompt grounds the model in only the product name/description
 * given, no invented specifics.
 *
 * Gemini/SDK errors are converted to a clean AppError via
 * rethrowAsAppError so raw provider error text never reaches a
 * merchant-facing surface. Successful calls record AiUsage under the
 * existing 'aeo' feature bucket — the SAME bucket the bulk sweep already
 * uses, so per-product and bulk usage roll up together for quota
 * accounting. Throws a plain Error on an unparseable/incomplete model
 * response (per-product error upstream).
 */
export async function generateProductMetaAeo(
  input: GenerateProductMetaAeoInput,
  apiKey: string,
  modelName: string
): Promise<GeneratedMetaAeo> {
  // The budget lives HERE, not in the callers (#838): POST /ai/product-meta-aeo reached Gemini with no quota check.
  await assertAiQuota({ storeId: input.storeId, bulk: input.bulk === true });
  const genai = new GeminiFailoverClient(apiKey);
  const model = genai.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json' },
  });

  const prompt = buildMetaAeoPrompt(
    'product',
    input.product.name,
    input.product.description ?? '',
    input.storeName
  );
  let result;
  try {
    result = await model.generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI product meta AEO generation failed');
  }

  const usage = result.response.usageMetadata;
  await recordUsage(
    input.storeId,
    'aeo',
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0,
    false,
    { model: modelName }
  );

  const raw = result.response.text();
  const parsed = parseAiJson<{ en?: unknown; ar?: unknown }>(raw);
  if (typeof parsed.en !== 'string' || !parsed.en.trim()) {
    throw new Error('AI returned unexpected format');
  }

  return {
    en: parsed.en.trim().slice(0, 160),
    ar: typeof parsed.ar === 'string' ? parsed.ar.trim().slice(0, 160) : '',
  };
}
