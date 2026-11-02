/**
 * testConnection must never report success for a channel it did not test (Ruling TESTCONN-1).
 * push: really checked (platform VAPID keys + at least one subscribed device). whatsapp and any other
 * channel: reported "not testable", success false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, cfg } = vi.hoisted(() => ({
  mockPrisma: { pushSubscription: { count: vi.fn() } },
  cfg: { vapidPublicKey: 'pub', vapidPrivateKey: 'priv' },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  withStore: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/config', () => ({ config: cfg }));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/encryption.service', () => ({ encryption: {} }));
vi.mock('@api/services/sms.service', () => ({ smsService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { notificationConfigService } from '@api/services/notification-config.service';

beforeEach(() => {
  vi.clearAllMocks();
  cfg.vapidPublicKey = 'pub';
  cfg.vapidPrivateKey = 'priv';
});

describe('NotificationConfigService.testConnection is never a fake success', () => {
  it.each(['push', 'push_notifications'])(
    '%s: succeeds only with VAPID keys and a device',
    async ch => {
      mockPrisma.pushSubscription.count.mockResolvedValue(3);
      const r = await notificationConfigService.testConnection('store-1', ch);
      expect(r.success).toBe(true);
      expect(mockPrisma.pushSubscription.count).toHaveBeenCalledWith({
        where: { storeId: 'store-1' },
      });
    }
  );

  it('push: fails when the platform VAPID keys are missing, without touching the database', async () => {
    cfg.vapidPrivateKey = '';
    const r = await notificationConfigService.testConnection('store-1', 'push');
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/VAPID|not configured/i);
    expect(mockPrisma.pushSubscription.count).not.toHaveBeenCalled();
  });

  it('push: fails and says why when no device is subscribed (nothing to deliver to)', async () => {
    mockPrisma.pushSubscription.count.mockResolvedValue(0);
    const r = await notificationConfigService.testConnection('store-1', 'push');
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/no device/i);
  });

  it.each(['whatsapp', 'email', 'nonsense'])(
    '%s: reported not testable, never success',
    async ch => {
      const r = await notificationConfigService.testConnection('store-1', ch);
      expect(r).toMatchObject({ success: false });
      expect(r.message).toMatch(/not testable/i);
    }
  );
});
