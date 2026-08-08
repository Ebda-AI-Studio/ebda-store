import { describe, it, expect } from 'vitest';
import { decideAutoCancelAction } from '../../apps/api/src/lib/inngest/functions/order-auto-cancel-unpaid';

// The auto-cancel sweep used to cancel any order still pending/unpaid past the
// threshold WITHOUT ever asking the provider whether the money had actually
// been captured. `paymentStatus='unpaid'` only means "nothing ever told us it
// was paid" — and all three things that normally tell us can miss the same
// order at once: the webhook is lost (or, for MyFatoorah, is account-level and
// never fires per-invoice) AND the customer never returns to the success page
// (closed the tab / dead battery / lost signal), so verify-on-return never
// runs either.
//
// The result was a captured payment whose order got cancelled, its stock
// released, and an "order cancelled" email sent to a customer who had paid.
//
// `decideAutoCancelAction` is the gating logic that now stands in front of the
// cancel, extracted pure (matching the `bulk-import` /
// `webhook-offload.guard.ts` pattern in this directory) so the money-critical
// branch is testable without Inngest steps, RLS context, or a provider client.
describe('decideAutoCancelAction', () => {
  describe('the bug this fix exists for', () => {
    it('RESCUES an order the provider reports as paid instead of cancelling it', () => {
      expect(
        decideAutoCancelAction({
          hasGatewayPayment: true,
          providerReachable: true,
          providerStatus: 'completed',
        })
      ).toBe('reconcile_paid');
    });
  });

  describe('fail-closed: unknown is not the same as unpaid', () => {
    it('SKIPS rather than cancels when the provider call threw', () => {
      expect(
        decideAutoCancelAction({
          hasGatewayPayment: true,
          providerReachable: false,
        })
      ).toBe('skip');
    });

    it('skips even when a stale status is still in scope — unreachable wins', () => {
      // Guards the ordering inside the function: the unreachable check MUST
      // precede the status checks, or a leftover/defaulted status could fall
      // through to the cancel branch on an outage.
      expect(
        decideAutoCancelAction({
          hasGatewayPayment: true,
          providerReachable: false,
          providerStatus: 'pending',
        })
      ).toBe('skip');
    });

    it('does not mistake an unreachable provider for a completed payment', () => {
      expect(
        decideAutoCancelAction({
          hasGatewayPayment: true,
          providerReachable: false,
          providerStatus: 'completed',
        })
      ).not.toBe('reconcile_paid');
    });
  });

  describe('cancelling is still correct for a definite not-paid answer', () => {
    it.each(['failed', 'expired', 'cancelled', 'pending'])(
      'cancels when the provider reports %s',
      status => {
        expect(
          decideAutoCancelAction({
            hasGatewayPayment: true,
            providerReachable: true,
            providerStatus: status,
          })
        ).toBe('cancel');
      }
    );

    it('cancels an unrecognised provider status rather than rescuing it', () => {
      // Only an explicit 'completed' may mark money as received. Anything we
      // do not recognise is NOT treated as paid.
      expect(
        decideAutoCancelAction({
          hasGatewayPayment: true,
          providerReachable: true,
          providerStatus: 'some_new_provider_state',
        })
      ).toBe('cancel');
    });
  });

  describe('orders with no gateway payment keep the original behaviour', () => {
    it('cancels a COD / never-issued-a-link order without asking any provider', () => {
      expect(
        decideAutoCancelAction({
          hasGatewayPayment: false,
          providerReachable: true,
        })
      ).toBe('cancel');
    });

    it('cancels a payment-less order even if the provider is unreachable', () => {
      // Nothing to reconcile means nothing to be unsure about — an unreachable
      // provider is irrelevant here and must not wedge these orders forever.
      expect(
        decideAutoCancelAction({
          hasGatewayPayment: false,
          providerReachable: false,
        })
      ).toBe('cancel');
    });
  });
});
