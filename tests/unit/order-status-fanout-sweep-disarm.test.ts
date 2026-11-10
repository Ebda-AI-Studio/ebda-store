/**
 * CF-PAY-1: the status-fanout stuck sweep disarms a superseded transition through the Durable Object money op for a DO
 * order and through the Postgres `withStore` branch ONLY when `storeMoney()` is null. Behaviour, not source order: the
 * real sweep runs with `storeMoney` / `withStore` / `sweepStoresDb` replaced by spies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  disarm: vi.fn(async (_a: { orderId: string; requestedAt: number }) => true),
  money: { current: null as null | { fanoutDisarm: (a: never) => Promise<boolean> } },
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ order: { updateMany: async () => ({ count: 1 }) } })
  ),
  sweep: vi.fn(),
}));
vi.mock('@api/lib/jobs/store-db', () => ({ sweepStoresDb: h.sweep }));
vi.mock('@api/lib/repo-factory', () => ({ storeMoney: async () => h.money.current }));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  withStore: h.withStore,
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, fn: unknown) => fn, send: vi.fn() },
}));
vi.mock('@api/services/redis.service', () => ({ redis: { acquireLock: async () => true } }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));

import { handleOrderStatusFanoutStuckSweep } from '@api/lib/inngest/functions/order-status-fanout-stuck-sweep';

const requestedAt = new Date(Date.now() - 60 * 60_000);
const superseded = {
  id: 'o1',
  storeId: '11111111-1111-4111-8111-111111111111',
  status: 'shipped',
  paymentStatus: 'paid',
  statusFanoutRequestedAt: requestedAt,
  statusFanoutRequestedStatus: 'confirmed', // the order moved on since: superseded
};
const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };

beforeEach(() => {
  h.disarm.mockClear();
  h.withStore.mockClear();
  h.sweep.mockReset();
  // stepRunUnlessEmpty reads twice (probe, then inside the step); the failed-after-claim read is empty.
  h.sweep
    .mockResolvedValueOnce([superseded])
    .mockResolvedValueOnce([superseded])
    .mockResolvedValue([]);
});

describe('stuck status-fanout sweep: disarming a superseded transition', () => {
  it('a DO order is disarmed by the DO money op and never touches Postgres', async () => {
    h.money.current = { fanoutDisarm: h.disarm as never };
    await handleOrderStatusFanoutStuckSweep(step);
    expect(h.disarm).toHaveBeenCalledTimes(1);
    expect(h.disarm).toHaveBeenCalledWith({ orderId: 'o1', requestedAt: requestedAt.getTime() });
    expect(h.withStore).not.toHaveBeenCalled();
  });

  it('a Postgres order (no money op) is disarmed through withStore only', async () => {
    h.money.current = null;
    await handleOrderStatusFanoutStuckSweep(step);
    expect(h.withStore).toHaveBeenCalledTimes(1);
    expect(h.disarm).not.toHaveBeenCalled();
  });
});
