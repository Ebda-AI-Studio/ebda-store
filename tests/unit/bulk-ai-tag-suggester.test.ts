/**
 * product-tag-suggester — Unit Tests
 *
 * Covers: caps suggestions at MAX_TAGS_PER_PRODUCT, de-duplicates
 * case-insensitively, drops non-string/empty entries, and throws on
 * malformed Gemini output.
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
  suggestProductTags,
  MAX_TAGS_PER_PRODUCT,
} from '../../apps/api/src/lib/ai/product-tag-suggester';

function respond(text: string) {
  return { response: { text: () => text } };
}

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe('suggestProductTags', () => {
  it('returns the suggested tag list, trimmed', async () => {
    mockGenerateContent.mockResolvedValue(
      respond(JSON.stringify({ tags: [' cotton ', 'summer', 'best-seller'] }))
    );

    const result = await suggestProductTags(
      {
        storeName: 'Test Store',
        product: { name: 'Tee', description: 'cotton tee' },
        existingTagNames: [],
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result).toEqual(['cotton', 'summer', 'best-seller']);
  });

  it('de-duplicates suggestions case-insensitively', async () => {
    mockGenerateContent.mockResolvedValue(
      respond(JSON.stringify({ tags: ['Cotton', 'cotton', 'COTTON', 'summer'] }))
    );

    const result = await suggestProductTags(
      {
        storeName: 'Test Store',
        product: { name: 'Tee', description: null },
        existingTagNames: [],
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result).toEqual(['Cotton', 'summer']);
  });

  it('caps the result at MAX_TAGS_PER_PRODUCT', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ tags: many })));

    const result = await suggestProductTags(
      {
        storeName: 'Test Store',
        product: { name: 'Tee', description: null },
        existingTagNames: [],
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result.length).toBe(MAX_TAGS_PER_PRODUCT);
  });

  it('drops non-string and empty entries', async () => {
    mockGenerateContent.mockResolvedValue(
      respond(JSON.stringify({ tags: ['valid', '', '   ', 42, null, 'another'] }))
    );

    const result = await suggestProductTags(
      {
        storeName: 'Test Store',
        product: { name: 'Tee', description: null },
        existingTagNames: [],
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result).toEqual(['valid', 'another']);
  });

  it('throws when the response is missing the tags array', async () => {
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ foo: 'bar' })));

    await expect(
      suggestProductTags(
        {
          storeName: 'Test Store',
          product: { name: 'Tee', description: null },
          existingTagNames: [],
        },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI returned unexpected format');
  });
});
