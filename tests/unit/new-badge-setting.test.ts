/**
 * Ruling D1016-NEW-1 (Ahmad 2026-10-16, "New badge = merchant choice"): the card "New" badge is a
 * store setting, `theme.showNewBadge`, default OFF. This file covers the merchant half: the admin
 * toggle (ar + en, next to the other product-card toggles), the API edge (Zod: a boolean or null,
 * never a string), and the save path busting every cache layer. The storefront half (every card
 * path incl. Dahab and the 4 mappers) is `apps/web/src/templates/card-new-badge.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { updateMock, findUniqueMock, invalidateCached, invalidateCachedPrefix, revalidate } =
  vi.hoisted(() => ({
    updateMock: vi.fn(),
    findUniqueMock: vi.fn(),
    invalidateCached: vi.fn(),
    invalidateCachedPrefix: vi.fn(),
    revalidate: vi.fn(),
  }));

vi.mock('@ebda/database', () => ({
  prisma: { store: { findUnique: findUniqueMock, update: updateMock } },
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      ...(await import('@ebda/database')).prisma,
      product: { count: async () => 0 },
      category: { count: async () => 0 },
      order: { count: async () => 0 },
    }),
  acrossStores: async () => [],
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached,
  invalidateCachedPrefix,
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({
  revalidateStorefront: revalidate,
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));
vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn(),
}));

import { themeSchema } from '../../apps/api/src/lib/theme-schema';
import { StoreService } from '../../apps/api/src/services/store.service';

const ROOT = join(__dirname, '../..');
const STORE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => vi.clearAllMocks());

describe('API edge: PUT /stores/:id/theme accepts showNewBadge only as a boolean', () => {
  it.each([true, false, null])('accepts %s', v => {
    expect(themeSchema.safeParse({ showNewBadge: v }).success).toBe(true);
  });
  it.each(['true', 'false', 1, 0, {}])('refuses %j', v => {
    const r = themeSchema.safeParse({ showNewBadge: v });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('showNewBadge');
  });
  it('store.routes uses this schema for the theme PUT', () => {
    const src = readFileSync(join(ROOT, 'apps/api/src/routes/store.routes.ts'), 'utf8');
    expect(src).toMatch(/import \{ themeSchema \} from '\.\.\/lib\/theme-schema'/);
    expect(src).toMatch(/const theme = themeSchema\.parse\(req\.body\)/);
  });
});

describe('save path: turning the badge on busts every cache layer', () => {
  it('merges the flag and busts the store payload (KV + memory), product lists and the Next cache', async () => {
    findUniqueMock.mockResolvedValue({
      id: STORE_ID,
      slug: 'demo',
      domain: 'shop.example',
      theme: { primaryColor: '0 0% 4%' },
    });
    updateMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: STORE_ID, slug: 'demo', domain: 'shop.example', ...data })
    );
    await StoreService.updateTheme(STORE_ID, { showNewBadge: true });
    const merged = updateMock.mock.calls[0][0].data.theme;
    expect(merged).toEqual({ primaryColor: '0 0% 4%', showNewBadge: true });
    const keys = invalidateCached.mock.calls.map(c => c[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        `public:store:${STORE_ID}`,
        'public:store:demo',
        'public:store:resolve:shop.example',
      ])
    );
    expect(invalidateCachedPrefix).toHaveBeenCalledWith(`public:products:${STORE_ID}:`);
    expect(revalidate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'demo', domain: 'shop.example' })
    );
  });
});

describe('admin: the toggle lives in the visual editor theme pane, in ar and en', () => {
  it('is a checkbox in the "Product cards" group with ar and en labels', async () => {
    const { THEME_SETTINGS_SCHEMA, DRAFT_THEME_KEYS } = await import('@ebda/shared');
    const group = THEME_SETTINGS_SCHEMA.find(g => g.id === 'cards')!;
    const s = group.settings.find(x => x.id === 'showNewBadge')!;
    expect(s.type).toBe('checkbox');
    expect(s.labelEn).toMatch(/New/);
    expect(s.labelAr).toMatch(/[ء-ي]/);
    expect(s.hintAr).toMatch(/[ء-ي]/);
    // it rides the draft theme like every editor theme key (published with the page)
    expect(DRAFT_THEME_KEYS).toContain('showNewBadge');
  });
  it('the panel anchors it for the admin search', () => {
    const panel = readFileSync(
      join(ROOT, 'apps/admin/src/app/stores/[id]/builder/_components/ThemeSettingsPanel.tsx'),
      'utf8'
    );
    expect(panel).toContain('data-setting-id="builder.card-new-badge"');
  });
});
