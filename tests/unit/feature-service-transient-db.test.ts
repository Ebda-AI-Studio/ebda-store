/**
 * EBDA-API-2D ("Can't reach database server", P1001) and EBDA-API-2E
 * ("Server has closed the connection.", P1017): one transient Neon
 * connection failure inside `FeatureService.readFromDb` 500'd
 * `GET /public/store/resolve`. The read now retries ONCE on a fresh
 * `withStore` transaction — and still fails CLOSED if the retry fails
 * too, because this map gates paid features.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() },
}));

const { findUnique, findMany, withRlsBypass } = vi.hoisted(() => {
  const findUnique = vi.fn();
  const findMany = vi.fn();
  return {
    findUnique,
    findMany,
    withRlsBypass: vi.fn(async (_storeId: string, fn: (tx: unknown) => unknown) =>
      fn({
        store: { findUnique },
        storeFeature: { findMany },
        // plans engine (SP5): no subscription row -> resolved from the legacy enum
        storeSubscription: { findUnique: vi.fn().mockResolvedValue(null) },
        plan: { findUnique: vi.fn().mockResolvedValue(null) },
      })
    ),
  };
});

vi.mock('@api/services/billing/addon-grant', () => ({ activeAddons: async () => [] }));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: withRlsBypass,
}));

import { featureService } from '@api/services/feature.service';

const connectionError = (code: string) =>
  Object.assign(new Error(`prisma ${code}`), { name: 'PrismaClientKnownRequestError', code });

describe('FeatureService — transient DB connection failure', () => {
  beforeEach(() => {
    // Clear the process-wide outage window a previous case may have opened.
    (featureService as unknown as { connectionOutageAt: number }).connectionOutageAt = 0;
    findUnique.mockReset();
    findMany.mockReset().mockResolvedValue([{ featureKey: 'inventory.backorder', enabled: true }]);
    withRlsBypass.mockClear();
  });

  it.each(['P1001', 'P1017'])(
    '%s once → retried on a fresh transaction, request succeeds',
    async code => {
      findUnique.mockRejectedValueOnce(connectionError(code)).mockResolvedValue({ plan: 'free' });

      await expect(
        featureService.isFeatureEnabled(`store-${code}`, 'inventory.backorder')
      ).resolves.toBe(true);
      expect(withRlsBypass).toHaveBeenCalledTimes(2);
    }
  );

  it('fails CLOSED when the retry fails too — never a guessed feature map', async () => {
    findUnique.mockRejectedValue(connectionError('P1017'));

    await expect(
      featureService.isFeatureEnabled('store-down', 'inventory.backorder')
    ).rejects.toMatchObject({ code: 'P1017' });
    expect(withRlsBypass).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-connection error', async () => {
    findUnique.mockRejectedValue(connectionError('P2010'));

    await expect(
      featureService.isFeatureEnabled('store-raw', 'inventory.backorder')
    ).rejects.toMatchObject({ code: 'P2010' });
    expect(withRlsBypass).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue 1991 — during a SUSTAINED outage the retry doubled the connection
 * attempts on the hottest read. After a read whose retry also failed, retries
 * are suspended for a short window: each read still makes one attempt (so
 * recovery is seen immediately), it just stops paying for a second.
 *
 * Mutation proof: pass `retries: DB_READ_RETRY.retries` unconditionally → the
 * first case sees 2 attempts and goes red.
 */
describe('FeatureService — retry suspended during a sustained outage (issue 1991)', () => {
  const state = featureService as unknown as { connectionOutageAt: number };
  beforeEach(() => {
    state.connectionOutageAt = 0;
    findUnique.mockReset();
    findMany.mockReset().mockResolvedValue([]);
    withRlsBypass.mockClear();
  });

  it('after a failed retry, the next read makes ONE attempt, not two', async () => {
    findUnique.mockRejectedValue(connectionError('P1001'));
    await expect(featureService.getStoreFeatures('outage-a')).rejects.toMatchObject({
      code: 'P1001',
    });
    expect(withRlsBypass).toHaveBeenCalledTimes(2);

    withRlsBypass.mockClear();
    await expect(featureService.getStoreFeatures('outage-b')).rejects.toMatchObject({
      code: 'P1001',
    });
    expect(withRlsBypass).toHaveBeenCalledTimes(1);
  });

  it('still reads (and succeeds) inside the window — recovery is seen at once', async () => {
    state.connectionOutageAt = Date.now();
    findUnique.mockResolvedValue({ plan: 'free' });
    await expect(featureService.getStoreFeatures('recovered')).resolves.toBeDefined();
    expect(withRlsBypass).toHaveBeenCalledTimes(1);
    // A success closes the window.
    expect(state.connectionOutageAt).toBe(0);
  });

  it('the window expires: retries resume after it', async () => {
    state.connectionOutageAt = Date.now() - 60_000;
    findUnique.mockRejectedValueOnce(connectionError('P1017')).mockResolvedValue({ plan: 'free' });
    await expect(featureService.getStoreFeatures('later')).resolves.toBeDefined();
    expect(withRlsBypass).toHaveBeenCalledTimes(2);
  });
});
