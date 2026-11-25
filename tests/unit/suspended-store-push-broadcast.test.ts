/**
 * Ruling SUSPEND-OUT-1 on the native Web Push broadcast path (merchant form + assistant `push_broadcast` tool both call
 * `pushService.broadcastToStore`): a store that is not `active` sends nothing to its shoppers; an active store unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: { value: 'suspended' as string },
  sendNotification: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('@api/lib/definer', () => ({
  lookupStore: async (m: { id?: string }) =>
    h.status.value === 'active' ? { id: m.id, status: 'active' } : null,
}));
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: h.sendNotification },
}));
vi.mock('@api/config', () => ({
  config: { vapidPublicKey: 'pub', vapidPrivateKey: 'priv', vapidSubject: 'mailto:a@b.test' },
}));
vi.mock('@api/services/notification-config.service', () => ({
  notificationConfigService: { getConfig: h.getConfig },
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  withStoreRw: async (_s: string, fn: (tx: unknown) => unknown) =>
    fn({
      pushSubscription: {
        findMany: async () => [
          { id: 'p1', endpoint: 'https://push.test/1', p256dh: 'k', auth: 'a' },
        ],
        deleteMany: async () => ({ count: 0 }),
      },
    }),
}));
vi.mock('@api/lib/analytics-backend', () => ({
  analyticsRead: vi.fn(),
  analyticsWrite: async () => undefined,
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_s: string, fn: (tx: unknown) => unknown) => fn({}),
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  currentStoreId: () => 's1',
}));

import { pushService } from '@api/services/push.service';

const input = { titleEn: 'T', titleAr: 'ع', bodyEn: 'B', bodyAr: 'ن' };

beforeEach(() => {
  h.sendNotification.mockReset().mockResolvedValue({});
  h.getConfig.mockReset().mockResolvedValue({ enabled: true });
});

describe('push broadcast and a suspended store', () => {
  it('a suspended store: refused with 423 and not one push is sent', async () => {
    h.status.value = 'suspended';
    await expect(pushService.broadcastToStore('s1', input)).rejects.toMatchObject({
      statusCode: 423,
    });
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it('an active store still sends', async () => {
    h.status.value = 'active';
    const r = await pushService.broadcastToStore('s1', input);
    expect(r.delivered).toBe(1);
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
  });
});
