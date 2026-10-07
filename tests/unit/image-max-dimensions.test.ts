import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { enforceMaxDimensions } from '../../apps/api/src/services/image-resize.service';

// On 2026-05-01 the demo-boutique catalog uploaded 19 images averaging 8 MB, including
// a 4160x6240 PNG at 28 MB, and those product pages shipped exactly that to
// mobile customers until 2026-08-09. The cause: resizeToAspect is opt-in via
// `?aspect=`, no product-upload surface sends it, and there was no other
// ceiling anywhere in the pipeline.
//
// enforceMaxDimensions is the floor that runs regardless. These tests pin the
// properties that make it safe to apply to EVERY upload.
describe('enforceMaxDimensions', () => {
  const png = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 90 } } })
      .png()
      .toBuffer();

  it('downscales an oversized image to 2000px on the LONGEST side', async () => {
    const out = await enforceMaxDimensions(await png(4000, 6000));
    const md = await sharp(out).metadata();
    // Portrait: height is the long side, so height caps at 2000 — not width.
    // Constraining width alone would leave 2000x3000, still 6 megapixels.
    expect(md.height).toBe(2000);
    expect(md.width).toBe(1333);
  });

  it('caps the long side for landscape too', async () => {
    const out = await enforceMaxDimensions(await png(6000, 4000));
    const md = await sharp(out).metadata();
    expect(md.width).toBe(2000);
    expect(md.height).toBe(1333);
  });

  it('actually reduces bytes on a realistic oversized upload', async () => {
    const original = await png(4000, 6000);
    const out = await enforceMaxDimensions(original);
    expect(out.length).toBeLessThan(original.length);
  });

  it('leaves an already-small image untouched — no upscaling, no churn', async () => {
    const original = await png(800, 600);
    const out = await enforceMaxDimensions(original);
    expect(out).toBe(original); // same reference: short-circuited
  });

  it('does not upscale an image that is under the ceiling in both dimensions', async () => {
    const out = await enforceMaxDimensions(await png(1999, 1999));
    const md = await sharp(out).metadata();
    expect(md.width).toBe(1999);
    expect(md.height).toBe(1999);
  });

  it('preserves format — the R2 key extension must stay valid', async () => {
    const out = await enforceMaxDimensions(await png(4000, 4000));
    expect((await sharp(out).metadata()).format).toBe('png');
  });

  it('never returns a LARGER buffer than it was given', async () => {
    // Re-encoding an already-optimised image can inflate it; the whole point
    // of this function is bytes, so it must bail rather than regress.
    const original = await png(2400, 2400);
    const out = await enforceMaxDimensions(original);
    expect(out.length).toBeLessThanOrEqual(original.length);
  });

  it('fails SOFT on a non-image buffer rather than breaking the upload', async () => {
    const garbage = Buffer.from('this is definitely not an image');
    const out = await enforceMaxDimensions(garbage);
    expect(out).toBe(garbage);
  });
});
