/**
 * Admin switcher API for EXISTING stores: a store may keep (re-save) its current skin, but cannot
 * switch INTO a bare skin (legacy skins closed; built ones only via a look, gated on registry status).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LOOKS, builtSkins } from '@ebda/shared';

const m = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { update: m.update } }),
}));

import { StoreService } from '@api/services/store.service';

const LEGACY = ['modern', 'elegant', 'classic', 'minimal', 'bold'] as const;

function existing(template: string, look: string | null = null) {
  vi.spyOn(StoreService, 'getById').mockResolvedValue({ id: 's1', template, look } as never);
  vi.spyOn(StoreService, 'invalidateCache').mockResolvedValue(undefined as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  m.update.mockReset();
  m.update.mockResolvedValue({ id: 's1', slug: 's', domain: null });
});

describe('StoreService.updateTemplate', () => {
  it.each(LEGACY)('cannot switch INTO legacy skin %s', async skin => {
    existing(builtSkins()[0]!);
    await expect(StoreService.updateTemplate('s1', skin)).rejects.toMatchObject({
      code: 'INVALID_TEMPLATE',
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('an existing legacy store can re-save its own current skin (not a switch)', async () => {
    existing('classic');
    await StoreService.updateTemplate('s1', 'classic');
    expect(m.update).toHaveBeenCalledTimes(1);
  });

  it('cannot switch into a bare built skin either: Qamar is only reachable through a look (Ruling B1-17)', async () => {
    existing('classic');
    await expect(StoreService.updateTemplate('s1', builtSkins()[0]!)).rejects.toMatchObject({
      code: 'INVALID_TEMPLATE',
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('applyLook refuses a look that is not built, unless it is the store’s current look', async () => {
    const designed = LOOKS.find(l => l.status === 'designed')!;
    existing('classic', null);
    await expect(
      StoreService.applyLook('s1', designed.id, { design: 'keep' })
    ).rejects.toMatchObject({ code: 'LOOK_NOT_AVAILABLE' });
  });
});
