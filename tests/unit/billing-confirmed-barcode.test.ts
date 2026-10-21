/**
 * The InstaPay "payment confirmed" email (Ebda's billing payment receipt) carries the PALM barcode
 * of the payment number when the PNG is ready, and goes out without it when not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { billingPaymentNumber } from '@ebda/shared';

const { sendNotice, ensure } = vi.hoisted(() => ({ sendNotice: vi.fn(), ensure: vi.fn() }));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
          ownerId: 'o1',
          owner: { email: 'o@x.co' },
        }),
      },
      storeSubscription: { findUnique: async () => ({ planCode: 'growth' }) },
      plan: { findMany: async () => [{ code: 'growth', nameEn: 'Growth', nameAr: 'النمو' }] },
    }),
}));
vi.mock('../../apps/api/src/config', () => ({ config: { adminUrl: 'https://store.ebda.app' } }));
vi.mock('@api/services/email.service', () => ({
  EmailService: { sendSubscriptionBillingNotice: sendNotice },
}));
vi.mock('@api/services/socket.service', () => ({ socketService: { notifyStore: vi.fn() } }));
vi.mock('@api/services/feature.service', () => ({ featureService: { invalidateCache: vi.fn() } }));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/services/billing/account.service', () => ({
  reconcileStoreAccess: vi.fn(),
  instapayDetails: vi.fn(),
}));
vi.mock('@api/services/billing/manual-config', () => ({ supportContact: () => ({}) }));
vi.mock('@api/services/ebda-ads-emit', () => ({ emitEbdaConversion: vi.fn() }));
vi.mock('@api/services/barcode-image.service', () => ({ ensureEmailBarcode: ensure }));

import { runBillingEffects } from '@api/services/billing/billing-notify';

const EVENT = '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d';
const effect = {
  kind: 'payment_confirmed' as const,
  storeId: 's1',
  planCode: 'growth',
  periodEnd: new Date('2026-11-21'),
  billingEventId: EVENT,
};
const IMG = {
  url: 'https://cdn.ebda.app/stores/s1/barcodes/0123456789abcdef0123456789abcdef.png',
  width: 360,
  height: 130,
};

beforeEach(() => vi.clearAllMocks());

describe('payment_confirmed email barcode', () => {
  it('requests the palm PNG of the hashed payment number and passes it to the email', async () => {
    ensure.mockResolvedValue(IMG);
    await runBillingEffects([effect]);
    const number = billingPaymentNumber(EVENT);
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 's1', kind: 'billing', number, shape: 'palm' })
    );
    expect(sendNotice.mock.calls[0]![1]).toMatchObject({
      kind: 'payment_confirmed',
      barcode: IMG,
      paymentNumber: number,
    });
  });
  it('image not ready: the notice still goes out without it', async () => {
    ensure.mockResolvedValue(null);
    await runBillingEffects([effect]);
    expect(sendNotice).toHaveBeenCalledTimes(1);
    expect(sendNotice.mock.calls[0]![1].barcode).toBeNull();
  });
  it('an effect without an event id (legacy callers) sends no barcode and still sends', async () => {
    await runBillingEffects([{ ...effect, billingEventId: undefined }]);
    expect(ensure).not.toHaveBeenCalled();
    expect(sendNotice).toHaveBeenCalledTimes(1);
  });
  it('other kinds never ask for one', async () => {
    await runBillingEffects([{ kind: 'payment_rejected', storeId: 's1', note: 'x' }]);
    expect(ensure).not.toHaveBeenCalled();
  });
});
