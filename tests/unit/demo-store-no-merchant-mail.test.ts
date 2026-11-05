/**
 * A demo store (the looks showroom, `is_demo`) has no merchant: no merchant-facing mail, no store-scoped alert (2026-11-05, the
 * Dahab showroom mailed "selling paused" to the operator). The choke points are `EmailService.sendMerchantNotice` and `sendAlert`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  demo: new Set<string>(),
  sent: [] as Array<{ storeId: string; to: unknown }>,
  queued: [] as string[],
  fetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
}));

vi.mock('@api/lib/demo-store', () => ({ isDemoStore: async (id: string) => h.demo.has(id) }));
vi.mock('@api/services/store-mailer.service', () => ({
  StoreMailer: {
    sendBrandedEmail: async (storeId: string, o: { to: unknown }) => {
      h.sent.push({ storeId, to: o.to });
      return { id: 'm1' };
    },
  },
}));
vi.mock('@api/services/email-queue.service', () => ({
  emailQueue: {
    enqueue: async (storeId: string | null) => {
      h.queued.push(String(storeId));
    },
  },
}));
vi.mock('@api/services/mail-transport', () => ({ sendMail: async () => ({ id: 'p1' }) }));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    extra: {
      withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
        fn({
          store: {
            findUnique: async () => ({
              id: 's',
              name: 'Shop',
              nameAr: null,
              logo: null,
              theme: null,
              look: null,
              template: null,
              email: null,
              phone: null,
              address: null,
              settings: {},
              domain: null,
              emailSenderLocalPart: null,
              emailDomainStatus: null,
            }),
          },
        }),
    },
  })
);
vi.mock('@api/services/redis.service', () => ({
  redis: { acquireLock: async () => true, releaseLock: async () => undefined },
}));
vi.mock('@api/config', () => ({
  config: new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'telegramBotToken' ? 'tok' : k === 'telegramAlertChatId' ? 'chat' : 'test',
    }
  ),
}));

import { EmailService } from '@api/services/email.service';
import { sendAlert } from '@api/services/alerts.service';

const DEMO = 'demo-store';
const REAL = 'real-store';
beforeEach(() => {
  h.demo = new Set([DEMO]);
  h.sent = [];
  h.queued = [];
  h.fetch.mockClear();
  vi.stubGlobal('fetch', h.fetch);
});

const gold = (id: string) =>
  EmailService.sendGoldRateNotice(id, 'blocked', {
    to: 'owner@example.com',
    storeName: 'Shop',
    adminUrl: 'https://admin.example',
    hours: 26,
    maxHours: 26,
  });

describe('merchant notices skip a demo store', () => {
  it('gold rate notice: demo -> nothing sent, real -> sent', async () => {
    await gold(DEMO);
    expect(h.sent).toEqual([]);
    await gold(REAL);
    expect(h.sent).toEqual([{ storeId: REAL, to: 'owner@example.com' }]);
  });

  it('queued merchant notices (webhook disabled) skip a demo store and queue for a real one', async () => {
    const data = {
      to: 'o@example.com',
      storeName: 'Shop',
      adminUrl: 'https://a',
      url: 'https://hook',
    } as never;
    await EmailService.sendWebhookDisabledNotice(DEMO, data);
    expect(h.queued).toEqual([]);
    await EmailService.sendWebhookDisabledNotice(REAL, data);
    expect(h.queued).toEqual([REAL]);
  });
});

describe('store-scoped alerts skip a demo store', () => {
  const alert = (id: string, scope: 'store' | 'platform') =>
    sendAlert({
      level: 'p1',
      scope,
      ...(scope === 'store' ? { store: { id, name: 'Shop' } } : {}),
      title: `t-${id}-${scope}`,
    });

  it('demo store: no Telegram call', async () => {
    await alert(DEMO, 'store');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('real store and platform scope still page', async () => {
    await alert(REAL, 'store');
    await alert(DEMO, 'platform');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});
