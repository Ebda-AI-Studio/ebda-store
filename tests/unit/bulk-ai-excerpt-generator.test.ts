/**
 * product-excerpt-generator — Unit Tests
 *
 * Covers the bilingual excerpt generator: happy path returns trimmed +
 * capped EN/AR strings, and malformed/missing-field Gemini output throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        generateContent: (...args: unknown[]) => mockGenerateContent(...args),
      };
    }
  },
}));

import {
  generateProductExcerpt,
  EXCERPT_MAX_LENGTH,
} from '../../apps/api/src/lib/ai/product-excerpt-generator';

function respond(text: string) {
  return { response: { text: () => text } };
}

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe('generateProductExcerpt', () => {
  it('returns trimmed bilingual excerpt on success', async () => {
    mockGenerateContent.mockResolvedValue(
      respond(
        JSON.stringify({
          excerpt: '  A soft cotton tee for everyday wear.  ',
          excerptAr: '  قميص قطني ناعم للارتداء اليومي.  ',
        })
      )
    );

    const result = await generateProductExcerpt(
      {
        storeName: 'Test Store',
        product: {
          name: 'Basic Tee',
          description: 'A long description about a soft cotton t-shirt suitable for daily wear.',
        },
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result.excerpt).toBe('A soft cotton tee for everyday wear.');
    expect(result.excerptAr).toBe('قميص قطني ناعم للارتداء اليومي.');
  });

  it('caps both excerpt fields at EXCERPT_MAX_LENGTH', async () => {
    const longEn = 'x'.repeat(EXCERPT_MAX_LENGTH + 100);
    const longAr = 'ي'.repeat(EXCERPT_MAX_LENGTH + 100);
    mockGenerateContent.mockResolvedValue(
      respond(JSON.stringify({ excerpt: longEn, excerptAr: longAr }))
    );

    const result = await generateProductExcerpt(
      { storeName: 'Test Store', product: { name: 'Product', description: 'desc' } },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result.excerpt.length).toBe(EXCERPT_MAX_LENGTH);
    expect(result.excerptAr.length).toBe(EXCERPT_MAX_LENGTH);
  });

  it('throws when the response is missing the excerpt fields', async () => {
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ foo: 'bar' })));

    await expect(
      generateProductExcerpt(
        { storeName: 'Test Store', product: { name: 'Product', description: 'desc' } },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI returned unexpected format');
  });

  it('throws on unparseable Gemini output', async () => {
    mockGenerateContent.mockResolvedValue(respond('not valid json'));

    await expect(
      generateProductExcerpt(
        { storeName: 'Test Store', product: { name: 'Product', description: 'desc' } },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow();
  });
});
