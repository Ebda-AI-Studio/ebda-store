/**
 * AI-output evaluation criteria registry.
 *
 * One entry per distinct AI generation path in the codebase (see the
 * doc-comment in `types.ts` for the deterministic-vs-model-judge split).
 * Input/output shapes are imported directly (`import type`) from the real
 * generator modules wherever they're exported, so the criteria stay in
 * sync with the actual contract instead of drifting from a re-typed copy.
 *
 * Coverage (21 output types, every AI generation path in the codebase):
 *   apps/api/src/lib/ai/*.ts            → product-faq, product-excerpt,
 *                                          product-alt-text,
 *                                          product-category-suggestion,
 *                                          product-tags
 *   apps/api/src/services/ai.service.ts → translation, seo-meta,
 *                                          section-copy, logo-palette
 *   apps/api/src/services/ai-autofill.service.ts → description-balance
 *   apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts → store-faq,
 *                                          howto-guide, meta-aeo
 *   apps/api/src/lib/inngest/functions/bulk-ai-geo.ts → llms-txt,
 *                                          citation-copy, brand-facts
 *   apps/api/src/lib/inngest/functions/bulk-ai-recommendations.ts →
 *                                          product-recommendations
 *   apps/api/src/lib/ai/review-tools.ts → review-translation,
 *                                          review-spam-detection,
 *                                          review-summary,
 *                                          review-owner-response
 */
import type { CriteriaSpec, AiOutputType } from './types';
import type { GeneratedProductFaq, GenerateProductFaqsInput } from '../product-faq-generator';
import type {
  GeneratedProductExcerpt,
  GenerateProductExcerptInput,
} from '../product-excerpt-generator';
import { EXCERPT_MAX_LENGTH } from '../product-excerpt-generator';
import type { GenerateProductAltTextInput } from '../product-alt-text-generator';
import { ALT_TEXT_MAX_LENGTH } from '../product-alt-text-generator';
import type {
  SuggestProductCategoryInput,
  SuggestedCategoryMatch,
} from '../product-category-suggester';
import type { SuggestProductTagsInput } from '../product-tag-suggester';
import { MAX_TAGS_PER_PRODUCT } from '../product-tag-suggester';
import type {
  SeoSuggestion,
  ExtractedPalette,
  TranslationKind,
} from '../../../services/ai.service';
import type { SpamCheckResult, ReviewSummary, OwnerResponseDraft } from '../review-tools';
import {
  isNonEmptyString,
  isPlaceholder,
  withinLength,
  noLargeArabicSpan,
  noLargeUntranslatedLatinSpan,
  containsArabic,
  tokenOverlapRatio,
  hasCaseInsensitiveDuplicates,
  mentionsPaymentGatewayCompany,
  mentionsPriceOrStockClaim,
  hasInventedNumericSpec,
} from './helpers';

// Near-duplication threshold: an answer whose meaningful tokens overlap
// the reference text at or above this ratio is treated as "restates the
// description" — the exact regression class the merchant reported
// (2026-07-10, PR #538). Tuned generously (0.55) to avoid false positives
// on FAQs that legitimately reuse a couple of product-name words.
const DUPLICATION_THRESHOLD = 0.55;

const SEO_TITLE_MAX = 60;
const SEO_DESCRIPTION_MAX = 160;

// ---------------------------------------------------------------------------
// 1. product-faq — apps/api/src/lib/ai/product-faq-generator.ts
// ---------------------------------------------------------------------------

