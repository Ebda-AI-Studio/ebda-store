/**
 * PWA icon-set generation unit tests (B5, docs/superpowers/plans/
 * 2026-05-04-storefront-per-store-pwa-full-sizes.md, task 2).
 *
 * `generatePwaIconSet` is pure image processing (sharp) + one upload
 * primitive (`StorageService.upload`) — mock the latter so the test never
 * touches the network, and assert on the REAL sharp output (actual pixel
 * dimensions of the generated buffers), not just "a function was called".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

const uploadMock = vi.fn(
  async (
    buffer: Buffer,
    filename: string,
    options: { folder?: string; storeId?: string | null }
  ) => ({
    key: `stores/${options.storeId}/${options.folder}/${filename}`,
    url: `https://cdn.example.r2.dev/stores/${options.storeId}/${options.folder}/${filename}`,
    size: buffer.length,
    contentType: 'image/png',
  })
);

vi.mock('@api/services/storage.service', () => ({
  StorageService: { upload: uploadMock },
}));

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// generateManifest/PWAService pulls in prisma + feature.service + revalidate —
// none of which this file exercises, but the module graph is shared, so stub
// enough that importing pwa.service.ts doesn't explode.
vi.mock('@force/database', () => ({ prisma: {}, Prisma: {} }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));

const STORE_ID = '11111111-1111-1111-1111-111111111111';

async function makeSourceBuffer(size = 600): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 80, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe('generatePwaIconSet', () => {
  beforeEach(() => {
    uploadMock.mockClear();
  });

  it('generates every plan-listed size at the correct pixel dimensions', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const source = await makeSourceBuffer();

    const result = await generatePwaIconSet(STORE_ID, source);

    const expectedSquare: Record<string, number> = {
      icon192: 192,
      icon384: 384,
      icon512: 512,
      iconAppleTouch: 180,
      favicon32: 32,
      favicon16: 16,
      maskableIcon: 512,
    };

    for (const [field, size] of Object.entries(expectedSquare)) {
      const url = result[field as keyof typeof result];
      expect(url, `${field} should have a URL`).toBeTruthy();
      const call = uploadMock.mock.calls.find(c => c[1] === `${field}.png`);
      expect(call, `${field} should have been uploaded`).toBeTruthy();
      const uploadedBuffer = call![0] as Buffer;
      const meta = await sharp(uploadedBuffer).metadata();
      expect(meta.width, `${field} width`).toBe(size);
      expect(meta.height, `${field} height`).toBe(size);
    }

    expect(result.iconSource).toBeTruthy();
  });

  it('every generated icon lands under stores/<storeId>/pwa/', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const source = await makeSourceBuffer();

    await generatePwaIconSet(STORE_ID, source);

    for (const call of uploadMock.mock.calls) {
      const options = call[2] as { folder?: string; storeId?: string | null };
      expect(options.folder).toBe('pwa');
      expect(options.storeId).toBe(STORE_ID);
    }
  });

  it('re-uploading overwrites the SAME R2 key per icon (no orphan accumulation)', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const first = await generatePwaIconSet(STORE_ID, await makeSourceBuffer());
    const second = await generatePwaIconSet(STORE_ID, await makeSourceBuffer(700));

    expect(second.icon512).toBe(first.icon512);
    expect(second.favicon16).toBe(first.favicon16);
  });

  it('the maskable icon pads the artwork to ~80% inside the square (safe zone)', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    await generatePwaIconSet(STORE_ID, await makeSourceBuffer());

    const call = uploadMock.mock.calls.find(c => c[1] === 'maskableIcon.png')!;
    const buf = call[0] as Buffer;
    const raw = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    // Row 2px from the top: fully-padded region should be transparent
    // (alpha 0) at the top, since the artwork is centered and shrunk to 80%.
    const y = 2;
    const rowStart = y * info.width * info.channels;
    const topRowAlpha = data[rowStart + 3];
    expect(topRowAlpha).toBe(0);
  });

  it('throws a friendly AppError when sharp cannot process the buffer', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const garbage = Buffer.from('not an image');

    await expect(generatePwaIconSet(STORE_ID, garbage)).rejects.toMatchObject({
      statusCode: 400,
      code: 'ICON_GENERATION_FAILED',
    });
  });

  // Issue #1913 — a mid-loop upload failure must not have mutated any live
  // R2 object. Every icon key is fixed (re-upload overwrites the same
  // object), so the old code — which processed AND uploaded each icon in
  // the same loop — left uploads #1..N-1 live on R2 the moment upload #N
  // threw. The fix buffers every sharp output BEFORE any upload starts, so
  // a failure that happens before the FIRST upload call (source.png) proves
  // no live object was ever touched.
  it('a failure on the very first upload leaves no icon uploaded at all', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    uploadMock.mockRejectedValueOnce(new Error('R2 network blip'));

    await expect(generatePwaIconSet(STORE_ID, await makeSourceBuffer())).rejects.toBeTruthy();

    // Only the source.png upload was attempted before the rejection —
    // no icon target was ever reached, i.e. every buffer had already been
    // computed (phase 1 completed) before phase 2 (uploads) started.
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][1]).toBe('source.png');
  });

  it('every icon buffer is fully computed before the first upload call is made', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const sharpToBufferSpy = vi.spyOn(sharp.prototype, 'toBuffer');
    let toBufferCallsBeforeFirstUpload = -1;
    uploadMock.mockImplementationOnce(async (buffer: Buffer, filename: string, options) => {
      toBufferCallsBeforeFirstUpload = sharpToBufferSpy.mock.calls.length;
      return {
        key: `stores/${options.storeId}/${options.folder}/${filename}`,
        url: `https://cdn.example.r2.dev/stores/${options.storeId}/${options.folder}/${filename}`,
        size: buffer.length,
        contentType: 'image/png',
      };
    });

    await generatePwaIconSet(STORE_ID, await makeSourceBuffer());

    // Whatever the total sharp `toBuffer` call count ends up being (it may
    // include internal calls beyond the 8 pipelines this function drives),
    // NONE of them happen after the first upload starts — every buffer this
    // function produces is already computed before phase 2 (uploads) does
    // anything, which is the property #1913 needs: an upload failure can
    // never race a still-running sharp pipeline.
    expect(toBufferCallsBeforeFirstUpload).toBe(sharpToBufferSpy.mock.calls.length);
    sharpToBufferSpy.mockRestore();
  });

  // Issue #1916 — a genuine StorageService failure (R2 outage, missing
  // folder allowlist, missing tenant) must surface with its OWN status
  // code, not get relabeled as "your image is invalid" (400
  // ICON_GENERATION_FAILED). error-handler.ts only escalates >=500 to
  // Sentry, so masking a 503 as a 400 makes an infra outage invisible to
  // alerting.
  it('re-throws a StorageService AppError unchanged instead of masking it as ICON_GENERATION_FAILED', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const { AppError } = await import('@api/middleware/error-handler');
    uploadMock.mockRejectedValueOnce(new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Storage down'));

    await expect(generatePwaIconSet(STORE_ID, await makeSourceBuffer())).rejects.toMatchObject({
      statusCode: 503,
      code: 'STORAGE_NOT_CONFIGURED',
    });
  });

  it('maps an unrecognized upload failure to 502 ICON_UPLOAD_FAILED, not 400', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    uploadMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(generatePwaIconSet(STORE_ID, await makeSourceBuffer())).rejects.toMatchObject({
      statusCode: 502,
      code: 'ICON_UPLOAD_FAILED',
    });
  });
});
