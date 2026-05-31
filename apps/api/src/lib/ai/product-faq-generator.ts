/**
 * Shared product-FAQ generation core.
 *
 * The single-product "Draft with AI" button (POST /ai/product-faqs/draft)
 * and the catalogue-wide bulk FAQ sweep (POST /ai/bulk/product-faqs →
 * Inngest `bulk-ai-product-faqs`) MUST produce identical FAQ output for the
 * same product. To stay DRY, both call `generateProductFaqs()` here — there
 * is exactly ONE prompt + parse path for product FAQs.
 *
 * Bilingual by contract: every FAQ has an EN + AR question and answer
 * (formal MSA). The Arabic fields are optional in the parsed shape only so a
 * malformed Gemini row degrades gracefully rather than throwing.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { parseAiJson } from './parse-ai-json';

export interface GeneratedProductFaq {
  question: string;
  questionAr?: string;
  answer: string;
  answerAr?: string;
}

export interface GenerateProductFaqsInput {
  /** Store display name for prompt context (falls back to storeId upstream). */
  storeName: string;
  product: {
    name: string;
    nameAr?: string | null;
    description?: string | null;
  };
  /** How many FAQ pairs to draft (1..10). */
  count: number;
}

/**
 * Build the product-FAQ prompt. Kept as a named function so the prompt is
 * a single source of truth across the synchronous route and the async sweep.
 */
function buildProductFaqPrompt(input: GenerateProductFaqsInput): string {
  const { storeName, product, count } = input;
  return `You are an SEO + AEO expert helping a Kuwait-based e-commerce store write product FAQs.

Store: ${storeName}
Product: ${product.name}${product.nameAr ? ` / ${product.nameAr}` : ''}
Description: ${product.description ?? '(no description provided)'}

Draft exactly ${count} FAQ pairs that real customers would ask about this specific product.
Cover: sizing/fit, materials, shipping time, return policy, how to use, care instructions — pick the most relevant for this product.
Each FAQ must have a question AND answer in BOTH English AND Arabic (formal MSA, not dialect).

Return ONLY valid JSON — no markdown, no explanation:
[
  {
    "question": "English question?",
    "questionAr": "السؤال بالعربية؟",
    "answer": "English answer.",
    "answerAr": "الإجابة بالعربية."
  }
]`;
}

/**
 * Generate bilingual FAQ pairs for a single product via Gemini.
 *
 * Throws on a missing API key (caller maps to 503 AI_NOT_CONFIGURED in the
 * sync route, or records a per-product error in the sweep) and on an
 * unparseable model response (502 AI_PARSE_ERROR / per-product error).
 *
 * `apiKey` and `modelName` are injected so the caller decides config
 * resolution — the sync route reads process.env directly, the Inngest fn
 * reads from `config`. Both arrive at the same prompt + parse.
 */
export async function generateProductFaqs(
  input: GenerateProductFaqsInput,
  apiKey: string,
  modelName: string
): Promise<GeneratedProductFaq[]> {
  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: modelName });

  const prompt = buildProductFaqPrompt(input);
  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  // parseAiJson strips code fences + trailing prose (outermost-JSON-span
  // slice) and sanitises control chars before JSON.parse — the canonical
  // hardened Gemini parse path.
  const faqs = parseAiJson<GeneratedProductFaq[]>(raw);
  if (!Array.isArray(faqs)) {
    throw new Error('AI returned unexpected format');
  }
  return faqs;
}
