/**
 * FORCE-API-2D ("Can't reach database server", P1001) and FORCE-API-2E
 * ("Server has closed the connection.", P1017): one transient Neon
 * connection failure inside `FeatureService.readFromDb` 500'd
 * `GET /public/store/resolve`. The read now retries ONCE on a fresh
 * `withRlsBypass` transaction — and still fails CLOSED if the retry fails
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
    withRlsBypass: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ store: { findUnique }, storeFeature: { findMany } })
    ),
  };
});

vi.mock('@force/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withRlsBypass,
}));

import { featureService } from '@api/services/feature.service';

const connectionError = (code: string) =>
  Object.assign(new Error(`prisma ${code}`), { name: 'PrismaClientKnownRequestError', code });

describe('FeatureService — transient DB connection failure', () => {
  beforeEach(() => {
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
