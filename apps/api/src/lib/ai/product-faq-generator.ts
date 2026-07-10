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
import { rethrowAsAppError } from './gemini-errors';
import { recordUsage } from '../../services/ai.service';

export interface GeneratedProductFaq {
  question: string;
  questionAr?: string;
  answer: string;
  answerAr?: string;
}

export interface GenerateProductFaqsInput {
  /** storeId for AI quota-usage attribution (AiUsage row). */
  storeId: string;
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

ACCURACY RULES — follow strictly:
- Answer ONLY with facts explicitly present in the product name/description above, OR with general store policy that is always safe (shipping timeframes, returns, ordering). NEVER invent product specifics — do not state sizes, materials, ingredients, dimensions, weight, colours, capacity, or compatibility that are not written above. If a fact is not given, do not make one up: either ask a question you can answer safely, or skip that topic.
- Do NOT restate information that is already in the description. Each FAQ must add NEW, useful information the description does not already cover — never paraphrase the description back to the customer.
- Keep answers concise (1-2 sentences), concrete, and honest. No marketing fluff, no guesses hedged as facts.

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
 * Gemini/SDK errors are converted to a clean AppError via rethrowAsAppError
 * (2026-07-05) so raw provider error text never reaches a merchant-facing
 * surface. Successful calls record AiUsage (feature 'product-faqs') so
 * assertAiQuota() actually sees this sweep's traffic. Also throws on an
 * unparseable model response (per-product error upstream).
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
  let result;
  try {
    result = await model.generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI product FAQ generation failed');
  }

  const usage = result.response.usageMetadata;
  await recordUsage(
    input.storeId,
    'product-faqs',
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0,
    false
  );

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
