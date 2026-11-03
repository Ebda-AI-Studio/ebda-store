import { describe, it, expect, afterEach, vi } from 'vitest';
import loader, { snapWidth, variantFor, imageSrcSet } from './image-loader';

describe('image loader (variants, no request-time transformation)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('snaps to the smallest stored width that is wide enough', () => {
    expect([100, 480, 481, 960, 1200, 4000].map(snapWidth)).toEqual([
      480, 480, 960, 960, 1600, 1600,
    ]);
  });
  it('maps a media raster to its variant, never to /cdn-cgi', () => {
    const u = loader({ src: 'https://media.ebda.app/stores/a/p/x.png', width: 640 });
    expect(u).toBe('https://media.ebda.app/stores/a/p/x.w960.webp');
    expect(u).not.toContain('cdn-cgi');
  });
  it('passes through foreign hosts, SVG/GIF, data and relative URLs', () => {
    for (const src of [
      'https://example.com/x.png',
      'https://media.ebda.app/x.svg',
      'https://media.ebda.app/x.gif',
      'data:image/png;base64,AAA',
      '/local.png',
    ])
      expect(variantFor(src, 800)).toBe(src);
  });
  it('builds a srcset only when variants are on', () => {
    const src = 'https://media.ebda.app/stores/a/x.jpg';
    expect(imageSrcSet(src)).toBeUndefined();
    vi.stubEnv('NEXT_PUBLIC_IMAGE_VARIANTS', '1');
    expect(imageSrcSet(src)).toBe(
      'https://media.ebda.app/stores/a/x.w480.webp 480w, https://media.ebda.app/stores/a/x.w960.webp 960w, https://media.ebda.app/stores/a/x.w1600.webp 1600w'
    );
    expect(imageSrcSet(src, 960)).toContain('960w');
    expect(imageSrcSet(src, 960)).not.toContain('1600w');
    expect(imageSrcSet('https://x.com/a.png')).toBeUndefined();
  });
});
