/**
 * product-category-suggester — Unit Tests
 *
 * Covers the catalogue-sweep category generator: never invents categories
 * (only returns ids present in `existingCategories`), returns [] when the
 * store has no categories at all, and throws on an unparseable Gemini
 * response.
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

import { suggestProductCategory } from '../../apps/api/src/lib/ai/product-category-suggester';

function respond(text: string) {
  return { response: { text: () => text } };
}

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe('suggestProductCategory', () => {
  it('returns [] immediately without calling Gemini when the store has no categories', async () => {
    const result = await suggestProductCategory(
      {
        storeName: 'Test Store',
        product: { name: 'T-Shirt', description: 'A shirt' },
        existingCategories: [],
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result).toEqual([]);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('returns only matches whose id exists in existingCategories', async () => {
    mockGenerateContent.mockResolvedValue(
      respond(
        JSON.stringify({
          matches: [
            { id: 'cat-1', confidence: 'high' },
            { id: 'cat-does-not-exist', confidence: 'medium' },
          ],
        })
      )
    );

    const result = await suggestProductCategory(
      {
        storeName: 'Test Store',
        product: { name: 'T-Shirt', description: 'A cotton shirt' },
        existingCategories: [
          { id: 'cat-1', name: 'Clothing', nameAr: null },
          { id: 'cat-2', name: 'Shoes', nameAr: null },
        ],
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result).toEqual([{ id: 'cat-1', confidence: 'high' }]);
  });

  it('returns [] when Gemini reports no confident match', async () => {
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ matches: [] })));

    const result = await suggestProductCategory(
      {
        storeName: 'Test Store',
        product: { name: 'Mystery item', description: null },
        existingCategories: [{ id: 'cat-1', name: 'Clothing', nameAr: null }],
      },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(result).toEqual([]);
  });

  it('throws on unparseable / malformed Gemini output', async () => {
    mockGenerateContent.mockResolvedValue(respond('not json at all'));

    await expect(
      suggestProductCategory(
        {
          storeName: 'Test Store',
          product: { name: 'T-Shirt', description: null },
          existingCategories: [{ id: 'cat-1', name: 'Clothing', nameAr: null }],
        },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow();
  });

  it('throws when the JSON is valid but missing the matches array', async () => {
    mockGenerateContent.mockResolvedValue(respond(JSON.stringify({ foo: 'bar' })));

    await expect(
      suggestProductCategory(
        {
          storeName: 'Test Store',
          product: { name: 'T-Shirt', description: null },
          existingCategories: [{ id: 'cat-1', name: 'Clothing', nameAr: null }],
        },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI returned unexpected format');
  });
});
