/**
 * option-localization — Arabic storefront axis labelling.
 *
 * Focus: the smart, value-driven axis label so the PDP never shows the generic
 * "متغير", and a weight axis reads الوزن (not الحجم) while a garment axis reads
 * المقاس. Merchant-supplied meaningful nameAr still wins.
 */
import { describe, it, expect } from 'vitest';
import {
  localizeOptionName,
  localizeOptionValue,
} from '../../apps/web/src/lib/option-localization';

describe('localizeOptionName (Arabic)', () => {
  const AR = true;

  it('weight values → الوزن even when the axis is named "Size" or stored as متغير', () => {
    expect(localizeOptionName('Size', null, AR, ['400 Gram', '700 Gram'])).toBe('الوزن');
    // the old admin default "متغير" is a generic placeholder → ignored, values win
    expect(localizeOptionName('Variant', 'متغير', AR, ['185 Gram', '1 KG'])).toBe('الوزن');
    expect(localizeOptionName('Weight', null, AR, ['٧٠٠ جرام'])).toBe('الوزن');
  });

  it('volume values → الحجم', () => {
    expect(localizeOptionName('Size', null, AR, ['500 ml', '1 Liter'])).toBe('الحجم');
  });

  it('garment letter-sizes → المقاس', () => {
    expect(localizeOptionName('Size', null, AR, ['S', 'M', 'L', 'XL'])).toBe('المقاس');
  });

  it('never surfaces the placeholder "متغير"', () => {
    // generic name + no value signal → neutral fallback, not متغير
    expect(localizeOptionName('Variant', 'متغير', AR, ['A', 'B'])).not.toBe('متغير');
    expect(localizeOptionName('Variant', 'متغير', AR, ['A', 'B'])).toBe('الخيار');
  });

  it('a MEANINGFUL merchant nameAr still wins', () => {
    expect(localizeOptionName('Flavor', 'النكهة', AR, ['Vanilla'])).toBe('النكهة');
  });

  it('a meaningful English name passes through unchanged on the English store', () => {
    expect(localizeOptionName('Flavor', null, false, ['Vanilla'])).toBe('Flavor');
  });
});

describe('localizeOptionName (English) — same smart logic', () => {
  const EN = false;

  it('weight values → "Weight" even when the axis is the generic "Variant"/"Option"', () => {
    expect(localizeOptionName('Variant', null, EN, ['400 Gram', '700 Gram'])).toBe('Weight');
    expect(localizeOptionName('Option', null, EN, ['1 KG'])).toBe('Weight');
  });

  it('volume → "Size", garment letter-sizes → "Size"', () => {
    expect(localizeOptionName('Variant', null, EN, ['500 ml'])).toBe('Size');
    expect(localizeOptionName('Variant', null, EN, ['S', 'M', 'L'])).toBe('Size');
  });

  it('never surfaces a bare "Variant" — generic + no signal → "Options"', () => {
    expect(localizeOptionName('Variant', null, EN, ['A', 'B'])).toBe('Options');
    expect(localizeOptionName('Option', null, EN, ['A', 'B'])).toBe('Options');
  });
});

/**
 * Issue #657 — "merchant name wins". `detectAxisFromValues` used to run
 * BEFORE the merchant-name branch, so a merchant axis named e.g.
 * nameAr='التعبئة' / name='Pack size' with unit-bearing values like
 * '500 جرام' / '500 Gram' was silently overridden to 'الوزن'/'Weight'. A
 * MEANINGFUL merchant name (non-blank, not in GENERIC_AXIS_NAMES) must now
 * win outright; only a blank or generic name falls through to value
 * detection.
 */
describe('localizeOptionName — merchant name wins over value detection (#657)', () => {
  it('meaningful nameAr + unit-bearing values → nameAr wins (ar locale)', () => {
    expect(localizeOptionName('Pack size', 'التعبئة', true, ['500 جرام', '1 كجم'])).toBe('التعبئة');
  });

  it('meaningful English name + grams → English name wins (en locale)', () => {
    expect(localizeOptionName('Pack size', 'التعبئة', false, ['500 Gram', '1 KG'])).toBe(
      'Pack size'
    );
  });

  it('generic name ("Option", etc.) + grams → value detection still wins → "Weight"/"الوزن"', () => {
    expect(localizeOptionName('Option', 'الخيار', true, ['500 جرام'])).toBe('الوزن');
    expect(localizeOptionName('Option', 'الخيار', false, ['500 Gram'])).toBe('Weight');
  });

  it('blank name + unit-bearing values → value detection wins (name absent is the same as generic)', () => {
    expect(localizeOptionName('', '', true, ['500 جرام'])).toBe('الوزن');
    expect(localizeOptionName('', null, false, ['500 Gram'])).toBe('Weight');
  });
});

describe('localizeOptionValue (Arabic)', () => {
  it('translates unit tokens in place, preserving numbers', () => {
    expect(localizeOptionValue('185 Gram', null, true)).toBe('185 جرام');
    expect(localizeOptionValue('1 KG', null, true)).toBe('1 كجم');
  });
  it('merchant valueAr wins', () => {
    expect(localizeOptionValue('185 Gram', '١٨٥ جرام', true)).toBe('١٨٥ جرام');
  });
});
