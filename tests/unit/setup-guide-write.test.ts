/**
 * N-19: the setup-guide writers no longer call `syncStoreFields`. Postgres store: one atomic statement (merge nested in SQL) and the
 * DO copy gets the whole RETURNING value. D1 + DO store: a write-time read-merge through `storeUpdate` with the whole `settings`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  onDo: false,
  settings: {} as Record<string, unknown>,
  updates: [] as unknown[],
  copies: [] as unknown[],
  sql: [] as string[],
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    $queryRaw: async (s: TemplateStringsArray) => {
      h.sql.push(s.join('?'));
      h.settings = { setupGuide: { manual: { share: true }, dismissed: false } };
      return [{ settings: h.settings }];
    },
  },
  withStore: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeWritesToDo: async () => h.onDo,
  storeDb: async () => ({
    store: { findUnique: async () => ({ settings: h.settings }) },
  }),
  storeUpdate: async (_db: unknown, args: unknown) => void h.updates.push(args),
  copyStoreSettings: async (_id: string, f: unknown) => void h.copies.push(f),
}));

import { SetupGuideService } from '../../apps/api/src/services/setup-guide.service';

beforeEach(() => {
  h.onDo = false;
  h.settings = { keep: 1, setupGuide: { manual: { a: true }, dismissed: true } };
  h.updates.length = 0;
  h.copies.length = 0;
  h.sql.length = 0;
  vi.spyOn(SetupGuideService, 'get').mockResolvedValue({} as never);
});

describe('setup guide writers (N-19)', () => {
  it('Postgres store: one atomic UPDATE ... RETURNING, DO copy gets the whole settings value', async () => {
    await SetupGuideService.setManual('s1', 'share', true);
    expect(h.sql).toHaveLength(1);
    expect(h.sql[0]).toContain('RETURNING settings');
    expect(h.copies).toEqual([
      { settings: { setupGuide: { manual: { share: true }, dismissed: false } } },
    ]);
    expect(h.updates).toEqual([]);
  });
  it('D1 + DO store: whole-value storeUpdate, siblings kept, no raw SQL', async () => {
    h.onDo = true;
    await SetupGuideService.setManual('s1', 'share', false);
    await SetupGuideService.setDismissed('s1', false);
    expect(h.sql).toEqual([]);
    expect(h.updates[0]).toMatchObject({
      where: { id: 's1' },
      data: {
        settings: { keep: 1, setupGuide: { manual: { a: true, share: false }, dismissed: true } },
      },
    });
    expect(h.updates[1]).toMatchObject({
      data: { settings: { keep: 1, setupGuide: { manual: { a: true }, dismissed: false } } },
    });
  });
});
