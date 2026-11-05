/**
 * Rulings NZ-PG-2 and NZ-PG-6: with the platform D1 bound and the `access` / `audit` markers set, the definers, crons and routes
 * that used to ask Postgres answer without it. `prisma` here THROWS on any use: a path that still reaches it fails the test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accessOnD1: true,
  auditOnD1: true,
  d1Bound: true,
  account: null as null | Record<string, unknown>,
  cachedTv: null as number | null,
  merchantKeysRevoked: [] as string[],
  alerts: [] as Array<Record<string, unknown>>,
  stale: { count: 0, oldestMs: null as number | null },
  staleThrows: false,
  indexHits: {} as Record<string, string>,
  fanout: {} as Record<string, string | null>,
  backend: 'do' as 'do' | 'pg',
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: prisma.${String(p)}`);
        },
      }
    ),
  })
);
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => h.accessOnD1,
  ownedStoreIdsD1: async () => [],
}));
vi.mock('@api/services/platform/cutover', () => ({
  auditStoreLessOnD1: async () => h.auditOnD1,
  assertFamilyWritableOnPostgres: async () => undefined,
  assertNotFrozen: async () => undefined,
  isFamilyFrozen: async () => false,
  platformFamilyOnD1: async () => false,
}));
vi.mock('@api/services/platform/platform-d1', () => ({
  revokeUserMerchantKeysD1: async (id: string) => void h.merchantKeysRevoked.push(id),
  adminPushPlayerIdsD1: async () => [],
  inboxGetD1: async () => null,
  inboxListD1: async () => [],
  inboxRecordD1: async () => undefined,
  inboxStuckD1: async () => [],
  inboxUpdateD1: async () => undefined,
  withdrawLegalSendD1: async () => 0,
}));
vi.mock('@api/services/platform/push-d1', () => ({ adminPushPlayerIdsD1: async () => [] }));
vi.mock('@api/services/platform/billing-d1', () => ({
  onD1: async () => false,
  entityStoreIdD1: async () => null,
  planSubscriberCountsD1: async () => new Map(),
  refundStoreIdD1: async () => null,
  storeIdsOnPlanD1: async () => [],
  acrossBilling: async () => [],
  deferBillingWebhookD1: async () => true,
  listDeferredBillingWebhooksD1: async () => [],
  planTierDriftD1: async () => [],
  staleDeferredBillingWebhooksD1: async () => {
    if (h.staleThrows) throw new Error('D1 down');
    return h.stale;
  },
}));
vi.mock('@api/lib/platform-directory', () => ({
  platformDb: () => (h.d1Bound ? {} : undefined),
  d1LookupStore: async () => null,
  d1PublicStorePage: async () => ({ rows: [], total: 0 }),
  d1StoreIdByDomain: async () => null,
  d1StoreIdBySlug: async () => null,
  d1StoreIdsClaimingDomain: async () => [],
}));
vi.mock('@api/lib/platform-db', () => ({ requirePlatformDb: async () => ({}) }));
vi.mock('@api/lib/store-backend', () => ({
  backendFor: async () => h.backend,
  hasStoresOnBackend: async () => false,
}));
vi.mock('@ebda-src/repo', () => ({
  resolveStoreId: async (_d1: unknown, kind: string, id: string) =>
    h.indexHits[`${kind}:${id}`] ?? null,
}));
vi.mock('@api/lib/entity-store-fanout', () => ({
  entityStoreByFanout: async (kind: string, id: string) => h.fanout[`${kind}:${id}`] ?? null,
}));
vi.mock('@api/lib/identity-client', () => ({
  getAccountState: async () => h.account,
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    getUserTokenVersion: async () => h.cachedTv,
    setUserTokenVersion: async (_id: string, v: number) => {
      h.cachedTv = v;
    },
  },
}));
vi.mock('@api/services/audit-sink', () => ({ appendAudit: async () => undefined }));
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => (h.d1Bound ? { PLATFORM_DB: {} } : undefined),
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: async (a: Record<string, unknown>) => void h.alerts.push(a),
}));
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as definer from '@api/lib/definer';

beforeEach(() => {
  h.accessOnD1 = true;
  h.auditOnD1 = true;
  h.d1Bound = true;
  h.account = null;
  h.cachedTv = null;
  h.merchantKeysRevoked = [];
  h.alerts = [];
  h.stale = { count: 0, oldestMs: null };
  h.staleThrows = false;
  h.indexHits = {};
  h.fanout = {};
  h.backend = 'do';
});

describe('NZ-PG-2: identity definers with `access` on D1', () => {
  it('getUserState comes from the identity service; a customer or a stranger is unknown (blocked)', async () => {
    h.account = { id: 'u1', role: 'store_admin', status: 'active' };
    h.cachedTv = 4;
    expect(await definer.getUserState('u1')).toEqual({
      id: 'u1',
      role: 'store_admin',
      status: 'active',
      tokenVersion: 4,
      storeId: null,
      deletedAt: null,
    });
    h.account = { id: 'c1', role: 'customer', status: 'active' };
    expect(await definer.getUserState('c1')).toBeNull();
    h.account = null;
    expect(await definer.getUserState('x')).toBeNull();
  });

  it('the lookups and deletes answer without Postgres', async () => {
    expect(await definer.findUserIdByEmail('a@b.co', null)).toBeNull();
    expect(await definer.refreshTokenUser('tok')).toBeNull();
    expect(await definer.verificationTokenUser('tok')).toBeNull();
    expect(await definer.passkeyLookup('cred')).toBeNull();
    expect(await definer.deleteUserPasskeys('u')).toBe(0);
    expect(await definer.deleteUserTokens('u')).toBe(0);
    expect(await definer.deleteUserAddresses('u')).toBe(0);
    expect(await definer.purgeRefreshTokens(new Date(), new Date())).toBe(0);
  });

  it('revokeUserSessionsRow bumps the cached token version and revokes the D1 merchant keys', async () => {
    h.cachedTv = 2;
    expect(await definer.revokeUserSessionsRow('u1')).toEqual({ tokenVersion: 3 });
    expect(h.cachedTv).toBe(3);
    expect(h.merchantKeysRevoked).toEqual(['u1']);
  });

  it('ensureAdminUser refuses (410) instead of calling the Postgres definer', async () => {
    await expect(
      definer.ensureAdminUser({
        email: 'a@b.co',
        passwordHash: 'x',
        firstName: 'a',
        lastName: 'b',
        role: 'staff',
      })
    ).rejects.toMatchObject({ statusCode: 410, code: 'PG_ACCOUNTS_REMOVED' });
  });
});

describe('NZ-PG-2: audit retention after the `audit` marker', () => {
  it('count / page / purge answer empty without Postgres', async () => {
    const cutoff = new Date(Date.now() - 100 * 86_400_000);
    expect(await definer.auditRetention.count(cutoff)).toBe(0);
    expect(await definer.auditRetention.page(cutoff, null, 10)).toEqual([]);
    expect(await definer.auditRetention.purge(cutoff, 10)).toBe(0);
  });
});

describe('NZ-PG-2: getEntityStoreId with the D1 bound', () => {
  it('order and customer come from the D1 entity index', async () => {
    h.indexHits = { 'order:o1': 'store-a', 'customer:c1': 'store-b' };
    expect(await definer.getEntityStoreId('order', 'o1')).toBe('store-a');
    expect(await definer.getEntityStoreId('customer', 'c1')).toBe('store-b');
  });

  it('product, journal entry and bulk-import job are found by the DO probe', async () => {
    h.fanout = {
      'product:p1': 'store-c',
      'journal_entry:j1': 'store-d',
      'bulk_import_job:b1': 'store-e',
    };
    expect(await definer.getEntityStoreId('product', 'p1')).toBe('store-c');
    expect(await definer.getEntityStoreId('journal_entry', 'j1')).toBe('store-d');
    expect(await definer.getEntityStoreId('bulk_import_job', 'b1')).toBe('store-e');
  });

  it('an unknown id is null with no Postgres read (no `pg` store exists)', async () => {
    expect(await definer.getEntityStoreId('product', 'nope')).toBeNull();
    expect(await definer.getEntityStoreId('order', 'nope')).toBeNull();
    expect(await definer.getEntityStoreId('customer', 'nope')).toBeNull();
  });
});

describe('NZ-PG-6: deferred billing webhooks with no marker', () => {
  it('pages a P1 once for rows older than 30 minutes, then stays quiet for 6 hours', async () => {
    const svc = await import('@api/services/billing/subscription-billing.service');
    svc.resetOrphanedDeferredAlert();
    h.stale = { count: 3, oldestMs: Date.now() - 3_600_000 };
    expect(await svc.alertOrphanedDeferredWebhooks()).toBe(true);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      level: 'p1',
      source: 'billing.deferred_webhooks_orphaned',
    });
    expect(String(h.alerts[0].body)).toContain('3 authenticated billing webhook');
    expect(await svc.alertOrphanedDeferredWebhooks()).toBe(false);
    expect(await svc.alertOrphanedDeferredWebhooks(Date.now() + 7 * 3_600_000)).toBe(true);
  });

  it('no stale row: no alert; D1 unbound: no check; D1 down: logged, never thrown', async () => {
    const svc = await import('@api/services/billing/subscription-billing.service');
    svc.resetOrphanedDeferredAlert();
    expect(await svc.alertOrphanedDeferredWebhooks()).toBe(false);
    h.d1Bound = false;
    h.stale = { count: 9, oldestMs: 1 };
    expect(await svc.alertOrphanedDeferredWebhooks()).toBe(false);
    h.d1Bound = true;
    h.staleThrows = true;
    expect(await svc.alertOrphanedDeferredWebhooks()).toBe(false);
    expect(h.alerts).toHaveLength(0);
  });

  it('the cron entry alerts only when the marker is absent', async () => {
    const svc = await import('@api/services/billing/subscription-billing.service');
    svc.resetOrphanedDeferredAlert();
    h.stale = { count: 1, oldestMs: Date.now() - 4_000_000 };
    expect(await svc.processDeferredBillingWebhooks()).toBe(0); // onD1() mock = false: no marker
    expect(h.alerts).toHaveLength(1);
    expect(svc.ORPHANED_DEFERRED_AFTER_MS).toBe(30 * 60_000);
  });
});
