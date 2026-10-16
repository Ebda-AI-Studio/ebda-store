/**
 * The storefront's /og card (apps/web/src/app/og/route.tsx) rasterizes an SVG logo with a
 * runtime-gated `sharp` on Node. Moved here from image-resize-render.test.ts when the API's
 * upload resizer stopped using sharp (Ruling FU46-8); this guards the web path's libvips build.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

async function centrePixel(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe('SVG logo rasterization (the /og card path)', () => {
  it('sharp still rasterizes an SVG to a PNG of the requested width', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#ff6e01"/></svg>'
    );
    const out = await sharp(svg, { density: 300 }).resize({ width: 400 }).png().toBuffer();
    const md = await sharp(out).metadata();
    expect(md.format).toBe('png');
    expect(md.width).toBe(400);
    const px = await centrePixel(out);
    expect(px).toMatchObject({ r: 255 });
    expect(px.g).toBeGreaterThan(90);
    expect(px.g).toBeLessThan(130);
  });
});