const productFaq: CriteriaSpec<GenerateProductFaqsInput, GeneratedProductFaq[]> = {
  type: 'product-faq',
  description: 'Bilingual product FAQ pairs (single-product draft + bulk sweep)',
  deterministic: [
    {
      name: 'shape-is-nonempty-array',
      run: (_input, output) => ({
        pass: Array.isArray(output) && output.length > 0 && output.length <= 10,
        reason: `expected 1-10 FAQ items, got ${Array.isArray(output) ? output.length : typeof output}`,
      }),
    },
    {
      name: 'bilingual-fields-present',
      run: (_input, output) => {
        const bad = (output ?? []).filter(
          f =>
            !isNonEmptyString(f?.question) ||
            !isNonEmptyString(f?.answer) ||
            !isNonEmptyString(f?.questionAr) ||
            !isNonEmptyString(f?.answerAr)
        );
        return {
          pass: bad.length === 0,
          reason:
            bad.length === 0
              ? 'every FAQ has EN+AR question and answer'
              : `${bad.length} FAQ(s) missing a required bilingual field`,
        };
      },
    },
    {
      name: 'no-placeholder-content',
      run: (_input, output) => {
        const bad = (output ?? []).filter(
          f => isPlaceholder(f?.question) || isPlaceholder(f?.answer)
        );
        return { pass: bad.length === 0, reason: `${bad.length} FAQ(s) contain placeholder text` };
      },
    },
    {
      name: 'arabic-fields-contain-arabic',
      run: (_input, output) => {
        const bad = (output ?? []).filter(f => {
          const qBad =
            !!f?.questionAr &&
            (!containsArabic(f.questionAr) || !noLargeUntranslatedLatinSpan(f.questionAr));
          const aBad =
            !!f?.answerAr &&
            (!containsArabic(f.answerAr) || !noLargeUntranslatedLatinSpan(f.answerAr));
          return qBad || aBad;
        });
        return {
          pass: bad.length === 0,
          reason: `${bad.length} FAQ(s) have an *Ar field with no Arabic script, or left largely untranslated`,
        };
      },
    },
    {
      name: 'no-duplicate-questions',
      run: (_input, output) => {
        const dup = hasCaseInsensitiveDuplicates((output ?? []).map(f => f.question ?? ''));
        return {
          pass: !dup,
          reason: dup ? 'duplicate question text across FAQs' : 'all questions distinct',
        };
      },
    },
    {
      name: 'no-description-duplication',
      run: (input, output) => {
        const desc = input?.product?.description ?? '';
        if (!desc.trim()) return { pass: true, reason: 'no description to duplicate against' };
        const offending = (output ?? []).filter(
          f => tokenOverlapRatio(f.answer, desc) >= DUPLICATION_THRESHOLD
        );
        return {
          pass: offending.length === 0,
          reason:
            offending.length === 0
              ? 'no answer near-verbatim repeats the description'
              : `${offending.length} FAQ answer(s) restate the product description (token overlap >= ${DUPLICATION_THRESHOLD})`,
        };
      },
    },
    {
      name: 'no-invented-numeric-specs',
      run: (input, output) => {
        const desc = input?.product?.description ?? '';
        const offending = (output ?? []).filter(f => hasInventedNumericSpec(f.answer, desc));
        return {
          pass: offending.length === 0,
          reason:
            offending.length === 0
              ? 'no numeric size/weight/capacity claim beyond what the description states'
              : `${offending.length} FAQ answer(s) state a numeric spec (size/weight/capacity/%) not present in the product description`,
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'Every FAQ answer states ONLY facts explicitly present in the product name/description input, or generic always-safe store policy (shipping timeframes, returns, ordering). FAIL if ANY answer invents a size, material, ingredient, dimension, weight, colour, capacity, or compatibility claim not present in the input.',
    },
    {
      name: 'no-duplication',
      instruction:
        'No FAQ answer merely paraphrases or restates content already present in the product description — each FAQ must add genuinely NEW information. FAIL if any answer is substantially a reworded copy of the description.',
    },
    {
      name: 'relevance',
      instruction:
        'The FAQs are specific, useful questions a real customer would actually ask about THIS product — not generic boilerplate that could apply to any product.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. product-excerpt — apps/api/src/lib/ai/product-excerpt-generator.ts
// ---------------------------------------------------------------------------

const productExcerpt: CriteriaSpec<GenerateProductExcerptInput, GeneratedProductExcerpt> = {
  type: 'product-excerpt',
  description: 'Short bilingual 1-2 sentence product summary',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass: isNonEmptyString(output?.excerpt) && isNonEmptyString(output?.excerptAr),
        reason: 'excerpt and excerptAr must both be non-empty strings',
      }),
    },
    {
      name: 'within-length-bound',
      run: (_input, output) => ({
        pass:
          withinLength(output?.excerpt, EXCERPT_MAX_LENGTH) &&
          withinLength(output?.excerptAr, EXCERPT_MAX_LENGTH),
        reason: `excerpt fields must be <= ${EXCERPT_MAX_LENGTH} chars`,
      }),
    },
    {
      name: 'bilingual-script-correct',
      run: (_input, output) => ({
        pass:
          containsArabic(output?.excerptAr) &&
          noLargeUntranslatedLatinSpan(output?.excerptAr) &&
          noLargeArabicSpan(output?.excerpt),
        reason:
          'excerptAr must contain Arabic script and not be left untranslated; excerpt must not be dominated by Arabic',
      }),
    },
    {
      name: 'no-placeholder-content',
      run: (_input, output) => ({
        pass: !isPlaceholder(output?.excerpt) && !isPlaceholder(output?.excerptAr),
        reason: 'excerpt fields must not be placeholder text',
      }),
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'The excerpt only summarises facts present in the given full description — FAIL if it invents any product detail not present in the input.',
    },
    {
      name: 'conciseness',
      instruction:
        'The excerpt is a punchy 1-2 sentence summary, not a restatement of the full description verbatim.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. product-alt-text — apps/api/src/lib/ai/product-alt-text-generator.ts
// ---------------------------------------------------------------------------

const productAltText: CriteriaSpec<GenerateProductAltTextInput, string> = {
  type: 'product-alt-text',
  description: 'SEO/a11y alt-text string for a product image (Gemini Vision)',
  deterministic: [
    {
      name: 'non-empty',
      run: (_input, output) => ({
        pass: isNonEmptyString(output),
        reason: 'alt text must be non-empty',
      }),
    },
    {
      name: 'within-length-bound',
      run: (_input, output) => ({
        pass: withinLength(output, ALT_TEXT_MAX_LENGTH),
        reason: `alt text must be <= ${ALT_TEXT_MAX_LENGTH} chars`,
      }),
    },
    {
      name: 'no-wrapping-quotes-or-markdown',
      run: (_input, output) => {
        const s = output ?? '';
        const bad = /^["'].*["']$/.test(s) || /[*_`#]/.test(s);
        return {
          pass: !bad,
          reason: bad ? 'alt text should be plain text, not quoted/markdown' : 'plain text',
        };
      },
    },
    {
      name: 'not-just-the-product-name',
      run: (input, output) => {
        const same =
          (output ?? '').trim().toLowerCase() === (input?.product?.name ?? '').trim().toLowerCase();
        return {
          pass: !same,
          reason: same ? 'alt text is only the product name — no visual description added' : 'ok',
        };
      },
    },
  ],
  // Vision-only generation — the harness has no image bytes to hand a
  // text judge, so a text-only "does it match the picture" score would be
  // meaningless. Left empty deliberately; documented limitation (see report).
  modelJudgeDimensions: [],
};

// ---------------------------------------------------------------------------
// 4. product-category-suggestion — product-category-suggester.ts (+ AIService.suggestCategories)
// ---------------------------------------------------------------------------

const productCategorySuggestion: CriteriaSpec<
  SuggestProductCategoryInput,
  SuggestedCategoryMatch[]
> = {
  type: 'product-category-suggestion',
  description: 'Best-matching category id(s) drawn only from the store taxonomy',
  deterministic: [
    {
      name: 'never-invents-category-ids',
      run: (input, output) => {
        const idSet = new Set((input?.existingCategories ?? []).map(c => c.id));
        const bad = (output ?? []).filter(m => !idSet.has(m.id));
        return {
          pass: bad.length === 0,
          reason:
            bad.length === 0
              ? 'every id is drawn from the taxonomy'
              : `${bad.length} id(s) not in existingCategories`,
        };
      },
    },
    {
      name: 'confidence-is-valid-enum',
      run: (_input, output) => {
        const bad = (output ?? []).filter(m => !['high', 'medium', 'low'].includes(m.confidence));
        return {
          pass: bad.length === 0,
          reason: `${bad.length} match(es) with invalid confidence value`,
        };
      },
    },
    {
      name: 'no-duplicate-ids',
      run: (_input, output) => {
        const dup = hasCaseInsensitiveDuplicates((output ?? []).map(m => m.id));
        return { pass: !dup, reason: dup ? 'duplicate category id returned' : 'ids unique' };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'relevance',
      instruction:
        'The suggested category genuinely fits the product name/description — FAIL if it is a poor or unrelated match.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 5. product-tags — product-tag-suggester.ts
// ---------------------------------------------------------------------------

const productTags: CriteriaSpec<SuggestProductTagsInput, string[]> = {
  type: 'product-tags',
  description: 'Up to 5 short product tags, biased to reuse existing store tags',
  deterministic: [
    {
      name: 'within-max-count',
      run: (_input, output) => ({
        pass: Array.isArray(output) && output.length <= MAX_TAGS_PER_PRODUCT,
        reason: `expected <= ${MAX_TAGS_PER_PRODUCT} tags`,
      }),
    },
    {
      name: 'no-empty-tags',
      run: (_input, output) => {
        const bad = (output ?? []).filter(t => !isNonEmptyString(t));
        return { pass: bad.length === 0, reason: `${bad.length} empty tag(s)` };
      },
    },
    {
      name: 'no-duplicate-tags',
      run: (_input, output) => {
        const dup = hasCaseInsensitiveDuplicates(output ?? []);
        return { pass: !dup, reason: dup ? 'duplicate tags (case-insensitive)' : 'tags unique' };
      },
    },
    {
      name: 'tag-length-bound',
      run: (_input, output) => {
        const bad = (output ?? []).filter(t => (t ?? '').length > 50);
        return { pass: bad.length === 0, reason: `${bad.length} tag(s) exceed 50 chars` };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'relevance',
      instruction:
        'Every tag genuinely describes the product (material, use-case, season, style) rather than being generic filler.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 6. translation — AIService.translate
// ---------------------------------------------------------------------------

export interface TranslationEvalInput {
  text: string;
  from: 'en' | 'ar';
  to: 'en' | 'ar';
  kind: TranslationKind;
}
export interface TranslationEvalOutput {
  translation: string;
}

const translation: CriteriaSpec<TranslationEvalInput, TranslationEvalOutput> = {
  type: 'translation',
  description: 'en<->ar translation of a single string (product/category/SEO fields)',
  deterministic: [
    {
      name: 'non-empty-when-source-non-empty',
      run: (input, output) => {
        if (!input.text.trim())
          return { pass: true, reason: 'empty source, empty translation expected' };
        return {
          pass: isNonEmptyString(output?.translation),
          reason: 'translation must be non-empty',
        };
      },
    },
    {
      name: 'target-script-correct',
      run: (input, output) => {
        if (!input.text.trim()) return { pass: true, reason: 'n/a' };
        const t = output?.translation ?? '';
        const pass =
          input.to === 'ar'
            ? containsArabic(t) && noLargeUntranslatedLatinSpan(t)
            : noLargeArabicSpan(t);
        return {
          pass,
          reason:
            input.to === 'ar'
              ? 'translation to Arabic must contain Arabic script and not be left untranslated'
              : 'translation to English must not be dominated by Arabic script',
        };
      },
    },
    {
      name: 'meta-length-hint-respected',
      run: (input, output) => {
        if (input.kind === 'meta-title')
          return {
            pass: withinLength(output?.translation, 60),
            reason: 'meta-title translation <= 60 chars',
          };
        if (input.kind === 'meta-description')
          return {
            pass: withinLength(output?.translation, 160),
            reason: 'meta-description translation <= 160 chars',
          };
        return { pass: true, reason: 'no length hint for this kind' };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'faithfulness',
      instruction:
        'The translation preserves the exact meaning of the source — no invented content, no dropped clauses, and brand names/product codes/sizes/numbers are preserved unchanged. FAIL on any meaning drift.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 7. seo-meta — AIService.suggestSeo
// ---------------------------------------------------------------------------

export interface SeoEvalInput {
  kind: 'store' | 'category' | 'product';
  entityName: string;
  entityDescription?: string | null;
}

const seoMeta: CriteriaSpec<SeoEvalInput, SeoSuggestion> = {
  type: 'seo-meta',
  description: 'Bilingual SEO title/description/keywords for store/category/product',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass:
          isNonEmptyString(output?.title) &&
          isNonEmptyString(output?.titleAr) &&
          isNonEmptyString(output?.description) &&
          isNonEmptyString(output?.descriptionAr) &&
          Array.isArray(output?.keywords),
        reason: 'title/titleAr/description/descriptionAr non-empty strings, keywords an array',
      }),
    },
    {
      name: 'title-within-60-chars',
      run: (_input, output) => ({
        pass: withinLength(output?.title, SEO_TITLE_MAX),
        reason: `title must be <= ${SEO_TITLE_MAX} chars`,
      }),
    },
    {
      name: 'description-within-160-chars',
      run: (_input, output) => ({
        pass: withinLength(output?.description, SEO_DESCRIPTION_MAX),
        reason: `description must be <= ${SEO_DESCRIPTION_MAX} chars`,
      }),
    },
    {
      name: 'bilingual-script-correct',
      run: (_input, output) => ({
        pass:
          containsArabic(output?.titleAr) &&
          noLargeUntranslatedLatinSpan(output?.titleAr) &&
          containsArabic(output?.descriptionAr) &&
          noLargeUntranslatedLatinSpan(output?.descriptionAr) &&
          noLargeArabicSpan(output?.title) &&
          noLargeArabicSpan(output?.description),
        reason:
          'Ar fields must contain Arabic and not be left untranslated; EN fields must not be dominated by Arabic',
      }),
    },
    {
      name: 'no-price-or-stock-claims',
      run: (_input, output) => {
        const bad = [
          output?.title,
          output?.description,
          output?.titleAr,
          output?.descriptionAr,
        ].some(mentionsPriceOrStockClaim);
        return {
          pass: !bad,
          reason: bad
            ? 'SEO copy mentions a price or stock-status claim (prompt forbids this)'
            : 'no price/stock claims',
        };
      },
    },
    {
      name: 'keywords-reasonable',
      run: (_input, output) => {
        const kws = output?.keywords ?? [];
        const pass = kws.length >= 1 && kws.length <= 15 && kws.every(isNonEmptyString);
        return { pass, reason: 'keywords should be 1-15 non-empty phrases' };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'The SEO copy only makes claims traceable to the entity name/description input — FAIL if it invents specifics (awards, certifications, unique claims) not present in the input.',
    },
    {
      name: 'search-relevance',
      instruction:
        'The title/keywords plausibly match how a Kuwaiti/GCC shopper would actually search for this entity.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 8. section-copy — AIService.suggestSectionContent
// ---------------------------------------------------------------------------

export interface SectionEvalInput {
  section: 'categories' | 'newArrivals' | 'bestSellers' | 'featured' | 'testimonials';
  storeName: string;
  existingTitle?: string;
}
export interface SectionEvalOutput {
  kicker: string;
  kickerAr: string;
  subtitle: string;
  subtitleAr: string;
}

const sectionCopy: CriteriaSpec<SectionEvalInput, SectionEvalOutput> = {
  type: 'section-copy',
  description: 'Homepage section kicker + subtitle (bilingual)',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass:
          isNonEmptyString(output?.kicker) &&
          isNonEmptyString(output?.kickerAr) &&
          isNonEmptyString(output?.subtitle) &&
          isNonEmptyString(output?.subtitleAr),
        reason: 'kicker/kickerAr/subtitle/subtitleAr must all be non-empty',
      }),
    },
    {
      name: 'kicker-within-16-chars',
      run: (_input, output) => ({
        pass: withinLength(output?.kicker, 16),
        reason: 'kicker must be <= 16 chars per prompt spec',
      }),
    },
    {
      name: 'subtitle-within-80-chars',
      run: (_input, output) => ({
        pass: withinLength(output?.subtitle, 80),
        reason: 'subtitle must be <= 80 chars per prompt spec',
      }),
    },
    {
      name: 'bilingual-script-correct',
      run: (_input, output) => ({
        pass:
          containsArabic(output?.kickerAr) &&
          noLargeUntranslatedLatinSpan(output?.kickerAr) &&
          containsArabic(output?.subtitleAr) &&
          noLargeUntranslatedLatinSpan(output?.subtitleAr) &&
          noLargeArabicSpan(output?.kicker) &&
          noLargeArabicSpan(output?.subtitle),
        reason:
          'Ar fields must contain Arabic and not be left untranslated; EN fields must not be dominated by Arabic',
      }),
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'no-title-repetition',
      instruction:
        'The kicker/subtitle do not simply repeat the existing section title verbatim — they add complementary framing.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 9. description-balance — ai-autofill.service.ts balanceProductLanguages
// ---------------------------------------------------------------------------

export interface DescriptionBalanceField {
  name: string | null;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
}

const descriptionBalance: CriteriaSpec<DescriptionBalanceField, DescriptionBalanceField> = {
  type: 'description-balance',
  description:
    'Post-balance name/nameAr + description/descriptionAr pair (Arabic-authoritative language balancer)',
  deterministic: [
    {
      name: 'language-slots-correct',
      run: (_input, output) => {
        const pairs: [string | null, string | null][] = [
          [output?.name ?? null, output?.nameAr ?? null],
          [output?.description ?? null, output?.descriptionAr ?? null],
        ];
        const bad = pairs.filter(([en, ar]) => {
          const enBad = !!en?.trim() && !noLargeArabicSpan(en);
          const arBad = !!ar?.trim() && (!containsArabic(ar) || !noLargeUntranslatedLatinSpan(ar));
          return enBad || arBad;
        });
        return {
          pass: bad.length === 0,
          reason:
            bad.length === 0
              ? 'EN slots hold Latin, AR slots hold Arabic'
              : `${bad.length} pair(s) have content in the wrong-language slot`,
        };
      },
    },
    {
      name: 'no-data-loss',
      run: (input, output) => {
        const hadName = !!(input.name?.trim() || input.nameAr?.trim());
        const hadDesc = !!(input.description?.trim() || input.descriptionAr?.trim());
        const hasNameAfter = !!(output?.name?.trim() && output?.nameAr?.trim());
        const hasDescAfter = !!(output?.description?.trim() && output?.descriptionAr?.trim());
        const pass = (!hadName || hasNameAfter) && (!hadDesc || hasDescAfter);
        return {
          pass,
          reason: pass
            ? 'both language slots populated where source content existed'
            : 'balance dropped a language slot that had source content',
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'faithfulness',
      instruction:
        'The generated-language slot is a faithful translation of the authoritative slot — no invented content, no meaning drift.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 10. logo-palette — AIService.extractPaletteFromLogo (vision)
// ---------------------------------------------------------------------------

const logoPalette: CriteriaSpec<{ logoUrl: string }, ExtractedPalette> = {
  type: 'logo-palette',
  description:
    'Brand primary/accent/neutral hex colors extracted from a logo image (Gemini Vision)',
  deterministic: [
    {
      name: 'valid-hex-colors',
      run: (_input, output) => {
        const hex = /^#[0-9a-fA-F]{6}$/;
        const pass =
          hex.test(output?.primary ?? '') &&
          hex.test(output?.accent ?? '') &&
          hex.test(output?.neutral ?? '');
        return { pass, reason: 'primary/accent/neutral must be 6-digit hex colors' };
      },
    },
    {
      name: 'not-degenerate-monochrome',
      run: (_input, output) => {
        const same = output?.primary === output?.accent && output?.accent === output?.neutral;
        return {
          pass: !same,
          reason: same
            ? 'all three colors identical — likely a failed extraction'
            : 'colors differentiated',
        };
      },
    },
  ],
  // Vision-derived hex colors — no text for a text-only judge to meaningfully
  // assess. Deterministic shape/degeneracy checks are the whole story here.
  modelJudgeDimensions: [],
};

// ---------------------------------------------------------------------------
// 11. store-faq — bulk-ai-aeo.ts bulkAiFaqAeo
// ---------------------------------------------------------------------------

export interface DraftedFaqLike {
  question: string;
  questionAr: string;
  answer: string;
  answerAr: string;
}
export interface StoreFaqEvalInput {
  storeDescription?: string | null;
}

const storeFaq: CriteriaSpec<StoreFaqEvalInput, DraftedFaqLike[]> = {
  type: 'store-faq',
  description: 'Store-level AEO FAQ sweep (shipping/payment/returns/policy)',
  deterministic: [
    {
      name: 'bilingual-fields-present',
      run: (_input, output) => {
        const bad = (output ?? []).filter(
          f =>
            !isNonEmptyString(f?.question) ||
            !isNonEmptyString(f?.answer) ||
            !isNonEmptyString(f?.questionAr) ||
            !isNonEmptyString(f?.answerAr)
        );
        return { pass: bad.length === 0, reason: `${bad.length} FAQ(s) missing a bilingual field` };
      },
    },
    {
      name: 'no-payment-gateway-company-names',
      run: (_input, output) => {
        const bad = (output ?? []).filter(
          f => mentionsPaymentGatewayCompany(f.answer) || mentionsPaymentGatewayCompany(f.answerAr)
        );
        return {
          pass: bad.length === 0,
          reason:
            bad.length === 0
              ? 'no gateway company names leaked'
              : `${bad.length} answer(s) name a payment-gateway company (Tap/MyFatoorah/Hesabe/UPayments) instead of the method`,
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'FAQ answers only state facts consistent with the given store description/categories/payment-methods context — FAIL on invented specifics.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 12. howto-guide — bulk-ai-aeo.ts bulkAiHowtoAeo
// ---------------------------------------------------------------------------

export interface HowToStepLike {
  name: string;
  text: string;
}
export interface DraftedHowToLike {
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  steps: HowToStepLike[];
  stepsAr: HowToStepLike[];
}

const howtoGuide: CriteriaSpec<Record<string, unknown>, DraftedHowToLike[]> = {
  type: 'howto-guide',
  description: 'Store-level AEO HowTo guides',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => {
        const bad = (output ?? []).filter(
          h =>
            !isNonEmptyString(h?.title) ||
            !isNonEmptyString(h?.description) ||
            !Array.isArray(h?.steps) ||
            h.steps.length === 0
        );
        return {
          pass: bad.length === 0,
          reason: `${bad.length} guide(s) missing title/description/steps`,
        };
      },
    },
    {
      name: 'step-count-in-range',
      run: (_input, output) => {
        const bad = (output ?? []).filter(h => h.steps.length < 3 || h.steps.length > 6);
        return {
          pass: bad.length === 0,
          reason: `${bad.length} guide(s) outside the 3-6 step range`,
        };
      },
    },
    {
      name: 'steps-and-stepsAr-aligned',
      run: (_input, output) => {
        const bad = (output ?? []).filter(h => (h.stepsAr ?? []).length !== h.steps.length);
        return {
          pass: bad.length === 0,
          reason: `${bad.length} guide(s) have mismatched steps/stepsAr counts`,
        };
      },
    },
    {
      name: 'every-step-has-name-and-text',
      run: (_input, output) => {
        const bad = (output ?? []).some(h =>
          h.steps.some(s => !isNonEmptyString(s?.name) || !isNonEmptyString(s?.text))
        );
        return {
          pass: !bad,
          reason: bad ? 'a step is missing name or text' : 'every step complete',
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'relevance',
      instruction:
        'Each guide is a genuinely useful process for THIS store type, not generic boilerplate unrelated to e-commerce.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 13. meta-aeo — bulk-ai-aeo.ts bulkAiMetaAeo
// ---------------------------------------------------------------------------

export interface MetaAeoEvalInput {
  kind: 'store' | 'product' | 'category';
  name: string;
  description?: string | null;
}
export interface MetaAeoEvalOutput {
  en: string;
  ar: string;
}

const metaAeo: CriteriaSpec<MetaAeoEvalInput, MetaAeoEvalOutput> = {
  type: 'meta-aeo',
  description: 'Conversational "What is X?" style meta description for AEO',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass: isNonEmptyString(output?.en) && isNonEmptyString(output?.ar),
        reason: 'en and ar must both be non-empty',
      }),
    },
    {
      name: 'within-160-chars',
      run: (_input, output) => ({
        pass: withinLength(output?.en, 160) && withinLength(output?.ar, 160),
        reason: 'both fields must be <= 160 chars',
      }),
    },
    {
      name: 'bilingual-script-correct',
      run: (_input, output) => ({
        pass:
          containsArabic(output?.ar) &&
          noLargeUntranslatedLatinSpan(output?.ar) &&
          noLargeArabicSpan(output?.en),
        reason:
          'ar must contain Arabic script and not be left untranslated; en must not be dominated by Arabic',
      }),
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'The meta description only states facts consistent with the given name/description — FAIL on invented specifics.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 14. llms-txt — bulk-ai-geo.ts bulkAiLlmsTxt
// ---------------------------------------------------------------------------

export interface LlmsTxtEvalInput {
  storeName: string;
  categoryNames: string[];
  productNames: string[];
}

const llmsTxt: CriteriaSpec<LlmsTxtEvalInput, string> = {
  type: 'llms-txt',
  description: 'llms.txt markdown content describing the store for AI crawlers',
  deterministic: [
    {
      name: 'non-empty-and-bounded',
      run: (_input, output) => ({
        pass: isNonEmptyString(output) && withinLength(output, 4000),
        reason: 'llms.txt must be non-empty and <= 4000 chars',
      }),
    },
    {
      name: 'has-markdown-heading',
      run: (_input, output) => ({
        pass: /^#\s/m.test(output ?? ''),
        reason: 'llms.txt must contain at least one # heading',
      }),
    },
    {
      name: 'no-invented-categories',
      run: (input, output) => {
        const text = (output ?? '').toLowerCase();
        const known = (input.categoryNames ?? []).map(c => c.toLowerCase());
        // Soft grounding check: every category NAMED in the store's real
        // list that also appears in the text is fine; we can't prove a
        // NEGATIVE (that no invented category appears) deterministically,
        // so this only guards the cheap case — an empty category list but
        // the output still lists a "Product categories" section with items.
        if (known.length === 0 && /##\s*(product )?categories/i.test(output ?? '')) {
          const catSection = text.split(/##\s*(?:product )?categories/i)[1] ?? '';
          const hasListItem = /^-\s+\S/m.test(catSection.split(/^##/m)[0] ?? '');
          return {
            pass: !hasListItem,
            reason: hasListItem ? 'llms.txt lists categories but the store has none' : 'ok',
          };
        }
        return {
          pass: true,
          reason:
            'n/a (deterministic layer cannot prove no-hallucination for free text; see model-judge grounding)',
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'Every category and product URL/name mentioned appears in the given category/product list input — FAIL if the text references a category or product NOT in the input (hallucinated catalogue content).',
    },
  ],
};

// ---------------------------------------------------------------------------
// 15. citation-copy — bulk-ai-geo.ts bulkAiCitationCopy
// ---------------------------------------------------------------------------

export interface CitationCopyEvalInput {
  productName: string;
  description?: string | null;
}
export interface CitationCopyEvalOutput {
  en: string;
  ar: string;
}

const citationCopy: CriteriaSpec<CitationCopyEvalInput, CitationCopyEvalOutput> = {
  type: 'citation-copy',
  description: 'LLM-citation-optimised product description rewrite (GEO)',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass: isNonEmptyString(output?.en) && isNonEmptyString(output?.ar),
        reason: 'en and ar must both be non-empty',
      }),
    },
    {
      name: 'within-500-chars',
      run: (_input, output) => ({
        pass: withinLength(output?.en, 500) && withinLength(output?.ar, 500),
        reason: 'both fields must be <= 500 chars',
      }),
    },
    {
      name: 'bilingual-script-correct',
      run: (_input, output) => ({
        pass:
          containsArabic(output?.ar) &&
          noLargeUntranslatedLatinSpan(output?.ar) &&
          noLargeArabicSpan(output?.en),
        reason:
          'ar must contain Arabic script and not be left untranslated; en must not be dominated by Arabic',
      }),
    },
    {
      name: 'no-invented-numeric-specs',
      run: (input, output) => {
        const bad = hasInventedNumericSpec(output?.en, input?.description ?? '');
        return {
          pass: !bad,
          reason: bad
            ? 'citation copy states a numeric size/weight/capacity/% not present in the product description'
            : 'no invented numeric specs',
        };
      },
    },
  ],
  // NOTE: unlike product-faq, citation-copy is DESIGNED to restate/elaborate
  // the description (it's a citation-optimised rewrite of it), so token-
  // overlap duplication is expected, not a defect — grounding (no INVENTED
  // facts beyond the description) is the real risk here, checked by the
  // model judge below. bulk-ai-citation-copy's prompt currently has NO
  // explicit anti-hallucination rule (unlike product-faq-generator's
  // post-2026-07-10 grounding rules) — this dimension is the harness's only
  // guard against the same defect class recurring here.
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'The citation copy states ONLY facts present in the given product name/description — FAIL if it invents a size, material, spec, or attribute not present in the input. This prompt has no explicit anti-hallucination instruction today, so treat any invented specific as a hard fail.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 16. brand-facts — bulk-ai-geo.ts bulkAiBrandFacts
// ---------------------------------------------------------------------------

export interface BrandFactsEvalInput {
  categoryNames: string[];
  hasEmail: boolean;
  hasPhone: boolean;
}
export interface BrandFactsEvalOutput {
  location?: string;
  keyCategories?: string[];
  languages?: string[];
  contactMethods?: string[];
  region?: string;
  currency?: string;
}

const brandFacts: CriteriaSpec<BrandFactsEvalInput, BrandFactsEvalOutput> = {
  type: 'brand-facts',
  description: 'Structured Organization JSON-LD brand facts (GEO)',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass: !!output && typeof output === 'object',
        reason: 'brand-facts output must be an object',
      }),
    },
    {
      name: 'key-categories-drawn-from-input',
      run: (input, output) => {
        const known = new Set((input.categoryNames ?? []).map(c => c.toLowerCase()));
        const kc = output?.keyCategories ?? [];
        if (known.size === 0)
          return {
            pass: kc.length === 0,
            reason:
              kc.length === 0
                ? 'no categories to draw from, none returned'
                : 'store has no categories but keyCategories is non-empty',
          };
        const invented = kc.filter(c => !known.has((c ?? '').toLowerCase()));
        return {
          pass: invented.length === 0,
          reason:
            invented.length === 0
              ? 'keyCategories drawn from real categories'
              : `${invented.length} invented categor(y/ies): ${invented.join(', ')}`,
        };
      },
    },
    {
      name: 'contact-methods-not-invented',
      run: (input, output) => {
        const cm = (output?.contactMethods ?? []).map(c => c.toLowerCase());
        const badEmail = cm.includes('email') && !input.hasEmail;
        const badPhone = cm.some(c => c.includes('phone')) && !input.hasPhone;
        return {
          pass: !badEmail && !badPhone,
          reason:
            badEmail || badPhone
              ? 'contactMethods lists a channel not provided in the input'
              : 'contact methods consistent with input',
        };
      },
    },
  ],
  modelJudgeDimensions: [],
};

// ---------------------------------------------------------------------------
// 17. product-recommendations — bulk-ai-recommendations.ts
// ---------------------------------------------------------------------------

export interface RecommendationEvalInput {
  sourceProductId: string;
  candidateIds: string[];
}
export interface LlmRecLike {
  productId: string;
  score?: number;
  reason?: string;
}

const productRecommendations: CriteriaSpec<RecommendationEvalInput, LlmRecLike[]> = {
  type: 'product-recommendations',
  description: 'Top complementary product picks for cross-sell (catalogue-wide sweep)',
  deterministic: [
    {
      name: 'ids-drawn-from-candidates',
      run: (input, output) => {
        const known = new Set(input.candidateIds ?? []);
        const bad = (output ?? []).filter(r => !known.has(r.productId));
        return {
          pass: bad.length === 0,
          reason:
            bad.length === 0
              ? 'all recs are within the candidate set'
              : `${bad.length} rec(s) reference a product outside the candidate list`,
        };
      },
    },
    {
      name: 'no-self-recommendation',
      run: (input, output) => {
        const bad = (output ?? []).some(r => r.productId === input.sourceProductId);
        return {
          pass: !bad,
          reason: bad ? 'source product recommended to itself' : 'no self-reference',
        };
      },
    },
    {
      name: 'within-max-count',
      run: (_input, output) => ({
        pass: Array.isArray(output) && output.length <= 5,
        reason: 'expected <= 5 recommendations',
      }),
    },
    {
      name: 'no-duplicate-recommendations',
      run: (_input, output) => {
        const dup = hasCaseInsensitiveDuplicates((output ?? []).map(r => r.productId));
        return {
          pass: !dup,
          reason: dup ? 'duplicate productId in recommendations' : 'recommendations unique',
        };
      },
    },
    {
      name: 'score-in-range',
      run: (_input, output) => {
        const bad = (output ?? []).filter(
          r => r.score !== undefined && (r.score < 0 || r.score > 1)
        );
        return { pass: bad.length === 0, reason: `${bad.length} rec(s) have score outside [0,1]` };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'relevance',
      instruction:
        'Recommendations are genuine cross-sell complements (accessories, consumables, bundle items) — FAIL if a pick is a near-duplicate/substitute of the source product rather than a complement.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 18. review-translation — review-tools.ts translateReview
// ---------------------------------------------------------------------------

export interface ReviewTranslationEvalInput {
  body: string;
  language: 'en' | 'ar';
}
export interface ReviewTranslationEvalOutput {
  translated: string;
}

const reviewTranslation: CriteriaSpec<ReviewTranslationEvalInput, ReviewTranslationEvalOutput> = {
  type: 'review-translation',
  description: 'Customer review translated to the opposite language',
  deterministic: [
    {
      name: 'non-empty',
      run: (_input, output) => ({
        pass: isNonEmptyString(output?.translated),
        reason: 'translated must be non-empty',
      }),
    },
    {
      name: 'target-script-correct',
      run: (input, output) => {
        const t = output?.translated ?? '';
        const pass =
          input.language === 'ar'
            ? noLargeArabicSpan(t)
            : containsArabic(t) && noLargeUntranslatedLatinSpan(t);
        return {
          pass,
          reason:
            input.language === 'ar'
              ? 'ar review -> en translation must not be dominated by Arabic'
              : 'en review -> ar translation must contain Arabic script and not be left untranslated',
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'tone-preserved',
      instruction:
        'The translation preserves the original tone and does NOT soften criticism in a negative review — FAIL if negative sentiment is watered down.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 19. review-spam-detection — review-tools.ts detectSpamReview
// ---------------------------------------------------------------------------

export interface ReviewSpamEvalInput {
  body: string;
  rating: number;
}

const reviewSpamDetection: CriteriaSpec<ReviewSpamEvalInput, SpamCheckResult> = {
  type: 'review-spam-detection',
  description: 'Spam/fraud score + recommended moderation status for a review',
  deterministic: [
    {
      name: 'score-in-range',
      run: (_input, output) => ({
        pass:
          typeof output?.spamScore === 'number' && output.spamScore >= 0 && output.spamScore <= 1,
        reason: 'spamScore must be within [0,1]',
      }),
    },
    {
      name: 'status-matches-score-mapping',
      run: (_input, output) => {
        const s = output?.spamScore ?? 0;
        const expected = s >= 0.7 ? 'spam' : s >= 0.3 ? 'pending' : 'published';
        return {
          pass: output?.recommendedStatus === expected,
          reason: `recommendedStatus must follow the code's score mapping (expected "${expected}", got "${output?.recommendedStatus}")`,
        };
      },
    },
    {
      name: 'reasons-is-string-array',
      run: (_input, output) => ({
        pass: Array.isArray(output?.reasons) && output.reasons.every(r => typeof r === 'string'),
        reason: 'reasons must be an array of strings',
      }),
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'reasonableness',
      instruction:
        'The spam score plausibly reflects the actual content of the review (genuine reviews score low, generic/promotional/abusive text scores high).',
    },
  ],
};

// ---------------------------------------------------------------------------
// 20. review-summary — review-tools.ts summarizeProductReviews
// ---------------------------------------------------------------------------

export interface ReviewSummaryEvalInput {
  reviews: { rating: number; body: string }[];
}

const reviewSummary: CriteriaSpec<ReviewSummaryEvalInput, Omit<ReviewSummary, 'reviewCount'>> = {
  type: 'review-summary',
  description: "Top positive/negative themes + overall sentiment across a product's reviews",
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass:
          Array.isArray(output?.topPositives) &&
          Array.isArray(output?.topNegatives) &&
          ['positive', 'mixed', 'negative'].includes(output?.overallSentiment as string),
        reason:
          'topPositives/topNegatives must be arrays; overallSentiment must be a valid enum value',
      }),
    },
    {
      name: 'themes-are-short-phrases',
      run: (_input, output) => {
        const all = [...(output?.topPositives ?? []), ...(output?.topNegatives ?? [])];
        const bad = all.filter(t => (t ?? '').length > 80);
        return {
          pass: bad.length === 0,
          reason: `${bad.length} theme(s) exceed 80 chars (should be short phrases, not sentences)`,
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'grounding',
      instruction:
        'Every theme genuinely reflects content present in the given reviews — FAIL if a theme is invented or not traceable to at least one review.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 21. review-owner-response — review-tools.ts draftOwnerResponse
// ---------------------------------------------------------------------------

export interface ReviewOwnerResponseEvalInput {
  storeName: string;
  rating: number;
  body: string;
}

const reviewOwnerResponse: CriteriaSpec<ReviewOwnerResponseEvalInput, OwnerResponseDraft> = {
  type: 'review-owner-response',
  description: 'Draft merchant reply to a customer review (bilingual)',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass: isNonEmptyString(output?.en) && isNonEmptyString(output?.ar),
        reason: 'en and ar must both be non-empty',
      }),
    },
    {
      name: 'within-reasonable-length',
      run: (_input, output) => ({
        pass: withinLength(output?.en, 600) && withinLength(output?.ar, 600),
        reason: 'response should stay concise (<= 600 chars)',
      }),
    },
    {
      name: 'bilingual-script-correct',
      run: (_input, output) => ({
        pass:
          containsArabic(output?.ar) &&
          noLargeUntranslatedLatinSpan(output?.ar) &&
          noLargeArabicSpan(output?.en),
        reason:
          'ar must contain Arabic script and not be left untranslated; en must not be dominated by Arabic',
      }),
    },
    {
      name: 'signs-off-with-store-name',
      run: (input, output) => {
        const mentioned =
          (output?.en ?? '').toLowerCase().includes((input.storeName ?? '').toLowerCase()) ||
          (output?.ar ?? '').includes(input.storeName ?? '');
        return {
          pass: mentioned || !input.storeName,
          reason: mentioned
            ? 'store name present'
            : 'response does not sign off with the store name',
        };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'tone-matches-rating',
      instruction:
        'A high-rating review gets a genuinely thankful tone; a low-rating review gets an empathetic tone that offers to make it right — FAIL if the tone mismatches the review sentiment.',
    },
  ],
};

// ---------------------------------------------------------------------------
// 22. expense-ocr — apps/api/src/services/accounting/expense-ocr.service.ts
// Vision extraction of a receipt/invoice into structured accounting data. This
// is the one AI feature that touches money end-to-end, so its deterministic
// layer enforces arithmetic + format integrity (a wrong total / invented line
// item / bad currency is caught offline, without the source image); the judge
// layer covers image-grounded hallucination (nightly).
// ---------------------------------------------------------------------------

/** Structural shape of expense-ocr output (mirrors OcrReceiptResult in the service). */
interface OcrEvalOutput {
  vendor: string | null;
  vendorAr: string | null;
  invoiceDate: string | null;
  currency: string;
  subtotal: number | null;
  taxAmount: number | null;
  total: number | null;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; lineTotal: number }>;
  category: string;
  confidence: number;
}

/** Money-tolerant equality: absolute 0.05 OR 1% of the larger magnitude (receipt rounding). */
function moneyApproxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.05, 0.01 * Math.max(Math.abs(a), Math.abs(b)));
}
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const expenseOcr: CriteriaSpec<{ receiptUrl?: string }, OcrEvalOutput> = {
  type: 'expense-ocr',
  description: 'Vision OCR of a receipt/invoice into structured accounting fields',
  deterministic: [
    {
      name: 'shape-valid',
      run: (_input, output) => ({
        pass:
          isNonEmptyString(output?.currency) &&
          isFiniteNum(output?.confidence) &&
          Array.isArray(output?.lineItems),
        reason: 'currency (string), confidence (number) and lineItems (array) are required',
      }),
    },
    {
      name: 'currency-iso-code',
      run: (_input, output) => ({
        pass: typeof output?.currency === 'string' && /^[A-Z]{3}$/.test(output.currency),
        reason: 'currency must be a 3-letter uppercase ISO code (e.g. KWD)',
      }),
    },
    {
      name: 'confidence-in-range',
      run: (_input, output) => ({
        pass: isFiniteNum(output?.confidence) && output.confidence >= 0 && output.confidence <= 1,
        reason: 'confidence must be a number in [0, 1]',
      }),
    },
    {
      name: 'amounts-non-negative',
      run: (_input, output) => {
        const vals = [output?.subtotal, output?.taxAmount, output?.total];
        const bad = vals.some(v => v != null && (!isFiniteNum(v) || v < 0));
        return {
          pass: !bad,
          reason: 'subtotal/taxAmount/total, when present, must be finite and >= 0',
        };
      },
    },
    {
      name: 'total-reconciles',
      run: (_input, output) => {
        // Only assert when all three are present; a receipt missing a field can't be reconciled.
        if (
          !isFiniteNum(output?.subtotal) ||
          !isFiniteNum(output?.taxAmount) ||
          !isFiniteNum(output?.total)
        ) {
          return {
            pass: true,
            reason: 'not all of subtotal/tax/total present — reconciliation skipped',
          };
        }
        const ok = moneyApproxEqual(
          output.total,
          (output.subtotal as number) + (output.taxAmount as number)
        );
        return {
          pass: ok,
          reason: 'total must equal subtotal + taxAmount (within rounding tolerance)',
        };
      },
    },
    {
      name: 'line-items-reconcile',
      run: (_input, output) => {
        const items = output?.lineItems ?? [];
        if (items.length === 0)
          return { pass: true, reason: 'no line items — reconciliation skipped' };
        const target = isFiniteNum(output?.subtotal)
          ? (output.subtotal as number)
          : isFiniteNum(output?.total)
            ? (output.total as number)
            : null;
        if (target == null) return { pass: true, reason: 'no subtotal/total to reconcile against' };
        const sum = items.reduce((s, li) => s + (isFiniteNum(li?.lineTotal) ? li.lineTotal : 0), 0);
        return {
          pass: moneyApproxEqual(sum, target),
          reason: 'sum of line-item lineTotals must match subtotal (or total) within tolerance',
        };
      },
    },
    {
      name: 'line-item-internal-consistency',
      run: (_input, output) => {
        const items = output?.lineItems ?? [];
        const bad = items.find(
          li =>
            isFiniteNum(li?.quantity) &&
            isFiniteNum(li?.unitPrice) &&
            isFiniteNum(li?.lineTotal) &&
            !moneyApproxEqual(li.lineTotal, li.quantity * li.unitPrice)
        );
        return {
          pass: !bad,
          reason: 'each line item lineTotal must equal quantity x unitPrice (within tolerance)',
        };
      },
    },
    {
      name: 'vendor-not-placeholder',
      run: (_input, output) => ({
        // null vendor is allowed (genuinely not visible); a present vendor must be real content.
        pass: output?.vendor == null || !isPlaceholder(output.vendor),
        reason: 'a present vendor must not be placeholder/degenerate text',
      }),
    },
    {
      name: 'invoice-date-valid',
      run: (_input, output) => {
        if (output?.invoiceDate == null) return { pass: true, reason: 'no invoice date — skipped' };
        const ok =
          /^\d{4}-\d{2}-\d{2}/.test(output.invoiceDate) &&
          !Number.isNaN(Date.parse(output.invoiceDate));
        return { pass: ok, reason: 'invoiceDate, when present, must be a valid ISO 8601 date' };
      },
    },
  ],
  modelJudgeDimensions: [
    {
      name: 'vendor-grounded',
      instruction:
        'The extracted vendor name must actually appear on the receipt image — FAIL if the vendor was invented or guessed.',
    },
    {
      name: 'amounts-grounded',
      instruction:
        'The total, subtotal and tax must match the figures printed on the receipt — FAIL if any amount was misread or fabricated.',
    },
    {
      name: 'no-fabricated-line-items',
      instruction:
        'Every line item must correspond to an item printed on the receipt — FAIL if any line item is not on the receipt.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const AI_OUTPUT_CRITERIA: Record<AiOutputType, CriteriaSpec<any, any>> = {
  'product-faq': productFaq,
  'product-excerpt': productExcerpt,
  'product-alt-text': productAltText,
  'product-category-suggestion': productCategorySuggestion,
  'product-tags': productTags,
  translation,
  'seo-meta': seoMeta,
  'section-copy': sectionCopy,
  'description-balance': descriptionBalance,
  'logo-palette': logoPalette,
  'store-faq': storeFaq,
  'howto-guide': howtoGuide,
  'meta-aeo': metaAeo,
  'llms-txt': llmsTxt,
  'citation-copy': citationCopy,
  'brand-facts': brandFacts,
  'product-recommendations': productRecommendations,
  'review-translation': reviewTranslation,
  'review-spam-detection': reviewSpamDetection,
  'review-summary': reviewSummary,
  'review-owner-response': reviewOwnerResponse,
  'expense-ocr': expenseOcr,
};

export function getCriteria(type: AiOutputType): CriteriaSpec<any, any> {
  const spec = AI_OUTPUT_CRITERIA[type];
  if (!spec) throw new Error(`No eval criteria registered for AI output type "${type}"`);
  return spec;
}
