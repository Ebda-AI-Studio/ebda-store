/**
 * #625: a status answer with no amounts (Kashier's order-search projection) must reach the confirm path as UNKNOWN
 * (undefined), never 0. A 0 read as "paid nothing" held a captured order as underpaid forever; unknown lets the confirm
 * path fall back to the amount the payment was created for, exactly as for any gateway that does not report it.
 */
import { describe, expect, it } from 'vitest';
import { V2ProviderBridge } from '@api/services/payment-providers/v2-bridge';
import type { PaymentProviderV2, PaymentStatusV2 } from '@api/services/payment-providers/types';

const bridgeWith = (st: PaymentStatusV2) =>
  new V2ProviderBridge(
    { name: 'kashier', getStatus: async () => st } as unknown as PaymentProviderV2,
    {} as never
  );

describe('V2ProviderBridge.getPaymentStatus amounts (#625)', () => {
  it('no amounts in the answer: paidAmount / refundedAmount are undefined, not 0', async () => {
    const r = await bridgeWith({
      status: 'completed',
      amountMinor: 0,
      capturedMinor: 0,
      refundedMinor: 0,
      currency: 'EGP',
      amountsKnown: false,
    }).getPaymentStatus('ORD-1');
    expect(r.status).toBe('completed');
    expect(r.paidAmount).toBeUndefined();
    expect(r.refundedAmount).toBeUndefined();
  });

  it('known amounts pass through unchanged (an underpayment is still visible to the amount gate)', async () => {
    const r = await bridgeWith({
      status: 'completed',
      amountMinor: 85000,
      capturedMinor: 40000,
      refundedMinor: 0,
      currency: 'EGP',
    }).getPaymentStatus('ORD-2');
    expect(r.paidAmount).toBe(40000);
    expect(r.refundedAmount).toBe(0);
  });
});
