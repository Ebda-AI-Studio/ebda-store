/**
 * Cross-tenant object deletion. The URL that reaches `deleteR2ObjectIfOrphan` is usually
 * merchant-controlled (a font, a hero slide, a category image they saved). "No row anywhere still
 * references it" is not "it is mine": store A could put store B's object URL into a field, remove
 * it, and delete B's object whenever B had not saved a reference yet (an upload not yet attached,
 * an object only in a pending draft). The delete therefore refuses any key outside the CURRENT
 * store's namespace (`stores/<storeId>/`), independent of whatever validated the URL on the way in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  ambient: null as string | null,
  storageDelete: vi.fn().mockResolvedValue(undefined),
  referenced: vi.fn().mockResolvedValue([{ referenced: false }]),
  warn: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  const tx = { $queryRawUnsafe: h.referenced, $executeRaw: vi.fn().mockResolvedValue(0) };
  return {
    currentStoreId: () => {
      if (!h.ambient) throw new Error('no ambient store');
      return h.ambient;
    },
    storeDirectory: vi.fn().mockResolvedValue([{ id: 'store-a' }, { id: 'store-b' }]),
    withStore: (_id: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
});
// both stores are Postgres stores: no Durable Object is consulted (the DO path has its own test, r2-cleanup-do-references)
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: 'pg', money: null }),
}));
vi.mock('../../apps/api/src/services/storage.service', () => ({
  StorageService: { isAvailable: () => true, delete: h.storageDelete },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: h.warn, info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/config', () => ({
  config: { storagePublicUrl: 'https://cdn.example.com', storageEndpoint: '', storageBucket: '' },
}));

import {
  cleanupRemovedJsonUrls,
  deleteR2ObjectIfOrphan,
  mayDeleteKey,
  r2KeyBelongsToStore,
} from '../../apps/api/src/services/r2-cleanup.service';

const A_FONT = 'https://cdn.example.com/stores/store-a/fonts/a.woff2';
const B_FONT = 'https://cdn.example.com/stores/store-b/fonts/b.woff2';

beforeEach(() => {
  vi.clearAllMocks();
  h.ambient = 'store-a';
  h.referenced.mockResolvedValue([{ referenced: false }]);
});

describe('r2KeyBelongsToStore', () => {
  it('is an exact store prefix: another store, a longer id, a traversal and an empty id all fail', () => {
    expect(r2KeyBelongsToStore('stores/store-a/fonts/x.woff2', 'store-a')).toBe(true);
    expect(r2KeyBelongsToStore('stores/store-b/fonts/x.woff2', 'store-a')).toBe(false);
    expect(r2KeyBelongsToStore('stores/store-ab/fonts/x.woff2', 'store-a')).toBe(false);
    expect(r2KeyBelongsToStore('stores/store-a/../store-b/x', 'store-a')).toBe(false);
    expect(r2KeyBelongsToStore('stores/store-a/fonts/x', '')).toBe(false);
    expect(r2KeyBelongsToStore('products/x.jpg', 'store-a')).toBe(false);
  });
});

describe('deleteR2ObjectIfOrphan refuses another store`s object', () => {
  it('store A cannot delete store B`s font, even though nothing references it: B`s object survives', async () => {
    await deleteR2ObjectIfOrphan(B_FONT);
    expect(h.storageDelete).not.toHaveBeenCalled();
    // it never even went looking: the ownership check comes first
    expect(h.referenced).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'stores/store-b/fonts/b.woff2' }),
      expect.stringContaining('refused')
    );
  });

  it('store A can still delete its OWN unreferenced object', async () => {
    await deleteR2ObjectIfOrphan(A_FONT);
    expect(h.storageDelete).toHaveBeenCalledWith('stores/store-a/fonts/a.woff2');
  });

  it('and its own object stays when something still references it', async () => {
    h.referenced.mockResolvedValue([{ referenced: true }]);
    await deleteR2ObjectIfOrphan(A_FONT);
    expect(h.storageDelete).not.toHaveBeenCalled();
  });

  it('with no store in scope (a user-scoped request, a cron) a store-namespaced key is never deleted', async () => {
    h.ambient = null;
    await deleteR2ObjectIfOrphan(A_FONT);
    await deleteR2ObjectIfOrphan(B_FONT);
    expect(h.storageDelete).not.toHaveBeenCalled();
    // legacy flat platform keys are not store-namespaced and keep working
    await deleteR2ObjectIfOrphan('https://cdn.example.com/legacy/flat.jpg');
    expect(h.storageDelete).toHaveBeenCalledWith('legacy/flat.jpg');
  });

  it('mayDeleteKey is the whole rule', () => {
    h.ambient = 'store-a';
    expect(mayDeleteKey('stores/store-a/images/1.jpg')).toBe(true);
    expect(mayDeleteKey('stores/store-b/images/1.jpg')).toBe(false);
    expect(mayDeleteKey('legacy/flat.jpg')).toBe(false); // in a store scope even flat keys are not the store`s
    h.ambient = null;
    expect(mayDeleteKey('stores/store-a/images/1.jpg')).toBe(false);
    expect(mayDeleteKey('legacy/flat.jpg')).toBe(true);
  });
});

describe('a caller that knows the owner (an erased user\u2019s avatar) says so', () => {
  const AVATAR = 'https://cdn.example.com/stores/store-a/avatars/me.png';
  it('with no store in scope, the owner store lets its own avatar be deleted', async () => {
    h.ambient = null;
    await deleteR2ObjectIfOrphan(AVATAR, { ownerStoreId: 'store-a' });
    expect(h.storageDelete).toHaveBeenCalledWith('stores/store-a/avatars/me.png');
  });
  it('but only its own: the owner store cannot delete another store`s object', async () => {
    h.ambient = null;
    await deleteR2ObjectIfOrphan(B_FONT, { ownerStoreId: 'store-a' });
    expect(h.storageDelete).not.toHaveBeenCalled();
  });
  it('and the scope it runs in may not contradict it', async () => {
    h.ambient = 'store-b';
    await deleteR2ObjectIfOrphan(AVATAR, { ownerStoreId: 'store-a' });
    expect(h.storageDelete).not.toHaveBeenCalled();
  });
  it('the legacy `<storeId>/` flat prefix counts only when asked for (the explicit file delete route)', () => {
    expect(r2KeyBelongsToStore('store-a/old.jpg', 'store-a')).toBe(false);
    expect(r2KeyBelongsToStore('store-a/old.jpg', 'store-a', { legacyFlat: true })).toBe(true);
    expect(r2KeyBelongsToStore('store-ab/old.jpg', 'store-a', { legacyFlat: true })).toBe(false);
    expect(r2KeyBelongsToStore('store-a/../store-b/x', 'store-a', { legacyFlat: true })).toBe(
      false
    );
  });
});

describe('the sibling paths go through the same guard', () => {
  it('cleanupRemovedJsonUrls (layout images, PWA icons): a foreign URL removed from a JSON blob is not deleted', async () => {
    const before = { hero: { slides: [{ image: B_FONT }, { image: A_FONT }] } };
    await cleanupRemovedJsonUrls(before, { hero: { slides: [] } });
    expect(h.storageDelete).toHaveBeenCalledTimes(1);
    expect(h.storageDelete).toHaveBeenCalledWith('stores/store-a/fonts/a.woff2');
  });
});
