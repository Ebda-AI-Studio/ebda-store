import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { IMAGE_VARIANT_WIDTHS } from '@force/shared';
import { generateImageVariants } from '../../apps/api/src/services/image-variants.service';

const png = (width: number, height = 40) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();

const animated = (format: 'gif' | 'webp') => {
  const w = 16;
  const h = 16;
  const frame = Buffer.alloc(w * h * 4, 255);
  const two = Buffer.concat([frame, Buffer.alloc(w * h * 4, 0)]);
  const s = sharp(two, { raw: { width: w, height: h * 2, channels: 4, pageHeight: h } });
  return format === 'gif' ? s.gif().toBuffer() : s.webp().toBuffer();
};

describe('generateImageVariants', () => {
  it('returns one webp per ladder rung, never wider than the rung', async () => {
    const out = await generateImageVariants(await png(2000));
    expect(out.map(v => v.width)).toEqual([...IMAGE_VARIANT_WIDTHS]);
    for (const v of out) {
      const meta = await sharp(v.buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(v.width);
    }
  });

  it('never enlarges: a 100px source yields all 4 rungs at 100px', async () => {
    const out = await generateImageVariants(await png(100));
    expect(out).toHaveLength(IMAGE_VARIANT_WIDTHS.length);
    for (const v of out) expect((await sharp(v.buffer).metadata()).width).toBe(100);
  });

  it('returns [] (does not throw) for a garbage buffer', async () => {
    await expect(generateImageVariants(Buffer.from('not an image'))).resolves.toEqual([]);
  });

  it('skips animated inputs', async () => {
    await expect(generateImageVariants(await animated('gif'))).resolves.toEqual([]);
    await expect(generateImageVariants(await animated('webp'))).resolves.toEqual([]);
  });
});
