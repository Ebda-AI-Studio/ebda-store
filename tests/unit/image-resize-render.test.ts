/**
 * Issue 906 — the sharp 0.34 → 0.35 major bump (libvips 8.18) was signed off
 * on typecheck alone. This renders the REAL upload pipeline with the installed
 * sharp: every `ASPECT_TARGETS` key, for JPEG / PNG / WEBP input, must come
 * out at the exact target size, in the input's format, cover-cropped around
 * the CENTRE; and an SVG logo (the OG card path) must still rasterize.
 *
 * It runs the libvips build that `npm ci` installs on the CI runner, so a
 * future sharp/libvips bump that changes crop, format or dimensions fails here
 * instead of on a merchant's upload.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ASPECT_TARGETS, resizeToAspect } from '../../apps/api/src/services/image-resize.service';

/**
 * A 2400×2400 image whose centre is RED and whose border is BLUE — a
 * centred cover crop must keep red at the output's centre.
 */
async function source(format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> {
  const size = 2400;
  const center = await sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 230, g: 20, b: 20 } },
  })
    .png()
    .toBuffer();
  const base = sharp({
    create: { width: size, height: size, channels: 3, background: { r: 20, g: 20, b: 230 } },
  }).composite([{ input: center, gravity: 'center' }]);
  if (format === 'jpeg') return base.jpeg({ quality: 90 }).toBuffer();
  if (format === 'webp') return base.webp({ quality: 90 }).toBuffer();
  return base.png().toBuffer();
}

async function centrePixel(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe.each(['jpeg', 'png', 'webp'] as const)(
  'resizeToAspect renders %s with sharp 0.35',
  format => {
    it.each(Object.entries(ASPECT_TARGETS))(
      '%s → exact target, same format, centred',
      async (aspect, target) => {
        const input = await source(format);
        const out = await resizeToAspect(input, aspect);

        expect(out).not.toBe(input); // actually re-encoded, not the fail-soft passthrough
        const md = await sharp(out).metadata();
        expect(md.format).toBe(format);
        expect(md.width).toBe(target.w);
        expect(md.height).toBe(target.h);

        const px = await centrePixel(out);
        expect(px.r).toBeGreaterThan(180);
        expect(px.b).toBeLessThan(80);
      }
    );
  }
);

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
