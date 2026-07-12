/**
 * faq-grounding-validator — Unit Tests
 *
 * The deterministic guard that drops FAQ answers asserting a measurement
 * (number + weight/volume/length unit) not present in the product's known
 * facts. Covers the "200g when the product is 400/700 Gram" hallucination in
 * both English and Arabic, and confirms non-measurement numbers (days, packs,
 * price) and correctly-grounded measurements are NOT dropped.
 */
import { describe, it, expect } from 'vitest';
import {
  validateFaqGrounding,
  extractMeasurements,
} from '../../apps/api/src/lib/ai/faq-grounding-validator';

const sizedProduct = {
  name: 'PB Dragee Pecan Caramel',
  nameAr: 'بي بي دراجيه بيكان كراميل',
  description: 'Roasted pecans in a peanut-butter caramel shell.',
  options: [
    {
      name: 'Size',
      nameAr: 'الحجم',
      values: [
        { value: '700 Gram', valueAr: '٧٠٠ جرام' },
        { value: '400 Gram', valueAr: '٤٠٠ جرام' },
      ],
    },
  ],
};

const faq = (answer: string, answerAr = '') => ({
  question: 'q?',
  answer,
  answerAr,
});

describe('extractMeasurements', () => {
  it('extracts number+unit tokens, ignores unit-less numbers', () => {
    const m = extractMeasurements('Ships in 2-3 days. Net weight 400 g. Price 5 KWD.');
    expect(m.has('400:g')).toBe(true);
    expect(m.has('2:g')).toBe(false); // "days" is not a unit
    expect(m.has('5:g')).toBe(false); // KWD is not a measurement unit
  });

  it('normalizes Arabic-Indic digits and Arabic units', () => {
    const m = extractMeasurements('الوزن ٤٠٠ جرام');
    expect(m.has('400:g')).toBe(true);
  });

  it('does NOT treat the preposition "in" as inches (false-positive guard)', () => {
    const m = extractMeasurements('Only 3 in stock, available in 2 sizes.');
    expect(m.has('3:in')).toBe(false);
    expect(m.has('2:in')).toBe(false);
    // spelled-out inches still count
    expect(extractMeasurements('12 inches long').has('12:in')).toBe(true);
  });
});

describe('validateFaqGrounding', () => {
  it('drops an English answer inventing a weight (200g) not in the options', () => {
    const { kept, dropped } = validateFaqGrounding(
      [faq('Each jar has a net weight of 200g.')],
      sizedProduct
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].offending).toContain('200:g');
  });

  it('drops an Arabic answer inventing a weight (٢٠٠ جرام)', () => {
    const { kept, dropped } = validateFaqGrounding([faq('', 'وزن العبوة ٢٠٠ جرام.')], sizedProduct);
    expect(kept).toHaveLength(0);
    expect(dropped[0].offending).toContain('200:g');
  });

  it('keeps an answer that cites the real option sizes', () => {
    const { kept, dropped } = validateFaqGrounding(
      [faq('It comes in 400 Gram and 700 Gram sizes.', 'يتوفر بحجم ٤٠٠ جرام و٧٠٠ جرام.')],
      sizedProduct
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('keeps answers whose numbers carry no measurement unit', () => {
    const { kept } = validateFaqGrounding(
      [
        faq('Delivery takes 2-3 business days within Kuwait.'),
        faq('You can order 3 packs or more for a discount.'),
      ],
      sizedProduct
    );
    expect(kept).toHaveLength(2);
  });

  it('grounds measurements found in the description, not only options', () => {
    const { kept } = validateFaqGrounding([faq('The bottle holds 500 ml.')], {
      name: 'Olive Oil',
      description: 'Cold-pressed olive oil, 500 ml bottle.',
    });
    expect(kept).toHaveLength(1);
  });
});
