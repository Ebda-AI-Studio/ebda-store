import { describe, it, expect } from 'vitest';
import {
  isNonEmptyString,
  isPlaceholder,
  withinLength,
  noLargeArabicSpan,
  noLargeUntranslatedLatinSpan,
  tokenOverlapRatio,
  hasCaseInsensitiveDuplicates,
  mentionsPaymentGatewayCompany,
  mentionsPriceOrStockClaim,
  extractNumericSpecTokens,
  hasInventedNumericSpec,
} from '../../apps/api/src/lib/ai/eval/helpers';

describe('ai-eval helpers', () => {
  it('isNonEmptyString', () => {
    expect(isNonEmptyString('hi')).toBe(true);
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
  });

  it('isPlaceholder', () => {
    expect(isPlaceholder('N/A')).toBe(true);
    expect(isPlaceholder('TODO')).toBe(true);
    expect(isPlaceholder('...')).toBe(true);
    expect(isPlaceholder('[insert text]')).toBe(true);
    expect(isPlaceholder('')).toBe(true);
    expect(isPlaceholder('A real ceramic mug')).toBe(false);
  });

  it('withinLength', () => {
    expect(withinLength('short', 10)).toBe(true);
    expect(withinLength('this is way too long', 10)).toBe(false);
  });

  it('noLargeArabicSpan flags long Arabic runs in an EN-expected field', () => {
    expect(noLargeArabicSpan('Handmade Ceramic Mug')).toBe(true);
    expect(noLargeArabicSpan('كوب سيراميك يدوي الصنع بجودة عالية')).toBe(false);
    // short transliterated brand fragment is fine
    expect(noLargeArabicSpan('Mug (كوب)')).toBe(true);
  });

  it('noLargeUntranslatedLatinSpan flags long English runs in an AR-expected field', () => {
    expect(noLargeUntranslatedLatinSpan('كوب سيراميك')).toBe(true);
    expect(noLargeUntranslatedLatinSpan('This entire sentence was never translated at all')).toBe(
      false
    );
  });

  it('tokenOverlapRatio: high overlap for a near-verbatim restatement', () => {
    const desc = 'A 100% cotton crew-neck t-shirt, machine washable, available in navy blue.';
    const restated =
      'This is a 100% cotton crew-neck t-shirt that is machine washable and available in navy blue.';
    expect(tokenOverlapRatio(restated, desc)).toBeGreaterThan(0.6);
  });

  it('tokenOverlapRatio: low overlap for genuinely new content', () => {
    const desc = 'A handmade ceramic mug, dishwasher safe, holds 350ml.';
    const newInfo = 'Delivery within Kuwait takes 2-4 business days from order confirmation.';
    expect(tokenOverlapRatio(newInfo, desc)).toBeLessThan(0.3);
  });

  it('tokenOverlapRatio: 0 when either side is empty', () => {
    expect(tokenOverlapRatio('', 'something')).toBe(0);
    expect(tokenOverlapRatio('something', null)).toBe(0);
  });

  it('hasCaseInsensitiveDuplicates', () => {
    expect(hasCaseInsensitiveDuplicates(['Handmade', 'ceramic', 'handmade'])).toBe(true);
    expect(hasCaseInsensitiveDuplicates(['handmade', 'ceramic', 'mug'])).toBe(false);
  });

  it('mentionsPaymentGatewayCompany', () => {
    expect(mentionsPaymentGatewayCompany('We use MyFatoorah to process payments.')).toBe(true);
    expect(mentionsPaymentGatewayCompany('We accept KNET, Visa, and Mastercard.')).toBe(false);
  });

  it('mentionsPriceOrStockClaim', () => {
    expect(mentionsPriceOrStockClaim('Only 3 KWD, order now!')).toBe(true);
    expect(mentionsPriceOrStockClaim('Currently out of stock.')).toBe(true);
    expect(mentionsPriceOrStockClaim('A handmade ceramic mug.')).toBe(false);
  });

  it('extractNumericSpecTokens', () => {
    expect(extractNumericSpecTokens('Holds 350ml and weighs 200g.')).toEqual(['350ml', '200g']);
    expect(extractNumericSpecTokens('A handmade mug.')).toEqual([]);
  });

  it('hasInventedNumericSpec: flags a spec not present in the reference', () => {
    expect(hasInventedNumericSpec('The bowl weighs 450g.', 'A hand-glazed ceramic bowl.')).toBe(
      true
    );
  });

  it('hasInventedNumericSpec: allows a spec that IS present in the reference', () => {
    expect(hasInventedNumericSpec('Holds 350ml.', 'A ceramic mug, holds 350ml.')).toBe(false);
  });

  it('hasInventedNumericSpec: false when the answer has no numeric spec at all', () => {
    expect(hasInventedNumericSpec('A lovely mug for your kitchen.', 'A ceramic mug.')).toBe(false);
  });
});
