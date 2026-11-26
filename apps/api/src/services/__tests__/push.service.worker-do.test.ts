import { describe, it, expect, vi, beforeEach } from 'vitest';

// POSTGRES_REMOVED class: `prisma.pushSubscription.*` outside a store scope has no Postgres on the Worker. GET /admin/stores/:id/
// push/status (getSubscriberCount), the storefront subscribe and unsubscribe must read/write through the store's own backend.
const m = vi.hoisted(() => ({
  count: vi.fn(async () => 7),
  upsert: vi.fn(async () => ({})),
  deleteMany: vi.fn(async () => ({ count: 1 })),
  withStoreRw: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: () => {
        throw new Error('POSTGRES_REMOVED: bare prisma touched');
      },
    }
  ),
  currentStoreId: () => 'st1',
  withStore: vi.fn(),
  runInTenantContext: vi.fn(),
}));
vi.mock('../../lib/jobs/store-db', () => ({
  withStoreRw: async (_id: string, fn: (tx: unknown) => unknown) => {
    m.withStoreRw(_id);
    return fn({ pushSubscription: { count: m.count, upsert: m.upsert, deleteMany: m.deleteMany } });
  },
}));
vi.mock('../../lib/analytics-backend', () => ({ analyticsRead: vi.fn(), analyticsWrite: vi.fn() }));
vi.mock('../../lib/store-operational', () => ({ assertStoreOperational: vi.fn() }));
vi.mock('../notification-config.service', () => ({ notificationConfigService: {} }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

import { pushService } from '../push.service';

describe('PushService on the Worker (no Postgres)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('getSubscriberCount reads through the store backend', async () => {
    await expect(pushService.getSubscriberCount('st1')).resolves.toBe(7);
    expect(m.withStoreRw).toHaveBeenCalledWith('st1');
  });
  it('subscribe upserts through the store backend', async () => {
    await pushService.subscribe('st1', { endpoint: 'e', p256dh: 'p', auth: 'a' });
    expect(m.upsert).toHaveBeenCalledTimes(1);
  });
  it('unsubscribe deletes through the store backend', async () => {
    await pushService.unsubscribe('e');
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { endpoint: 'e', storeId: 'st1' } });
  });
});
