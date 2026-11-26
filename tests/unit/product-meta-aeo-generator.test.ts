/**
 * product-meta-aeo-generator — Unit Tests
 *
 * Covers the per-product AEO meta-description generator: the prompt
 * grounds on the product name/description/store name (no invented
 * specifics), the happy path returns a trimmed + 160-char-capped
 * bilingual result, a missing Arabic field degrades to an empty string
 * rather than throwing, and malformed/incomplete Gemini output throws.
 *
 * Mirrors tests/unit/bulk-ai-excerpt-generator.test.ts's mock shape.
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

// The generator budgets itself (#838); the quota is not under test here.
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: async () => undefined }));
import {
  buildMetaAeoPrompt,
  generateProductMetaAeo,
} from '../../apps/api/src/lib/ai/product-meta-aeo-generator';

function respond(text: string) {
  return { response: { text: () => text, usageMetadata: undefined } };
}

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe('buildMetaAeoPrompt', () => {
  it('grounds the product prompt in the given name, description, and store name', () => {
    const prompt = buildMetaAeoPrompt(
      'product',
      'Basic Tee',
      'A soft cotton t-shirt.',
      'Test Store'
    );

    expect(prompt).toContain('Product: "Basic Tee"');
    expect(prompt).toContain('From store: "Test Store"');
    expect(prompt).toContain('Product description: A soft cotton t-shirt.');
    expect(prompt).toContain('Both English and Arabic');
  });

  it('falls back to "Not provided." when the product has no description', () => {
    const prompt = buildMetaAeoPrompt('product', 'Basic Tee', '', 'Test Store');
    expect(prompt).toContain('Product description: Not provided.');
  });
});

describe('generateProductMetaAeo', () => {
  it('returns trimmed bilingual AEO meta on success', async () => {
    mockGenerateContent.mockResolvedValue(
      respond(
        JSON.stringify({
          en: '  Basic Tee is a soft cotton t-shirt from Test Store, made for everyday wear.  ',
          ar: '  تي شيرت أساسي هو قميص قطني ناعم من متجر تست، مصمم للارتداء اليومي.  ',
        })
      )
    );

    const result = await generateProductMetaAeo(
      {
        storeId: 'store-1',
        storeName: 'Test Store',
        product: { name: 'Basic Tee', description: 'A soft cotton t-shirt.' },
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result.en).toBe(
      'Basic Tee is a soft cotton t-shirt from Test Store, made for everyday wear.'
    );
    expect(result.ar).toBe('تي شيرت أساسي هو قميص قطني ناعم من متجر تست، مصمم للارتداء اليومي.');
  });

  it('caps both fields at 160 characters', async () => {
    const longEn = 'x'.repeat(200);
    const longAr = 'ي'.repeat(200);
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ en: longEn, ar: longAr })));

    const result = await generateProductMetaAeo(
      {
        storeId: 'store-1',
        storeName: 'Test Store',
        product: { name: 'Product', description: 'desc' },
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result.en.length).toBe(160);
    expect(result.ar.length).toBe(160);
  });

  it('degrades to an empty Arabic string when "ar" is missing', async () => {
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ en: 'A valid English meta.' })));

    const result = await generateProductMetaAeo(
      {
        storeId: 'store-1',
        storeName: 'Test Store',
        product: { name: 'Product', description: 'desc' },
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result.en).toBe('A valid English meta.');
    expect(result.ar).toBe('');
  });

  it('throws when the response is missing the "en" field', async () => {
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ ar: 'فقط عربي' })));

    await expect(
      generateProductMetaAeo(
        {
          storeId: 'store-1',
          storeName: 'Test Store',
          product: { name: 'Product', description: 'desc' },
        },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI returned unexpected format');
  });

  it('throws on unparseable Gemini output', async () => {
    mockGenerateContent.mockResolvedValue(respond('not valid json'));

    await expect(
      generateProductMetaAeo(
        {
          storeId: 'store-1',
          storeName: 'Test Store',
          product: { name: 'Product', description: 'desc' },
        },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow();
  });
});
