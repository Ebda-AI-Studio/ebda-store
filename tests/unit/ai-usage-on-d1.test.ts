/**
 * Ruling NZ-AN-1: `ai_usage` is one platform table. Before its `ai-usage` marker every call is Postgres; after it every
 * `prisma.aiUsage.*` call and the platform-wide quota count are answered by D1 (append-only rows, client-side ids), and
 * per-store and platform-wide counts agree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ onD1: true, rows: [] as Array<Record<string, any>>, pgCalls: 0 }));
const d1 = {
  aiUsage: {
    create: async ({ data }: { data: Record<string, any> }) => {
      if (h.rows.some(r => r.id === data.id))
        throw Object.assign(new Error('P2002'), { code: 'P2002' });
      h.rows.push({ ...data, createdAt: data.createdAt ?? new Date() });
      return data;
    },
    count: async ({ where }: { where: Record<string, any> }) =>
      h.rows.filter(
        r =>
          (!where.storeId || r.storeId === where.storeId) &&
          (where.cachedHit === undefined || r.cachedHit === where.cachedHit) &&
          (!where.feature || r.feature === where.feature) &&
          (!where.createdAt?.gte || r.createdAt >= where.createdAt.gte)
      ).length,
  },
};
vi.mock('@api/services/platform/cutover', async orig => ({
  ...(await orig<typeof import('@api/services/platform/cutover')>()),
  platformFamilyOnD1: async () => h.onD1,
  platformFamilyOnD1ForWrite: async () => h.onD1,
}));
vi.mock('@api/lib/platform-db', () => ({ requirePlatformDb: async () => d1 }));
vi.mock('@ebda/database', async () => {
  const actual = (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: () => {
          h.pgCalls++;
          throw new Error('Postgres touched');
        },
      }
    ),
  });
  return { ...actual, notifyModelWrite: vi.fn(), setModelRouter: vi.fn() };
});

import { countAiUsage } from '@api/lib/definer';
import { platformRouter } from '@api/services/platform/router';
import { FAMILY_MODELS } from '@api/services/platform/cutover';

beforeEach(() => {
  h.onD1 = true;
  h.rows.length = 0;
  h.pgCalls = 0;
});

describe('ai-usage family', () => {
  it('owns the aiUsage delegate, so the router answers it', () => {
    expect(FAMILY_MODELS['ai-usage']).toEqual(['aiUsage']);
    expect(platformRouter.models.has('aiUsage')).toBe(true);
  });

  it('after the marker create goes to D1 (never Postgres) and a retried id is one row', async () => {
    const pg = vi.fn(async () => {
      throw new Error('Postgres leg taken');
    });
    const data = { id: 'a1', storeId: 's1', feature: 'seo', cachedHit: false };
    await platformRouter.route('aiUsage', 'create', [{ data }], pg);
    await expect(platformRouter.route('aiUsage', 'create', [{ data }], pg)).rejects.toThrow(
      'P2002'
    );
    expect(h.rows).toHaveLength(1);
    expect(pg).not.toHaveBeenCalled();
  });

  it('before the marker the Postgres leg answers', async () => {
    h.onD1 = false;
    const pg = vi.fn(async () => 'from-pg');
    expect(await platformRouter.route('aiUsage', 'count', [{ where: {} }], pg)).toBe('from-pg');
    expect(h.rows).toHaveLength(0);
  });

  it('the platform-wide quota count spans stores on D1 and per-store counts add up to it', async () => {
    const since = new Date(Date.now() - 1000);
    for (const [i, store] of ['s1', 's1', 's2'].entries())
      await platformRouter.route(
        'aiUsage',
        'create',
        [{ data: { id: `r${i}`, storeId: store, feature: 'seo', cachedHit: false } }],
        async () => null
      );
    await platformRouter.route(
      'aiUsage',
      'create',
      [{ data: { id: 'c', storeId: 's2', feature: 'seo', cachedHit: true } }],
      async () => null
    );
    expect(await countAiUsage({ since, cachedHit: false })).toBe(3);
    expect(await countAiUsage({ since, cachedHit: true })).toBe(1);
    const per = await Promise.all(
      ['s1', 's2'].map(storeId =>
        platformRouter.route(
          'aiUsage',
          'count',
          [{ where: { storeId, cachedHit: false } }],
          async () => 0
        )
      )
    );
    expect((per as number[]).reduce((a, b) => a + b, 0)).toBe(3);
    expect(h.pgCalls).toBe(0);
  });
});
