/**
 * An InstaPay add-on claim can only be approved by `approveAddonClaim`. The plan path ("Record manual payment") must
 * refuse it, or approving an add-on claim would activate a PLAN.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ planCode: 'addon:feature:loyalty' }));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    withStore: async (_id: string, fn: (t: unknown) => unknown) =>
      fn({ manualPaymentClaim: { findFirst: async () => ({ planCode: h.planCode }) } }),
  };
});

import { recordManualPayment } from '@api/services/billing/account.service';

const input = {
  storeId: '11111111-1111-4111-8111-111111111111',
  planCode: 'growth',
  interval: 'monthly' as const,
  amountMinor: 9900,
  method: 'instapay' as const,
  reference: 'TXN12345',
  paidAt: new Date(),
  actorId: 'admin',
  claimId: '22222222-2222-4222-8222-222222222222',
};

describe('recordManualPayment vs an add-on claim', () => {
  it('refuses with USE_ADDON_APPROVAL before touching any plan or ledger state', async () => {
    await expect(recordManualPayment(input)).rejects.toMatchObject({ code: 'USE_ADDON_APPROVAL' });
  });
});
