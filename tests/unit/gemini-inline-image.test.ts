/**
 * Images sent to Gemini Vision inline (logo palette, product alt text). Without `sharp`
 * (it cannot load on workerd) there is no rasterizing: a type Gemini accepts is passed through,
 * anything else is refused with a typed error the callers map to a clear failure.
 */
import { describe, it, expect } from 'vitest';
import { geminiInlineImage, GeminiImageUnsupported } from '@api/lib/ai/gemini-image';

describe('geminiInlineImage', () => {
  it('passes a supported type through as base64', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(geminiInlineImage(buf, 'image/png')).toEqual({ data: 'AQID', mimeType: 'image/png' });
    expect(geminiInlineImage(buf, 'image/jpeg; charset=binary').mimeType).toBe('image/jpeg');
  });
  it('refuses GIF, SVG and unknown types with GeminiImageUnsupported', () => {
    for (const t of ['image/gif', 'image/svg+xml', 'application/octet-stream', '']) {
      expect(() => geminiInlineImage(Buffer.from([1]), t)).toThrow(GeminiImageUnsupported);
    }
  });
});
