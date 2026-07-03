/**
 * product-alt-text-generator — Unit Tests
 *
 * Covers the Gemini-Vision alt-text generator: fetch failure surfaces as a
 * thrown error, a successful vision call returns a trimmed/quote-stripped
 * string capped at ALT_TEXT_MAX_LENGTH, and an empty model response throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  generateProductAltText,
  ALT_TEXT_MAX_LENGTH,
} from '../../apps/api/src/lib/ai/product-alt-text-generator';

function respond(text: string) {
  return { response: { text: () => text } };
}

const originalFetch = global.fetch;

beforeEach(() => {
  mockGenerateContent.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('generateProductAltText', () => {
  it('throws when the image fetch fails outright', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      generateProductAltText(
        { imageUrl: 'https://example.com/a.jpg', product: { name: 'T-Shirt' } },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI_IMAGE_FETCH_FAILED');
  });

  it('throws when the image fetch returns a non-OK status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(
      generateProductAltText(
        { imageUrl: 'https://example.com/a.jpg', product: { name: 'T-Shirt' } },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI_IMAGE_FETCH_FAILED');
  });

  it('returns a trimmed, quote-stripped alt string on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    mockGenerateContent.mockResolvedValue(respond('"Blue cotton t-shirt on a hanger"  '));

    const alt = await generateProductAltText(
      { imageUrl: 'https://example.com/a.jpg', product: { name: 'T-Shirt', nameAr: 'قميص' } },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(alt).toBe('Blue cotton t-shirt on a hanger');
  });

  it('caps the returned alt text at ALT_TEXT_MAX_LENGTH', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const longText = 'x'.repeat(ALT_TEXT_MAX_LENGTH + 50);
    mockGenerateContent.mockResolvedValue(respond(longText));

    const alt = await generateProductAltText(
      { imageUrl: 'https://example.com/a.png', product: { name: 'Product' } },
      'fake-key',
      'gemini-flash-lite-latest'
    );

    expect(alt.length).toBe(ALT_TEXT_MAX_LENGTH);
  });

  it('throws when Gemini returns an empty response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    mockGenerateContent.mockResolvedValue(respond('   '));

    await expect(
      generateProductAltText(
        { imageUrl: 'https://example.com/a.jpg', product: { name: 'Product' } },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI returned an empty alt-text response');
  });
});
