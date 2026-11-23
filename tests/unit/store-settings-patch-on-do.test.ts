/**
 * BE:F-2 / BE:F-3 on a Durable Object store: the settings writers send a KEY PATCH to the StoreDO (`storePatchOnDo`, one DO
 * transaction) and never read-merge-write. The DO-side atomicity itself is proven in `packages/repo/test/rpc-settings-patch.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  patch: vi.fn(),
  update: vi.fn(),
  row: { id: 'x', slug: 'demo', domain: null as string | null, logo: null, logoAr: null },
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) => fn({}),
  runInTenantContext: async (_id: string, fn: () => unknown) => fn(),
  acrossStores: async () => [],
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeWritesToDo: async () => true,
  storePatchOnDo: h.patch,
  storeUpdateOnDo: h.update,
  copyStoreSettings: vi.fn(),
  storeDb: vi.fn(),
  storeRepo: vi.fn(),
  closeDoIfNoMoney: vi.fn(),
  reopenDoAfterFailedDelete: vi.fn(),
}));
vi.mock('@ebda/shared', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/shared')>()),
  slugify: (s: string) => s,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));
vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn(),
}));

import { StoreService } from '../../apps/api/src/services/store.service';

const ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  h.patch.mockReset().mockResolvedValue(h.row);
  h.update.mockReset();
  vi.spyOn(StoreService, 'getById').mockResolvedValue(h.row as never);
});

describe('settings writers on a DO store send a key patch (BE:F-2 / BE:F-3)', () => {
  it('generic PUT settings patches only the sent keys and drops server-owned ones', async () => {
    await StoreService.update(ID, {
      settings: { contact: { a: 1 }, mcpWriteEnabled: true, ebdaWhatsApp: { x: 1 } },
    } as never);
    expect(h.patch).toHaveBeenCalledTimes(1);
    const [id, patch] = h.patch.mock.calls[0];
    expect(id).toBe(ID);
    expect(patch.json).toEqual({ settings: { set: { contact: { a: 1 } } } });
    expect(patch.fields).not.toHaveProperty('settings');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('a per-key setter replaces exactly one key (server-owned keys included: the dedicated route owns them)', async () => {
    await StoreService.setMcpWriteEnabled(ID, true);
    expect(h.patch.mock.calls[0][1]).toEqual({
      json: { settings: { set: { mcpWriteEnabled: true } } },
    });
    await StoreService.updateFloatingWidget(ID, { enabled: true });
    expect(h.patch.mock.calls[1][1]).toEqual({
      json: { settings: { set: { floatingWidget: { enabled: true } } } },
    });
  });

  it('the branding bundle is ONE patch call carrying every part', async () => {
    await StoreService.updateBrandingBundle(ID, {
      branding: { name: 'Shop' },
      contact: { email: 'a@b.com' },
      theme: { font: 'x', gone: null },
      social: { set: { instagram: 'u' }, remove: ['tiktok'] },
      settings: { contact: { b: 2 }, mcpWriteEnabled: false },
      blogEnabled: true,
    });
    expect(h.patch).toHaveBeenCalledTimes(1);
    const patch = h.patch.mock.calls[0][1];
    expect(patch.fields).toMatchObject({ name: 'Shop', email: 'a@b.com', blogEnabled: true });
    expect(patch.json).toEqual({
      theme: { set: { font: 'x' }, remove: ['gone'] },
      socialLinks: { set: { instagram: 'u' }, remove: ['tiktok'] },
      // settings.contact is merged one level deep INSIDE the DO transaction (#739 review), never read-modify-written here
      settings: { set: {}, merge: { contact: { b: 2 } } },
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it('a refused bundle surfaces the error and no part is written separately', async () => {
    h.patch.mockRejectedValueOnce(new Error('refused'));
    await expect(
      StoreService.updateBrandingBundle(ID, { branding: { name: 'S' }, settings: { a: 1 } })
    ).rejects.toThrow('refused');
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('updateTheme on a DO store sends ONE theme key patch (null removes a key) and never reads the theme to merge', async () => {
    await StoreService.updateTheme(ID, { font: 'x', gone: null, color: '#fff' });
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch.mock.calls[0][0]).toBe(ID);
    expect(h.patch.mock.calls[0][1]).toEqual({
      json: { theme: { set: { font: 'x', color: '#fff' }, remove: ['gone'] } },
    });
  });

  it('patchSocialLinks (PUT /:id/social) on a DO store sends the {set,remove} patch', async () => {
    await StoreService.patchSocialLinks(ID, { set: { instagram: 'u' }, remove: ['tiktok'] });
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch.mock.calls[0][1]).toEqual({
      json: { socialLinks: { set: { instagram: 'u' }, remove: ['tiktok'] } },
    });
  });
});
