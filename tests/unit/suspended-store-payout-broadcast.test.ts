/**
 * Ruling SUSPEND-OUT-1, money-out + broadcast + sweep entry points. A store that is not `active`:
 * - cannot create an affiliate payout (423 STORE_NOT_OPERATIONAL, the money layer is never reached),
 * - cannot push-broadcast to its storefront subscribers (OneSignal is never called),
 * - is not swept for cart-recovery email (no claim, no event).
 * Each refused case FAILS on the code before this change. An active store is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  active: { value: false },
  directory: [] as Array<{ id: string; status: string }>,
  money: vi.fn(),
  fetch: vi.fn(),
  configFind: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@api/lib/definer', () => ({
  lookupStore: async (m: { id?: string }) =>
    h.active.value ? { id: m.id, status: 'active' } : null,
  adminPushPlayerIds: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  hasTenantContext: () => false,
  withMoneyTx: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
  withStore: (_id: string, fn: (t: unknown) => unknown) => fn({}),
  withUser: (_id: string, fn: (t: unknown) => unknown) => fn({}),
  storeDirectory: async (f?: (s: { id: string; status: string }) => boolean) =>
    h.directory.filter(s => (f ? f(s) : true)),
  acrossStoresFlat: async (fn: (id: string) => Promise<unknown[]>) =>
    (await Promise.all(h.directory.map(s => fn(s.id)))).flat(),
  runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeWriter: vi.fn(),
  storeWritesToDo: vi.fn(),
  storeMoney: async () => {
    h.money();
    return null;
  },
  storeRepo: async () => ({
    backend: 'pg',
    db: {
      abandonedCartConfig: { findMany: h.configFind },
      abandonedCart: { findMany: async () => [] },
    },
    writer: {},
  }),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: h.emit, createFunction: vi.fn() } }));
vi.mock('@api/services/affiliate-event.service', () => ({
  recordAffiliateEvent: vi.fn(),
  affiliateEventCreate: vi.fn(),
}));
vi.mock('@api/services/platform/cutover', () => ({ platformFamilyOnD1: () => false }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/services/store-mailer.service', () => ({ StoreMailer: {} }));
vi.mock('@api/lib/campaign-send-pacer', () => ({ awaitCampaignSendSlot: vi.fn() }));
vi.mock('@api/config', () => ({
  config: { onesignalAppId: 'app', onesignalRestApiKey: 'key', webUrl: 'https://ebda.app' },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { affiliateService } from '@api/services/affiliate.service';
import { pushService } from '@api/services/push.service';
import { sweepCartRecoveryEmails } from '@api/services/cart-recovery-email.service';

beforeEach(() => {
  vi.clearAllMocks();
  h.active.value = false;
  h.directory = [];
  h.configFind.mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    h.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'n1' }), text: async () => '' })
  );
});

describe('affiliate payout (money out)', () => {
  it('a suspended store is refused with 423 before the money layer is touched', async () => {
    await expect(
      affiliateService.createPayout('s1', 'aff1', { amount: 1000, method: 'bank' } as never)
    ).rejects.toMatchObject({ statusCode: 423, code: 'STORE_NOT_OPERATIONAL' });
    expect(h.money).not.toHaveBeenCalled();
  });

  it('an active store reaches the money layer (unchanged)', async () => {
    h.active.value = true;
    await affiliateService
      .createPayout('s1', 'aff1', { amount: 1000, method: 'bank' } as never)
      .catch(() => undefined);
    expect(h.money).toHaveBeenCalled();
  });
});

describe('push broadcast to storefront subscribers', () => {
  const input = { titleEn: 't', titleAr: 't', bodyEn: 'b', bodyAr: 'b' };

  // Merchant broadcasts moved from OneSignal to native Web Push (pushService.broadcastToStore); the gate moved with it.
  it('a suspended store is refused with 423 and no push is sent', async () => {
    // PUSH-AUDIENCE-1: the broadcast no longer goes through `sendToStore`; it calls the one private delivery path.
    const send = vi.spyOn(pushService as never, 'deliver').mockResolvedValue({} as never);
    await expect(pushService.broadcastToStore('s1', input)).rejects.toMatchObject({
      statusCode: 423,
      code: 'STORE_NOT_OPERATIONAL',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('an active store broadcasts (unchanged)', async () => {
    h.active.value = true;
    const send = vi.spyOn(pushService as never, 'deliver').mockResolvedValue({} as never);
    await pushService.broadcastToStore('s1', input);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('cart-recovery email sweep', () => {
  it('reads the channel config only for active stores', async () => {
    h.directory = [
      { id: 'live', status: 'active' },
      { id: 'down', status: 'suspended' },
    ];
    await sweepCartRecoveryEmails();
    expect(h.configFind).toHaveBeenCalledTimes(1);
  });
});
