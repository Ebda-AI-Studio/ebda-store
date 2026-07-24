import type { KnownFailureCase } from '../types';
import { productFaqDuplicatesDescription } from './product-faq-duplicates-description';
import { productFaqInventsNumericSpec } from './product-faq-invents-numeric-spec';
import { productExcerptExceedsLength } from './product-excerpt-exceeds-length';
import { productAltTextJustProductName } from './product-alt-text-just-product-name';
import { productCategoryInventsId } from './product-category-invents-id';
import { productTagsDuplicateAndEmpty } from './product-tags-duplicate-and-empty';
import { seoMetaTooLongAndPriceClaim } from './seo-meta-too-long-and-price-claim';
import { storeFaqNamesGatewayCompany } from './store-faq-names-gateway-company';
import { howtoGuideStepCountOutOfRange } from './howto-guide-step-count-out-of-range';
import { citationCopyInventedSpecAndTooLong } from './citation-copy-invented-spec-and-too-long';
import { productRecommendationsSelfAndDuplicate } from './product-recommendations-self-and-duplicate';
import { reviewSpamStatusMismatch } from './review-spam-status-mismatch';
import { reviewSummaryThemeTooLong } from './review-summary-theme-too-long';
import { descriptionBalanceWrongLanguageSlot } from './description-balance-wrong-language-slot';
import { translationWrongTargetScript } from './translation-wrong-target-script';
import { expenseOcrTotalMismatch } from './expense-ocr-total-mismatch';
import { expenseOcrBadCurrencyAndLineItem } from './expense-ocr-bad-currency-and-lineitem';

/**
 * Every known real-or-realistic regression case, across every AI output
 * type that has at least one. Each MUST fail its `expectedFailedChecks`.
 *
 * To add a new one: create `<slug>.ts` in this directory exporting a
 * single `KnownFailureCase`, then add one import + one array entry here.
 */
export const KNOWN_FAILURE_CASES: KnownFailureCase[] = [
  productFaqDuplicatesDescription,
  productFaqInventsNumericSpec,
  productExcerptExceedsLength,
  productAltTextJustProductName,
  productCategoryInventsId,
  productTagsDuplicateAndEmpty,
  seoMetaTooLongAndPriceClaim,
  storeFaqNamesGatewayCompany,
  howtoGuideStepCountOutOfRange,
  citationCopyInventedSpecAndTooLong,
  productRecommendationsSelfAndDuplicate,
  reviewSpamStatusMismatch,
  reviewSummaryThemeTooLong,
  descriptionBalanceWrongLanguageSlot,
  translationWrongTargetScript,
  expenseOcrTotalMismatch,
  expenseOcrBadCurrencyAndLineItem,
];
