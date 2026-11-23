import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notifyStore, sendNotice, invalidateCache, bustStoreCaches } = vi.hoisted(() => ({
  notifyStore: vi.fn(),
  sendNotice: vi.fn(),
  invalidateCache: vi.fn(),
  bustStoreCaches: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () => ({
          name: 'Shop',
          slug: 'shop',
          domain: null,
          settings: { defaultLanguage: 'ar' },
          ownerId: 'u1',
          owner: { email: 'm@example.com' },
        }),
      },
      storeSubscription: { findUnique: async () => ({ planCode: 'starter' }) },
      plan: { findMany: async () => [{ code: 'starter', nameEn: 'Starter', nameAr: 'ستارتر' }] },
    }),
}));
vi.mock('../../config', () => ({ config: { adminUrl: 'https://admin.test' } }));
vi.mock('../../lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../email.service', () => ({
  EmailService: { sendSubscriptionBillingNotice: sendNotice },
}));
vi.mock('../socket.service', () => ({ socketService: { notifyStore } }));
vi.mock('../feature.service', () => ({ featureService: { invalidateCache } }));
vi.mock('../store.service', () => ({ bustStoreCaches }));
vi.mock('./account.service', () => ({ reconcileStoreAccess: vi.fn(), instapayDetails: vi.fn() }));
vi.mock('./grants.service', () => ({ awardGrantsAfterPayment: vi.fn() }));
vi.mock('./manual-config', () => ({
  supportContact: () => ({ whatsappUrl: 'https://wa.me/1', email: 's@example.com' }),
}));
vi.mock('@ebda/shared', async importOriginal => ({
  // the add-on catalog (pulled in by billing-notify) reads the shared feature registry, so keep the real module
  ...(await importOriginal<object>()),
  purchaseEventId: () => 'e',
  billingPaymentNumber: () => 'n',
  EBDA_BILLING_BARCODE_SHAPE: 'x',
}));
vi.mock('../ebda-ads-emit', () => ({ emitEbdaConversion: vi.fn() }));
vi.mock('../barcode-image.service', () => ({ ensureEmailBarcode: vi.fn() }));

import { runBillingEffects } from './billing-notify';

beforeEach(() => vi.clearAllMocks());

describe('merchant billing notices (S2-1/2, S2-11)', () => {
  it('tells the merchant why an InstaPay receipt was rejected: bell + email with the reason', async () => {
    await runBillingEffects([
      { kind: 'payment_rejected', storeId: 's1', note: 'المبلغ غير مطابق' },
    ]);
    expect(notifyStore).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'billing_payment_rejected',
        message: expect.stringContaining('المبلغ غير مطابق'),
      })
    );
    expect(sendNotice).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ kind: 'payment_rejected', reason: 'المبلغ غير مطابق' }),
      'ar'
    );
  });

  it('a canceled store is told orders are paused, never that Free limits apply', async () => {
    await runBillingEffects([{ kind: 'downgraded', storeId: 's1', reason: 'canceled' }]);
    const note = notifyStore.mock.calls[0]![1] as { message: string };
    expect(note.message).toContain('مش هيستقبل طلبات جديدة');
    expect(note.message).not.toMatch(/Free|المجانية/);
    expect(sendNotice).not.toHaveBeenCalled();
  });
});

describe('add-on grant / refund drops EVERY entitlement layer (review of #775)', () => {
  it('addon_granted clears the feature map AND the public store payload at once', async () => {
    await runBillingEffects([{ kind: 'addon_granted', storeId: 's1' }]);
    expect(invalidateCache).toHaveBeenCalledWith('s1');
    expect(bustStoreCaches).toHaveBeenCalledWith('s1', 'shop', null);
  });
});
