/**
 * product-faq-generator prompt — Unit Tests
 *
 * Focus: the accuracy grounding that stops the model inventing a single
 * wrong size/weight (e.g. "200g") when the product actually ships multiple
 * variant options (e.g. Size: 400 Gram / 700 Gram). The prompt must surface
 * the real options as usable facts and instruct the model to use them.
 */
import { describe, it, expect } from 'vitest';
import { buildProductFaqPrompt } from '../../apps/api/src/lib/ai/product-faq-generator';

describe('buildProductFaqPrompt', () => {
  it('renders variant options as usable facts and the size-accuracy rule', () => {
    const prompt = buildProductFaqPrompt({
      storeId: 's1',
      storeName: 'Pecannbee',
      product: {
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
      },
      count: 3,
    });

    // The real options reach the model as facts (the facts-block header,
    // distinct from the accuracy-rule mention of the same phrase).
    expect(prompt).toContain('Available options / variants (these ARE facts you may use):');
    expect(prompt).toContain('700 Gram');
    expect(prompt).toContain('400 Gram');
    // The guard that prevents the "200g" hallucination.
    expect(prompt).toMatch(
      /NEVER state a single size\/weight that is not one of the listed options/
    );
    // The SKU must NEVER be fed to the prompt — no internal codes as "facts".
    expect(prompt).not.toContain('SKU:');
  });

  it('asks for UP TO the count (quality over quantity) and forbids meta/SKU filler', () => {
    const prompt = buildProductFaqPrompt({
      storeId: 's1',
      storeName: 'Pecannbee',
      product: { name: 'PB Dragee', description: 'Pecans.' },
      count: 5,
    });

    // Never forces the model to hit an exact count → no filler padding.
    expect(prompt).toContain('UP TO 5');
    expect(prompt).not.toContain('exactly 5');
    expect(prompt).toMatch(/if fewer than 5 genuinely useful questions exist.*return FEWER/i);
    // No meta/identify/SKU questions.
    expect(prompt).toMatch(/NEVER ask meta or operational questions/i);
    expect(prompt).toMatch(/NEVER mention an SKU, product code, internal ID/i);
  });

  it('omits the facts block entirely for a simple product with no options', () => {
    const prompt = buildProductFaqPrompt({
      storeId: 's1',
      storeName: 'Pecannbee',
      product: {
        name: 'Gift Card',
        description: 'A digital gift card.',
      },
      count: 3,
    });

    // The facts-block header must be absent — only the always-present
    // accuracy-rule mention of the phrase may remain.
    expect(prompt).not.toContain('(these ARE facts you may use):');
  });
});
