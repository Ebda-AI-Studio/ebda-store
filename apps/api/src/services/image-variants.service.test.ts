import { describe, it, expect, vi, beforeEach } from 'vitest';

const put = vi.fn();
vi.mock('./storage.service', () => ({
  StorageService: { putVariant: (...a: unknown[]) => put(...a), listByPrefix: vi.fn() },
}));
vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

import { generateImageVariants } from './image-variants.service';
import type { ImagesBindingLike } from '../lib/images/icon-resizer';

const fakeImages = (fail = false): ImagesBindingLike => ({
  input: () => {
    const t = {
      transform: () => t,
      output: async () => {
        if (fail) throw new Error('boom');
        return { response: () => new Response(new Uint8Array([1, 2, 3])) };
      },
    };
    return t as never;
  },
});

describe('generateImageVariants', () => {
  beforeEach(() => put.mockReset());

  it('writes the three WebP widths next to the original', async () => {
    const n = await generateImageVariants(
      'stores/s/products/a.png',
      Buffer.from('x'),
      fakeImages()
    );
    expect(n).toBe(3);
    expect(put.mock.calls.map(c => c[0])).toEqual([
      'stores/s/products/a.w480.webp',
      'stores/s/products/a.w960.webp',
      'stores/s/products/a.w1600.webp',
    ]);
  });
  it('never throws and writes nothing when the binding fails', async () => {
    expect(await generateImageVariants('stores/s/a.png', Buffer.from('x'), fakeImages(true))).toBe(
      0
    );
    expect(put).not.toHaveBeenCalled();
  });
  it('does nothing without the binding, for SVG and for a variant', async () => {
    expect(await generateImageVariants('stores/s/a.png', Buffer.from('x'), null)).toBe(0);
    expect(await generateImageVariants('stores/s/a.svg', Buffer.from('x'), fakeImages())).toBe(0);
    expect(
      await generateImageVariants('stores/s/a.w960.webp', Buffer.from('x'), fakeImages())
    ).toBe(0);
  });
});
