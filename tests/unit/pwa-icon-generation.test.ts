/**
 * PWA icon-set generation (B5) on the Workers-safe path (Ruling FU46-8).
 *
 * `sharp` cannot load on workerd, so the server no longer resizes: the merchant's square PNG
 * source (validated by its bytes) is stored once as the source and once under every target
 * size's key, unchanged, with Content-Type image/png. Browsers scale an icon to the size they
 * render. Versioned keys (#1912/#1913), concurrent target uploads (#1914) and the error mapping
 * (#1916) keep their guarantees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakePng, JPEG_BYTES } from '../helpers/png-fixtures';

async function defaultUploadImpl(
  buffer: Buffer,
  originalFilename: string,
  options: { folder?: string; storeId?: string | null; filename?: string }
) {
  // Mirrors the REAL composeKey(): the key comes from `options.filename` when given.
  const keyName = options.filename ?? originalFilename;
  return {
    key: `stores/${options.storeId}/${options.folder}/${keyName}`,
    url: `https://cdn.example.r2.dev/stores/${options.storeId}/${options.folder}/${keyName}`,
    size: buffer.length,
    contentType: 'image/png',
  };
}

const uploadMock = vi.fn(defaultUploadImpl);

vi.mock('@api/services/storage.service', () => ({
  StorageService: { upload: uploadMock },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: {} }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const TARGETS = [
  'icon192',
  'icon384',
  'icon512',
  'iconAppleTouch',
  'favicon32',
  'favicon16',
  'maskableIcon',
];

describe('generatePwaIconSet (Workers-safe, no sharp)', () => {
  beforeEach(() => {
    uploadMock.mockClear();
    uploadMock.mockImplementation(defaultUploadImpl);
  });

  it('stores the source PNG unchanged as the source and under every target key', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const source = fakePng(600, 600);
    const result = await generatePwaIconSet(STORE_ID, source);

    expect(uploadMock).toHaveBeenCalledTimes(1 + TARGETS.length);
    for (const field of ['iconSource', ...TARGETS]) {
      expect(result[field as keyof typeof result], field).toBeTruthy();
    }
    for (const field of TARGETS) {
      const call = uploadMock.mock.calls.find(c => c[1] === `${field}.png`);
      expect(call, `${field} uploaded`).toBeTruthy();
      expect((call![0] as Buffer).equals(source), `${field} bytes`).toBe(true);
      expect((call![2] as { contentType?: string }).contentType).toBe('image/png');
    }
  });

  it('every icon lands under stores/<storeId>/pwa/', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    await generatePwaIconSet(STORE_ID, fakePng(512, 512));
    for (const call of uploadMock.mock.calls) {
      const options = call[2] as { folder?: string; storeId?: string | null };
      expect(options.folder).toBe('pwa');
      expect(options.storeId).toBe(STORE_ID);
    }
  });

  it('re-uploading produces a DIFFERENT key/URL per icon (busts the 1-year cache)', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const first = await generatePwaIconSet(STORE_ID, fakePng(512, 512));
    const second = await generatePwaIconSet(STORE_ID, fakePng(700, 700));
    expect(second.icon512).not.toBe(first.icon512);
    expect(second.favicon16).not.toBe(first.favicon16);
    expect(second.iconSource).not.toBe(first.iconSource);
  });

  it('every icon in one generation shares the SAME version suffix', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    await generatePwaIconSet(STORE_ID, fakePng(512, 512));
    const versions = uploadMock.mock.calls.map(c =>
      ((c[2] as { filename?: string }).filename ?? '').split('-').pop()
    );
    expect(new Set(versions).size).toBe(1);
  });

  it('uploads all 7 icon targets CONCURRENTLY, not one at a time', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    uploadMock.mockImplementation(async (buffer: Buffer, _f: string, options: any) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => releases.push(resolve));
      inFlight -= 1;
      return {
        key: `k-${options.filename}`,
        url: `u-${options.filename}`,
        size: 1,
        contentType: 'image/png',
      };
    });
    const done = generatePwaIconSet(STORE_ID, fakePng(512, 512));
    const waitUntil = async (pred: () => boolean) => {
      for (let i = 0; i < 400 && !pred(); i++) await new Promise(r => setTimeout(r, 5));
    };
    await waitUntil(() => releases.length >= 1);
    releases.splice(0).forEach(r => r());
    await waitUntil(() => inFlight >= 7);
    expect(maxInFlight).toBe(7);
    releases.splice(0).forEach(r => r());
    await done;
  });

  it('refuses a source that is not a PNG by its bytes, before any upload', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    for (const bad of [Buffer.from('not an image'), JPEG_BYTES]) {
      await expect(generatePwaIconSet(STORE_ID, bad)).rejects.toMatchObject({
        statusCode: 400,
        code: 'ICON_GENERATION_FAILED',
      });
    }
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('a failure on the very first upload leaves no icon uploaded at all', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    uploadMock.mockRejectedValueOnce(new Error('R2 network blip'));
    await expect(generatePwaIconSet(STORE_ID, fakePng(512, 512))).rejects.toBeTruthy();
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][1]).toBe('source.png');
  });

  it('re-throws a StorageService AppError unchanged', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    const { AppError } = await import('@api/middleware/error-handler');
    uploadMock.mockRejectedValueOnce(new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Storage down'));
    await expect(generatePwaIconSet(STORE_ID, fakePng(512, 512))).rejects.toMatchObject({
      statusCode: 503,
      code: 'STORAGE_NOT_CONFIGURED',
    });
  });

  it('maps an unrecognized upload failure to 502 ICON_UPLOAD_FAILED, not 400', async () => {
    const { generatePwaIconSet } = await import('@api/services/pwa.service');
    uploadMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(generatePwaIconSet(STORE_ID, fakePng(512, 512))).rejects.toMatchObject({
      statusCode: 502,
      code: 'ICON_UPLOAD_FAILED',
    });
  });
});
