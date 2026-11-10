/**
 * Jobs that failed on the Worker because a Prisma option or a Postgres transaction reached a layer that no longer has it
 * (Ruling NZ-D23; sweep: docs/cf/jobs-postgres-removed-sweep.md). Both run against the REAL layers, not a mock that cannot see them:
 *  - `bulk-ai-recommendations` read its smart-skip set with `distinct`, which the DO read client (prisma-lite over SQLite here,
 *    the same engine the StoreDO runs) refuses: "prisma-lite: distinct is not supported";
 *  - `ci-outcomes` (`ci/onboarding-step`) read the store setup through `runInTenantContext`, a Postgres `$transaction`: the
 *    removed-Postgres client the Worker shell binds (`runWithRequestDb(createPostgresRemovedClient)`) throws PostgresRemovedError.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPostgresRemovedClient,
  PostgresRemovedError,
  runWithRequestDb,
} from '@ebda/database';
import {
  createDoClient,
  createPrismaLite,
  decodeRpc,
  encodeRpc,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { META, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const OWNER = '7a1c1d5e-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  repo: { current: undefined as unknown },
  brief: vi.fn(),
  send: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: h.send },
}));
vi.mock('../../apps/api/src/config', async importActual => {
  const actual = await importActual<typeof import('../../apps/api/src/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      vapidPublicKey: 'pub',
      vapidPrivateKey: 'priv',
      vapidSubject: 'mailto:ops@example.test',
    },
  };
});
vi.mock('../../apps/api/src/services/notification-config.service', () => ({
  notificationConfigService: { getConfig: async () => ({ enabled: true }) },
}));
vi.mock('../../apps/api/src/lib/analytics-backend', () => ({
  analyticsWrite: async () => undefined,
}));

vi.mock('../../apps/api/src/lib/repo-factory', async importActual => {
  const actual = await importActual<typeof import('../../apps/api/src/lib/repo-factory')>();
  return { ...actual, storeRepo: async () => h.repo.current };
});
vi.mock('../../apps/api/src/lib/identity-client', () => ({ getAccountsBrief: h.brief }));

describe('bulk-ai-recommendations smart-skip read on the real DO read engine', () => {
  it('returns each source product once, with no `distinct` option', async () => {
    const { sourceProductIdsWithRecs } =
      await import('../../apps/api/src/lib/inngest/functions/bulk-ai-recommendations');
    const sqlite = openSqlite();
    sqlite.exec('PRAGMA foreign_keys = OFF');
    const lite = createPrismaLite(META as never, nodeSqlRunner(sqlite), 'store-do', {
      storeId: STORE,
    });
    const db = createDoClient(q => runReads(lite as never, q)) as never;
    const rec = (id: string, src: string, tgt: string) => ({
      id,
      storeId: STORE,
      sourceProductId: src,
      targetProductId: tgt,
      score: 0.5,
      generatedAt: new Date('2026-11-01T00:00:00Z'),
    });
    insertSqlite(sqlite, 'AiRecommendation', [
      rec('r1', 'p1', 'p2'),
      rec('r2', 'p1', 'p3'),
      rec('r3', 'p2', 'p1'),
    ]);
    const ids = await sourceProductIdsWithRecs(db, STORE);
    expect([...ids].sort()).toEqual(['p1', 'p2']);
  });
});

describe('ci-outcomes onboarding step on a Worker with no Postgres', () => {
  it('reads the store setup through the store backend, never a Postgres transaction', async () => {
    const { prismaCiSource } = await import('../../apps/api/src/lib/ci/source');
    const { doStoreDelegate } = await import('../../apps/api/src/lib/repo-factory');
    const stub = {
      storeRecord: async () => ({
        ok: true,
        data: {
          json: encodeRpc({ template: 'souq', ciSharing: true, ownerId: OWNER }),
          missing: [],
        },
      }),
    };
    h.repo.current = {
      backend: 'do',
      db: { store: doStoreDelegate(STORE, stub as never, decodeRpc as never) },
    };
    h.brief.mockResolvedValue([{ id: OWNER, createdAt: '2026-10-01T00:00:00.000Z' }]);

    const facts = await runWithRequestDb(
      () => createPostgresRemovedClient(),
      () => prismaCiSource.storeSetup(STORE)
    );
    expect(facts).toEqual({
      ownerSignupAt: new Date('2026-10-01T00:00:00.000Z'),
      template: 'souq',
      ciSharing: true,
    });
    const sharing = await runWithRequestDb(
      () => createPostgresRemovedClient(),
      () => prismaCiSource.storeCiSharing(STORE)
    );
    expect(sharing).toBe(true);
  });

  it('control: a Postgres transaction under the same client does throw PostgresRemovedError', async () => {
    const { runInTenantContext } = await import('@ebda/database');
    await expect(
      runWithRequestDb(
        () => createPostgresRemovedClient(),
        () => runInTenantContext(STORE, async () => 1)
      )
    ).rejects.toBeInstanceOf(PostgresRemovedError);
  });
});

describe('push fan-out (dispatched by every order job) on a Worker with no Postgres', () => {
  it('reads push_subscriptions through the store DO and delivers, never touching the Postgres client', async () => {
    const { pushService } = await import('../../apps/api/src/services/push.service');
    const sqlite = openSqlite();
    sqlite.exec('PRAGMA foreign_keys = OFF');
    const sql = nodeSqlRunner(sqlite);
    ensureIdempotencySchema(sql);
    const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
    const c = createDoClient(
      q => runReads(lite, q),
      m => runWrites(lite, sql, m)
    );
    h.repo.current = { storeId: STORE, backend: 'do', db: c, writer: c };
    const sub = (id: string, endpoint: string) => ({
      id,
      storeId: STORE,
      endpoint,
      p256dh: 'k',
      auth: 'a',
      audience: 'storefront',
      createdAt: new Date('2026-11-01T00:00:00Z'),
    });
    insertSqlite(sqlite, 'PushSubscription', [sub('s1', 'https://gone'), sub('s2', 'https://ok')]);
    h.send.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint === 'https://gone')
        throw Object.assign(new Error('gone'), { statusCode: 410 });
    });

    await runWithRequestDb(
      () => createPostgresRemovedClient(),
      () => pushService.sendToStore(STORE, 't', 'b')
    );

    expect(h.send).toHaveBeenCalledTimes(2);
    // Residual (docs/cf/jobs-postgres-removed-sweep.md): PushSubscription is not DO-writable yet, so pruning the expired
    // endpoint is refused by the DO and only logged; the delivery above must not depend on it.
  });
});
