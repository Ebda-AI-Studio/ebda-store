import { describe, it, expect, beforeAll, vi } from 'vitest';

// `config` reads process.env at MODULE LOAD and the upload needs a client, so the storage
// env has to exist before the module graph is imported. The S3 client is faked (no network):
// these cases drive composeKey through `upload`, the only public surface left that reaches it
// since the presigned-upload route was deleted (Ruling FU46-5b).
vi.mock('../../apps/api/src/lib/lazy-modules', () => ({
  loadS3: async () => ({
    S3Client: class {
      async send() {
        return {};
      }
    },
    PutObjectCommand: class {
      constructor(readonly input: unknown) {}
    },
  }),
  loadS3Presigner: async () => ({}),
}));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const put = (name: string, folder: string, storeId: string | null) =>
  StorageService.upload(PNG, name, { folder, storeId });

let StorageService: typeof import('../../apps/api/src/services/storage.service').StorageService;

beforeAll(async () => {
  vi.stubEnv('STORAGE_ENDPOINT', 'https://example.r2.cloudflarestorage.com');
  vi.stubEnv('STORAGE_ACCESS_KEY', 'test-access-key');
  vi.stubEnv('STORAGE_SECRET_KEY', 'test-secret-key');
  vi.stubEnv('STORAGE_BUCKET', 'test-bucket');
  vi.resetModules();
  ({ StorageService } = await import('../../apps/api/src/services/storage.service'));
});

// On 2026-08-09 an R2 audit found 9 objects sitting at bucket root
// (`branding/`, `categories/`, `hero/`) instead of under `stores/<storeId>/`.
// They belonged to real merchants but were attributable to none.
//
// Cause: composeKey silently fell through to a root-level key whenever storeId
// was absent. The cost is not tidiness — `deleteByPrefix('stores/<id>/')` is how
// a tenant's storage is reclaimed on offboarding, so a root-level object
// survives its owner's deletion forever and per-client storage cannot be
// measured.
//
// composeKey is private, so these drive it through the public surface that
// reaches it. The point is the INVARIANT: no tenant, no key.
describe('R2 key namespacing', () => {
  describe('refuses to mint an un-namespaced key', () => {
    it('throws rather than writing a root-level key when storeId is null', async () => {
      await expect(put('photo.jpg', 'branding', null)).rejects.toThrow(
        /MISSING_TENANT|namespaced|storeId/i
      );
    });

    it('throws for every folder that historically leaked to root', async () => {
      for (const folder of ['branding', 'categories', 'hero']) {
        await expect(put('x.png', folder, null)).rejects.toThrow(
          /MISSING_TENANT|namespaced|storeId/i
        );
      }
    });
  });

  describe('with a tenant, the key is namespaced so it can be reclaimed', () => {
    const STORE = '0bbf478a-efa8-450c-81d9-56898c548b8b';

    it('places the object under stores/<storeId>/<folder>/', async () => {
      const { key } = await put('photo.jpg', 'branding', STORE);
      expect(key.startsWith(`stores/${STORE}/branding/`)).toBe(true);
    });

    it('produces a key that deleteByPrefix(stores/<id>/) would actually match', async () => {
      // The whole point: tenant offboarding purges this exact prefix.
      const { key } = await put('a.png', 'categories', STORE);
      expect(key.startsWith(`stores/${STORE}/`)).toBe(true);
    });

    it('still rejects a folder that is not on the tenant allowlist', async () => {
      await expect(put('x.png', 'not-a-real-folder', STORE)).rejects.toThrow(
        /INVALID_FOLDER|not allowed/i
      );
    });
  });
});
