/**
 * AI cost-gate feature registry.
 *
 * Each entry assembles the feature's prompt from its REAL builder against a
 * fixed representative input, so the estimated cost tracks the ACTUAL prompt
 * the code produces today. Edit a prompt to be much larger and the input-token
 * count — and thus $/day — moves, tripping the cost gate (ai-cost-gate.test.ts).
 *
 * Coverage note: this covers the highest-volume single-product AI generators
 * whose prompt builder is a pure exported function. Bulk sweeps and inline-prompt
 * features are added here as their builders are factored out — a partial set is
 * fine; the gate protects what it lists and the test logs the covered features.
 *
 * callsPerDay / outputTokensEst are documented ASSUMPTIONS for $/day weighting;
 * the gate cares about RELATIVE change vs baseline, so exact volumes aren't
 * critical — stability is.
 */
import { buildProductFaqPrompt } from '../product-faq-generator';
import { buildExcerptPrompt } from '../product-excerpt-generator';
import { buildTagsPrompt } from '../product-tag-suggester';
import { buildMetaAeoPrompt } from '../product-meta-aeo-generator';
import type { FeatureCostInput } from './cost';

const MODEL = 'gemini-flash-lite-latest';
const STORE = { storeId: 'rep-store', storeName: 'Demo Store' };

/** A typical bilingual Ebda product with a variant option — representative prompt size. */
const REP_PRODUCT = {
  name: 'Organic Medjool Dates 400g',
  nameAr: 'تمر مجدول عضوي 400 جرام',
  description:
    'Premium soft Medjool dates, naturally sweet with a caramel-like flavour. Hand-picked, unpitted, and packed fresh. Rich in fibre and potassium — a wholesome snack or gift.',
  descriptionAr:
    'تمر مجدول فاخر طري بطعم يشبه الكراميل. مقطوف يدويًا ومعبأ طازجًا. غني بالألياف والبوتاسيوم — وجبة خفيفة صحية أو هدية.',
  options: [
    { name: 'Size', values: [{ value: '400 Gram' }, { value: '700 Gram' }, { value: '1 Kg' }] },
  ],
};

export const AI_COST_FEATURES: FeatureCostInput[] = [
  {
    feature: 'product-faq',
    model: MODEL,
    prompt: buildProductFaqPrompt({ ...STORE, product: REP_PRODUCT, count: 5 }),
    outputTokensEst: 450,
    callsPerDay: 500,
  },
  {
    feature: 'product-excerpt',
    model: MODEL,
    prompt: buildExcerptPrompt({
      ...STORE,
      product: {
        name: REP_PRODUCT.name,
        nameAr: REP_PRODUCT.nameAr,
        description: REP_PRODUCT.description,
        descriptionAr: REP_PRODUCT.descriptionAr,
      },
    }),
    outputTokensEst: 90,
    callsPerDay: 500,
  },
  {
    feature: 'product-tags',
    model: MODEL,
    prompt: buildTagsPrompt({
      ...STORE,
      product: { name: REP_PRODUCT.name, description: REP_PRODUCT.description },
      existingTagNames: ['dates', 'organic', 'gifts', 'snacks'],
    }),
    outputTokensEst: 40,
    callsPerDay: 300,
  },
  {
    feature: 'product-meta-aeo',
    model: MODEL,
    prompt: buildMetaAeoPrompt(
      'product',
      REP_PRODUCT.name,
      REP_PRODUCT.description,
      STORE.storeName
    ),
    outputTokensEst: 120,
    callsPerDay: 300,
  },
];
