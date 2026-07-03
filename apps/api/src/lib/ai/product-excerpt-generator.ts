/**
 * Shared product-excerpt generation core.
 *
 * Derives a short 1-2 sentence bilingual (EN + AR) summary from a product's
 * full `description` / `descriptionAr`. Used by the `bulk-ai-excerpt`
 * catalogue sweep. Follows the same plain GoogleGenerativeAI + parseAiJson
 * shape as `product-faq-generator.ts` so every bulk-AI generator reads the
 * same way.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { parseAiJson } from './parse-ai-json';

export const EXCERPT_MAX_LENGTH = 300;

export interface GenerateProductExcerptInput {
  storeName: string;
  product: {
    name: string;
    nameAr?: string | null;
    description?: string | null;
    descriptionAr?: string | null;
  };
}

export interface GeneratedProductExcerpt {
  excerpt: string;
  excerptAr: string;
}

function buildExcerptPrompt(input: GenerateProductExcerptInput): string {
  const { storeName, product } = input;
  return `You write short product excerpts for a Kuwait-based e-commerce store called ${storeName}.

Product: ${product.name}${product.nameAr ? ` / ${product.nameAr}` : ''}
Full description (EN): ${product.description ?? '(none)'}
Full description (AR): ${product.descriptionAr ?? '(none)'}

Write a 1-2 sentence short excerpt summarising this product — punchy, no fluff,
usable as a compact summary in search results and share cards. Provide it in
BOTH English and Arabic (formal MSA, not dialect), even if only one full
description was given (translate as needed).

Return ONLY valid JSON — no markdown, no explanation:
{ "excerpt": "English excerpt.", "excerptAr": "الملخص بالعربية." }`;
}

/**
 * Generate a bilingual 1-2 sentence excerpt for a single product via Gemini.
 * Throws on a missing API key (caller decides how to surface) and on an
 * unparseable model response.
 */
export async function generateProductExcerpt(
  input: GenerateProductExcerptInput,
  apiKey: string,
  modelName: string
): Promise<GeneratedProductExcerpt> {
  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: modelName });

  const prompt = buildExcerptPrompt(input);
  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  const parsed = parseAiJson<Partial<GeneratedProductExcerpt>>(raw);
  if (!parsed || typeof parsed.excerpt !== 'string' || typeof parsed.excerptAr !== 'string') {
    throw new Error('AI returned unexpected format');
  }

  return {
    excerpt: parsed.excerpt.trim().slice(0, EXCERPT_MAX_LENGTH),
    excerptAr: parsed.excerptAr.trim().slice(0, EXCERPT_MAX_LENGTH),
  };
}
