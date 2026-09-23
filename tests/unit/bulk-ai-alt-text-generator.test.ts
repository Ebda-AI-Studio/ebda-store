/**
 * product-alt-text-generator — Unit Tests
 *
 * Covers the Gemini-Vision alt-text generator: fetch failure surfaces as a
 * thrown error, a successful vision call returns a trimmed/quote-stripped
 * string capped at ALT_TEXT_MAX_LENGTH, and an empty model response throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The generator fetches through safeFetchImage, whose SSRF guard resolves the
// host with dns.lookup BEFORE any fetch. Stubbing global.fetch alone therefore
// left this "unit" test making a REAL DNS query for example.com: it passed only
// where that resolved, and on the CI guest (DNS down) every success case failed
// as `AI_IMAGE_FETCH_FAILED` thrown from the guard, not from the stub. Mocking
// dns — the same shape carrier-ssrf.test.ts uses — makes the guard deterministic
// and keeps its blocklist ON the path under test instead of bypassing it.
const lookup = vi.fn();
vi.mock('dns', () => ({
  promises: { lookup: (...a: unknown[]) => lookup(...a) },
  default: { promises: { lookup: (...a: unknown[]) => lookup(...a) } },
}));

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
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34' }]); // public, passes the guard
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

  /**
   * Negative control for the SSRF guard on the AI image path.
   *
   * imageUrl is MERCHANT-supplied, so a product image pointing at cloud
   * metadata would otherwise be fetched by the API host and described back to
   * the merchant by Gemini. Every other case here stubs a 200, so swapping
   * safeFetchImage for a bare fetch() leaves them all green — this is the only
   * test that reddens, which is what makes the defence killable and what the
   * `ssrf-ai-image-url` entry in docs/security/defence-mutations.json records.
   *
   * fetch must not merely fail — it must never be CALLED. Asserting on the
   * thrown message alone would also pass if the request left the process and
   * the link-local address simply refused the connection.
   */
  it('refuses a merchant image URL that resolves to cloud metadata', async () => {
    lookup.mockResolvedValue([{ address: '169.254.169.254' }]);
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    global.fetch = fetchSpy;
    mockGenerateContent.mockResolvedValue(respond('metadata leaked'));

    await expect(
      generateProductAltText(
        { imageUrl: 'http://metadata.example/latest/meta-data/', product: { name: 'Product' } },
        'fake-key',
        'gemini-flash-lite-latest'
      )
    ).rejects.toThrow('AI_IMAGE_FETCH_FAILED');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
