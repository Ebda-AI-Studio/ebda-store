/**
 * Admin switcher API for EXISTING stores: a store may keep (re-save) its current Ebda template, but
 * cannot switch INTO a bare one (built ones only via a look, gated on registry status). The retired
 * Force skins are refused on every write, even as a re-save (Rulings SKIN-DEL-1, SKIN-DEL-8).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LOOKS, RETIRED_TEMPLATES, builtSkins } from '@ebda/shared';

const m = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { update: m.update } }),
}));

import { StoreService } from '@api/services/store.service';

const LEGACY = RETIRED_TEMPLATES;

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
  it.each(LEGACY)('cannot switch INTO retired skin %s (TEMPLATE_RETIRED)', async skin => {
    existing(builtSkins()[0]!);
    await expect(StoreService.updateTemplate('s1', skin)).rejects.toMatchObject({
      code: 'TEMPLATE_RETIRED',
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it.each(LEGACY)(
    'a store still holding retired skin %s cannot re-save it either: no write, no cache bust',
    async skin => {
      existing(skin);
      await expect(StoreService.updateTemplate('s1', skin)).rejects.toMatchObject({
        code: 'TEMPLATE_RETIRED',
      });
      expect(m.update).not.toHaveBeenCalled();
      expect(StoreService.invalidateCache).not.toHaveBeenCalled();
    }
  );

  it('an Ebda store can re-save its own current template (not a switch)', async () => {
    existing('qamar');
    await StoreService.updateTemplate('s1', 'qamar');
    expect(m.update).toHaveBeenCalledTimes(1);
  });

  it('cannot switch into a bare built skin either: Qamar is only reachable through a look (Ruling B1-17)', async () => {
    existing(LEGACY[0]);
    await expect(StoreService.updateTemplate('s1', builtSkins()[0]!)).rejects.toMatchObject({
      code: 'INVALID_TEMPLATE',
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('applyLook refuses a look that is not built, unless it is the store’s current look', async () => {
    // every look is built since Phase B5: flip one back for the check
    const designed = LOOKS[LOOKS.length - 1]!;
    (designed as { status: string }).status = 'designed';
    try {
      existing(LEGACY[0], null);
      await expect(
        StoreService.applyLook('s1', designed.id, { design: 'keep' })
      ).rejects.toMatchObject({ code: 'LOOK_NOT_AVAILABLE' });
    } finally {
      (designed as { status: string }).status = 'built';
    }
  });
});
