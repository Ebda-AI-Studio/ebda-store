/**
 * Add-on paid by InstaPay (Ruling ADDON-SS-6): the receipt opens an approval-queue entry and grants NOTHING; only the
 * super-admin approval settles the ledger row (once, through the same guarded transition as a card payment); reject or
 * silence leaves nothing active; the plan approval path can never approve an add-on claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claim: null as any,
  held: null as any,
  claimEvent: vi.fn(),
  settle: vi.fn(),
  submitReceipt: vi.fn(),
  quote: vi.fn(),
  markReviewed: vi.fn(),
  deleteImages: vi.fn(),
  updated: [] as any[],
  handle: 'ebda@instapay' as string | null,
}));

vi.mock('@api/services/billing/subscription-billing.service', () => ({
  claimEvent: h.claimEvent,
  settleApprovedPayment: h.settle,
}));
vi.mock('@api/services/billing/account.service', () => ({
  newPaymentReference: () => 'EBD-TESTREF1',
  submitSubscriptionReceipt: h.submitReceipt,
}));
vi.mock('@api/services/billing/addons.service', () => ({ quoteAddon: h.quote }));
vi.mock('@api/services/billing/manual-config', () => ({
  instapayHandle: () => h.handle,
  instapayQrUrl: () => null,
}));
vi.mock('@api/services/billing/charge-amount', () => ({
  resolvePlatformVat: async () => ({}),
  vatOfPaidAmount: (n: number) => ({ netMinor: n, vatMinor: 0, totalMinor: n, vat: null }),
}));
vi.mock('@api/services/payment-providers/instapay-receipt.service', () => ({
  InstapayReceiptService: { markReviewed: h.markReviewed, deleteImages: h.deleteImages },
}));
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (t: unknown) => unknown) =>
    fn({
      manualPaymentClaim: {
        findFirst: async () => h.claim,
        updateMany: async (a: unknown) => (h.updated.push(a), { count: 1 }),
      },
      billingEvent: { findFirst: async () => h.held },
      storeSubscription: { findUnique: async () => ({ paymentReference: null }) },
      instapayReceipt: { findFirst: async () => ({ id: 'r1' }) },
    }),
}));

import {
  addonInstapayInstructions,
  approveAddonClaim,
  submitAddonReceipt,
} from '@api/services/billing/addon-instapay';

const claim = (over: Record<string, any> = {}) => ({
  id: 'c1',
  storeId: 's1',
  planCode: 'addon:feature:loyalty',
  status: 'pending',
  amountMinor: 9900,
  payerReference: 'TXN123',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.updated = [];
  h.handle = 'ebda@instapay';
  h.claim = claim();
  h.held = null;
  h.claimEvent.mockResolvedValue('ev1');
  h.settle.mockResolvedValue({ transitioned: true });
  h.submitReceipt.mockResolvedValue({ claim: { id: 'c1', status: 'pending' }, receipt: {} });
  h.quote.mockResolvedValue({
    item: { sku: 'feature:loyalty' },
    amount: { totalMinor: 9900, vatMinor: 1200 },
  });
});

describe('merchant side: submit never grants', () => {
  it('the receipt opens a claim for the QUOTED total with the add-on code; no ledger row, no settle', async () => {
    await submitAddonReceipt({
      storeId: 's1',
      sku: 'feature:loyalty',
      receiptId: 'r1',
      fields: {} as never,
    });
    expect(h.submitReceipt).toHaveBeenCalledTimes(1);
    expect(h.submitReceipt.mock.calls[0][0].addon).toEqual({
      planCode: 'addon:feature:loyalty',
      amountMinor: 9900,
    });
    expect(h.quote).toHaveBeenCalledWith('s1', 'feature:loyalty', { card: false });
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('InstaPay not configured: refused before anything is created', async () => {
    h.handle = null;
    await expect(
      submitAddonReceipt({
        storeId: 's1',
        sku: 'feature:loyalty',
        receiptId: 'r1',
        fields: {} as never,
      })
    ).rejects.toMatchObject({ code: 'INSTAPAY_NOT_CONFIGURED' });
    expect(h.submitReceipt).not.toHaveBeenCalled();
  });

  it('a second purchase while one waits is refused by the quote (no double claim)', async () => {
    const { AppError } = await import('@api/middleware/error-handler');
    h.quote.mockRejectedValue(new AppError(409, 'ADDON_AWAITING_CONFIRMATION', 'waiting'));
    await expect(
      submitAddonReceipt({
        storeId: 's1',
        sku: 'feature:loyalty',
        receiptId: 'r2',
        fields: {} as never,
      })
    ).rejects.toMatchObject({ code: 'ADDON_AWAITING_CONFIRMATION' });
    expect(h.submitReceipt).not.toHaveBeenCalled();
  });

  it('instructions: exact total (VAT included), handle and a reference; nothing is written', async () => {
    const i = await addonInstapayInstructions('s1', 'feature:loyalty');
    expect(i).toMatchObject({
      handle: 'ebda@instapay',
      amountMinor: 9900,
      reference: 'EBD-TESTREF1',
    });
    expect(h.claimEvent).not.toHaveBeenCalled();
  });
});

describe('super-admin approval', () => {
  it('approve: ONE ledger row keyed by the claim, settled once, claim confirmed, receipt approved', async () => {
    const out = await approveAddonClaim({ storeId: 's1', claimId: 'c1', actorId: 'admin1' });
    expect(out.billingEventId).toBe('ev1');
    expect(h.claimEvent.mock.calls[0][0]).toMatchObject({
      type: 'upgrade',
      planCode: 'addon:feature:loyalty',
      amountMinor: 9900,
      provider: 'instapay',
      idempotencyKey: 'addon-instapay:c1',
    });
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.settle.mock.calls[0][0]).toBe('ev1');
    expect(h.updated[0].data).toMatchObject({ status: 'confirmed', reviewedBy: 'admin1' });
    expect(h.updated[0].where.status).toBe('pending');
    expect(h.markReviewed).toHaveBeenCalledWith('s1', 'r1', { status: 'approved' }, 'admin1');
  });

  it('a replay (row already claimed) resumes the SAME event: never a second row', async () => {
    h.claimEvent.mockResolvedValue(null);
    h.held = { id: 'ev-held' };
    const out = await approveAddonClaim({ storeId: 's1', claimId: 'c1', actorId: 'admin1' });
    expect(out.billingEventId).toBe('ev-held');
    expect(h.settle.mock.calls[0][0]).toBe('ev-held');
  });

  it('a rejected claim cannot be approved: nothing is settled', async () => {
    h.claim = claim({ status: 'rejected' });
    await expect(
      approveAddonClaim({ storeId: 's1', claimId: 'c1', actorId: 'a' })
    ).rejects.toMatchObject({ code: 'CLAIM_NOT_PENDING' });
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('a PLAN claim is not an add-on claim: 404, nothing settled', async () => {
    h.claim = claim({ planCode: 'growth' });
    await expect(
      approveAddonClaim({ storeId: 's1', claimId: 'c1', actorId: 'a' })
    ).rejects.toMatchObject({ code: 'CLAIM_NOT_FOUND' });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('an add-on that is no longer sold cannot be approved (reject it instead)', async () => {
    h.claim = claim({ planCode: 'addon:feature:gone' });
    await expect(
      approveAddonClaim({ storeId: 's1', claimId: 'c1', actorId: 'a' })
    ).rejects.toMatchObject({ code: 'ADDON_NOT_FOUND' });
    expect(h.settle).not.toHaveBeenCalled();
  });
});
