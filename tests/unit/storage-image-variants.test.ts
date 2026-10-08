import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { IMAGE_VARIANT_WIDTHS, variantKeysFor } from '@force/shared';

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
let failWhen: (name: string, input: Record<string, unknown>) => boolean = () => false;
let listContents: Array<{ Key: string; Size?: number; LastModified?: Date }> = [];

vi.mock('../../apps/api/src/lib/lazy-modules', () => {
  const cmd = (name: string) =>
    class {
      input: Record<string, unknown>;
      name = name;
      constructor(input: Record<string, unknown>) {
        this.input = input;
      }
    };
  return {
    loadS3: async () => ({
      S3Client: class {
        async send(c: { name: string; input: Record<string, unknown> }) {
          sent.push({ name: c.name, input: c.input });
          if (failWhen(c.name, c.input)) throw new Error('boom');
          if (c.name === 'ListObjectsV2Command')
            return { Contents: listContents, IsTruncated: false };
          return {};
        }
      },
      PutObjectCommand: cmd('PutObjectCommand'),
      DeleteObjectCommand: cmd('DeleteObjectCommand'),
      DeleteObjectsCommand: cmd('DeleteObjectsCommand'),
      ListObjectsV2Command: cmd('ListObjectsV2Command'),
      GetObjectCommand: cmd('GetObjectCommand'),
    }),
    loadS3Presigner: async () => ({ getSignedUrl: async () => 'https://signed' }),
  };
});

const fakeVariants = (_b: Buffer) =>
  Promise.resolve(
    [480, 720, 960, 1280].map(width => ({ width, buffer: Buffer.from(`v${width}`) }))
  );
const generate = vi.fn(fakeVariants);
vi.mock('../../apps/api/src/services/image-variants.service', () => ({
  generateImageVariants: (b: Buffer) => generate(b),
}));

const STORE = '0bbf478a-efa8-450c-81d9-56898c548b8b';
let StorageService: typeof import('../../apps/api/src/services/storage.service').StorageService;

beforeAll(async () => {
  vi.stubEnv('STORAGE_ENDPOINT', 'https://example.r2.cloudflarestorage.com');
  vi.stubEnv('STORAGE_ACCESS_KEY', 'k');
  vi.stubEnv('STORAGE_SECRET_KEY', 's');
  vi.stubEnv('STORAGE_BUCKET', 'test-bucket');
  vi.resetModules();
  ({ StorageService } = await import('../../apps/api/src/services/storage.service'));
});

beforeEach(() => {
  sent.length = 0;
  failWhen = () => false;
  listContents = [];
  generate.mockReset();
  generate.mockImplementation(fakeVariants);
});

const puts = () => sent.filter(s => s.name === 'PutObjectCommand').map(s => s.input);

describe('StorageService.upload variants', () => {
  it('writes the original plus 4 webp variants with immutable cache headers', async () => {
    const res = await StorageService.upload(Buffer.from('img'), 'Photo.JPG', {
      folder: 'products',
      storeId: STORE,
    });
    const writes = puts();
    expect(writes).toHaveLength(1 + IMAGE_VARIANT_WIDTHS.length);
    expect(writes[0]).toMatchObject({
      Key: res.key,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(
      writes
        .slice(1)
        .map(w => w.Key)
        .sort()
    ).toEqual(variantKeysFor(res.key).sort());
    for (const w of writes.slice(1)) {
      expect(w).toMatchObject({
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      });
    }
  });

  it('still resolves when a variant PutObject rejects', async () => {
    failWhen = (n, i) => n === 'PutObjectCommand' && String(i.Key).endsWith('.w720.webp');
    const res = await StorageService.upload(Buffer.from('img'), 'a.png', {
      folder: 'products',
      storeId: STORE,
    });
    expect(res.key).toMatch(/\.png$/);
    expect(puts()).toHaveLength(1 + IMAGE_VARIANT_WIDTHS.length);
  });

  it('still resolves when generation itself throws', async () => {
    generate.mockRejectedValue(new Error('sharp exploded'));
    await expect(
      StorageService.upload(Buffer.from('img'), 'a.png', { folder: 'products', storeId: STORE })
    ).resolves.toBeTruthy();
    expect(puts()).toHaveLength(1);
  });

  it('skipVariants writes only the original', async () => {
    await StorageService.upload(Buffer.from('img'), 'a.png', {
      folder: 'pwa',
      storeId: STORE,
      skipVariants: true,
    });
    expect(puts()).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not variant svg or gif', async () => {
    await StorageService.upload(Buffer.from('<svg/>'), 'a.svg', {
      folder: 'logos',
      storeId: STORE,
      allowedTypes: ['image/svg+xml'],
    });
    await StorageService.upload(Buffer.from('gif'), 'a.gif', { folder: 'misc', storeId: STORE });
    expect(puts()).toHaveLength(2);
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps the plain 1-year cache when the caller picks the filename (key can be overwritten)', async () => {
    await StorageService.upload(Buffer.from('img'), 'a.png', {
      folder: 'pwa',
      storeId: STORE,
      filename: 'fixed',
      skipVariants: true,
    });
    expect(puts()[0]!.CacheControl).toBe('public, max-age=31536000');
  });
});

describe('StorageService.delete variants', () => {
  const key = `stores/${STORE}/products/u-a.jpg`;

  it('removes the original and its 4 variants', async () => {
    await StorageService.delete(key);
    const keys = sent.filter(s => s.name === 'DeleteObjectCommand').map(s => s.input.Key);
    expect(keys.sort()).toEqual([key, ...variantKeysFor(key)].sort());
  });

  it('tolerates a variant delete failure', async () => {
    failWhen = (n, i) => n === 'DeleteObjectCommand' && String(i.Key).endsWith('.w480.webp');
    await expect(StorageService.delete(key)).resolves.toBeUndefined();
  });

  it('does not touch variants for non-raster keys', async () => {
    await StorageService.delete(`stores/${STORE}/logos/u-a.svg`);
    expect(sent.filter(s => s.name === 'DeleteObjectCommand')).toHaveLength(1);
  });
});

describe('StorageService.listByPrefix', () => {
  it('hides variant keys from the media library', async () => {
    const orig = `stores/${STORE}/products/u-a.jpg`;
    listContents = [
      { Key: orig, Size: 10, LastModified: new Date('2026-01-01') },
      ...variantKeysFor(orig).map(Key => ({ Key, Size: 1, LastModified: new Date('2026-01-01') })),
    ];
    const page = await StorageService.listByPrefix(`stores/${STORE}/`);
    expect(page.items.map(i => i.key)).toEqual([orig]);
  });
});
