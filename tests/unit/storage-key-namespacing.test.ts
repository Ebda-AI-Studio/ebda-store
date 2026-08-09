import { describe, it, expect, beforeAll, vi } from 'vitest';

// `config` reads process.env at MODULE LOAD, and presigning needs a client, so
// the storage env has to exist before the module graph is imported. Presigning
// is local crypto (no network), so dummy credentials are sufficient.
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
      await expect(
        StorageService.getUploadUrl('photo.jpg', 'image/jpeg', 'branding', 3600, null)
      ).rejects.toThrow(/MISSING_TENANT|namespaced|storeId/i);
    });

    it('throws for every folder that historically leaked to root', async () => {
      for (const folder of ['branding', 'categories', 'hero']) {
        await expect(
          StorageService.getUploadUrl('x.png', 'image/png', folder, 3600, null)
        ).rejects.toThrow(/MISSING_TENANT|namespaced|storeId/i);
      }
    });
  });

  describe('with a tenant, the key is namespaced so it can be reclaimed', () => {
    const STORE = '0bbf478a-efa8-450c-81d9-56898c548b8b';

    it('places the object under stores/<storeId>/<folder>/', async () => {
      const { key } = await StorageService.getUploadUrl(
        'photo.jpg',
        'image/jpeg',
        'branding',
        3600,
        STORE
      );
      expect(key.startsWith(`stores/${STORE}/branding/`)).toBe(true);
    });

    it('produces a key that deleteByPrefix(stores/<id>/) would actually match', async () => {
      // The whole point: tenant offboarding purges this exact prefix.
      const { key } = await StorageService.getUploadUrl(
        'a.png',
        'image/png',
        'categories',
        3600,
        STORE
      );
      expect(key.startsWith(`stores/${STORE}/`)).toBe(true);
    });

    it('still rejects a folder that is not on the tenant allowlist', async () => {
      await expect(
        StorageService.getUploadUrl('x.png', 'image/png', 'not-a-real-folder', 3600, STORE)
      ).rejects.toThrow(/INVALID_FOLDER|not allowed/i);
    });
  });
});
