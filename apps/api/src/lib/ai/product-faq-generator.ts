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
 * (Egyptian Arabic, FU46-Y02d). The Arabic fields are optional in the parsed shape only so a
 * malformed Gemini row degrades gracefully rather than throwing.
 */
import { GeminiFailoverClient } from './gemini-keys';
import { parseAiJson } from './parse-ai-json';
import { rethrowAsAppError } from './gemini-errors';
import { validateFaqGrounding } from './faq-grounding-validator';
import { recordUsage } from '../../services/ai.service';
import { assertAiQuota } from '../ai-quota';
import logger from '../logger';
import { EGYPTIAN_ARABIC_REGISTER } from './arabic-register';

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
    /**
     * Purchasable variant options (e.g. Size: 400 Gram / 700 Gram). These ARE
     * facts the model may use for size/weight/variant questions — without them
     * the model invents a single wrong figure (e.g. "200g") that contradicts
     * the options actually shown on the storefront.
     *
     * NOTE: the SKU is deliberately NOT fed to the prompt — it is an internal
     * code of no value to a shopper, and feeding it invited pointless "how do I
     * identify this product → SKU 1003" filler FAQs.
     */
    options?:
      | {
          name: string;
          nameAr?: string | null;
          values: { value: string; valueAr?: string | null }[];
        }[]
      | null;
  };
  /** How many FAQ pairs to draft (1..10). */
  count: number;
  /** A background sweep: budgeted against the bulk ceiling (keeps the interactive reserve). */
  bulk?: boolean;
}

/**
 * Render the concrete, verifiable product facts (purchasable variant options)
 * as a prompt block. Empty string when there are none, so the prompt degrades
 * to the name/description-only shape for simple products. The SKU is
 * intentionally excluded — see the input type note.
 */
function buildProductFactsBlock(product: GenerateProductFaqsInput['product']): string {
  const lines: string[] = [];
  const opts = (product.options ?? []).filter(o => o?.name && o.values?.length);
  for (const o of opts) {
    const vals = o.values.map(v => (v.valueAr ? `${v.value} / ${v.valueAr}` : v.value)).join(', ');
    lines.push(`${o.name}${o.nameAr ? ` / ${o.nameAr}` : ''}: ${vals}`);
  }
  if (lines.length === 0) return '';
  return `\nAvailable options / variants (these ARE facts you may use):\n${lines.join('\n')}\n`;
}

/**
 * Build the product-FAQ prompt. Kept as a named function so the prompt is
 * a single source of truth across the synchronous route and the async sweep.
 */
export function buildProductFaqPrompt(input: GenerateProductFaqsInput): string {
  const { storeName, product, count } = input;
  const factsBlock = buildProductFactsBlock(product);
  return `You are an SEO + AEO expert helping an Egypt-based e-commerce store write product FAQs.

Store: ${storeName}
Product: ${product.name}${product.nameAr ? ` / ${product.nameAr}` : ''}
Description: ${product.description ?? '(no description provided)'}
${factsBlock}
Draft UP TO ${count} FAQ pairs that a real shopper would genuinely ask about this specific product before buying it or while using it.

QUESTION-SELECTION RULES — follow strictly:
- Only include a FAQ that answers something a customer actually wonders about: sizing/fit, materials, shipping time, return policy, how to use, care instructions, compatibility. Pick the ones most relevant to THIS product.
- Quality over quantity: if fewer than ${count} genuinely useful questions exist for this product, return FEWER. NEVER pad to the count with filler.
- NEVER ask meta or operational questions about the product record itself — e.g. "how do I identify this product", "what is the product code/SKU", "does this product exist", "how do I find this on the site". Shoppers browse the store; they never order by an internal code.
- NEVER mention an SKU, product code, internal ID, or database field in a question OR an answer.

ACCURACY RULES — follow strictly:
- Answer ONLY with facts explicitly present in the product name/description/options above, OR with general store policy that is always safe (shipping timeframes, returns, ordering). NEVER invent product specifics — do not state sizes, materials, ingredients, dimensions, weight, colours, capacity, or compatibility that are not written above. If a fact is not given, do not make one up: either ask a question you can answer safely, or skip that topic.
- When the "Available options / variants" block is present, use THOSE exact values for any size/weight/variant question (e.g. list the sizes offered). NEVER state a single size/weight that is not one of the listed options — that is the most common accuracy failure.
- Do NOT restate information that is already in the description. Each FAQ must add NEW, useful information the description does not already cover — never paraphrase the description back to the customer.
- Keep answers concise (1-2 sentences), concrete, and honest. No marketing fluff, no guesses hedged as facts.

Each FAQ must have a question AND answer in BOTH English AND Arabic. ${EGYPTIAN_ARABIC_REGISTER}

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
  // The budget lives HERE, not in the callers: every per-product route and sweep that reaches this model call
  // reserves the store's slot and gives it back in the finally (#838, #845, Ruling AI-SLICE-ATOMIC-1).
  const aiSlot = await assertAiQuota({ storeId: input.storeId, bulk: input.bulk === true });
  try {
    const genai = new GeminiFailoverClient(apiKey);
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
      false,
      { model: modelName }
    );

    const raw = result.response.text();

    // parseAiJson strips code fences + trailing prose (outermost-JSON-span
    // slice) and sanitises control chars before JSON.parse — the canonical
    // hardened Gemini parse path.
    const faqs = parseAiJson<GeneratedProductFaq[]>(raw);
    if (!Array.isArray(faqs)) {
      throw new Error('AI returned unexpected format');
    }

    // Deterministic grounding guard — drop any FAQ whose answer states a
    // measurement (weight/size/volume/dimension) not present in the product's
    // known facts. This catches the residual "200g" hallucination the prompt
    // rule alone can't guarantee, on BOTH the draft route and the bulk sweep.
    const { kept, dropped } = validateFaqGrounding(faqs, input.product);
    if (dropped.length > 0) {
      logger.warn(
        {
          storeId: input.storeId,
          product: input.product.name,
          droppedCount: dropped.length,
          offending: dropped.flatMap(d => d.offending),
        },
        'faq-grounding: dropped ungrounded measurement claim(s)'
      );
    }
    return kept;
  } finally {
    await aiSlot?.release(); // `?.`: test doubles of assertAiQuota resolve to undefined
  }
}
