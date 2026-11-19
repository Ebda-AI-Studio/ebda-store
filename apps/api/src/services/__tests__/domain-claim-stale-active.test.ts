import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  store: null as null | Record<string, unknown>,
  updates: [] as unknown[],
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  storeDirectory: vi.fn(async () => []),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => state.store } }),
}));
vi.mock('../../lib/repo-factory', () => ({
  storeUpdate: vi.fn(),
  storeUpdateMany: vi.fn(async (_tx: unknown, args: unknown) => {
    state.updates.push(args);
    return { count: 1 };
  }),
}));
vi.mock('../../lib/definer', () => ({ storeIdByDomain: vi.fn(), storeIdsClaimingDomain: vi.fn() }));
vi.mock('../../lib/abuse-config', () => ({ abuseConfig: { domainClaimTtlHours: () => 72 } }));
vi.mock('../../lib/cors-cache', () => ({ bustCorsCache: vi.fn() }));
vi.mock('../../lib/public-cache', () => ({ invalidateCached: vi.fn() }));
vi.mock('../redis.service', () => ({ redis: {} }));
vi.mock('../store.service', () => ({ bustStoreCaches: vi.fn(async () => undefined) }));

import { DomainClaimService } from '../domain-claim.service';

const provider = (verified: boolean) =>
  ({
    getDomain: vi.fn(async (d: string) => ({ domain: d, verified, failed: false, dnsRecords: [] })),
    removeDomain: vi.fn(),
    addDomain: vi.fn(),
    isConfigured: () => true,
    providerName: 'cloudflare',
  }) as never;

beforeEach(() => {
  state.updates = [];
  vi.spyOn(DomainClaimService, 'afterDomainChanged').mockResolvedValue(undefined as never);
});

describe('STORE-QA-40 a served domain stuck short of active gets reconciled', () => {
  const stuck = {
    id: 's1',
    slug: 'amelia',
    domain: 'ameliaaurum.com',
    domainStatus: 'pending',
    pendingDomain: null,
    domainClaimedAt: null,
  };
  it('domain set, status pending, no pending claim, provider says verified -> activated', async () => {
    state.store = stuck;
    const r = await DomainClaimService.sync('s1', provider(true));
    expect(r.action).toBe('activated');
    expect((state.updates[0] as { data: { domainStatus: string } }).data.domainStatus).toBe(
      'active'
    );
  });
  it('provider says not verified -> untouched (the subdomain fallback stays)', async () => {
    state.store = stuck;
    const r = await DomainClaimService.sync('s1', provider(false));
    expect(r.action).toBe('none');
    expect(state.updates).toHaveLength(0);
  });
  it('an already active domain makes no provider call', async () => {
    state.store = { ...stuck, domainStatus: 'active' };
    const p = provider(true);
    const r = await DomainClaimService.sync('s1', p);
    expect(r.action).toBe('none');
    expect(
      (p as unknown as { getDomain: ReturnType<typeof vi.fn> }).getDomain
    ).not.toHaveBeenCalled();
  });
});
