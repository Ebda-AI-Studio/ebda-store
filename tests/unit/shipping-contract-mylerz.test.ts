/**
 * The shared shipping-carrier contract run against the Mylerz adapter and its local stub.
 * Webhook sections self-skip: Mylerz has no documented webhook, so capabilities.webhooks is false.
 * `failed` is not reportable: Mylerz publishes no status table, so the adapter never invents one.
 */
import { runShippingCarrierContract } from '../contract/shipping-carrier.contract';
import { MylerzCarrier } from '@api/services/carriers/mylerz.carrier';
import { MylerzStub, MYLERZ_STUB } from '../stubs/mylerz-stub';

runShippingCarrierContract('mylerz (Integration API stub)', () => {
  const stub = new MylerzStub();
  const carrier = new MylerzCarrier({
    fetchImpl: stub.fetch,
    baseUrl: MYLERZ_STUB.baseUrl,
    timeoutMs: 50,
  });
  return {
    carrier,
    credentials: { ...MYLERZ_STUB.credentials },
    ctx: { settings: {} },
    reportable: [
      'picked_up',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'returned',
      'cancelled',
    ],
    control: {
      advance: (t, s) => stub.advance(t, s),
      pickUp: t => stub.advance(t, 'picked_up'),
      setHistoryOrder: o => {
        stub.historyOrder = o;
      },
      injectNextCall: f => stub.injectNextCall(f),
      parcelCount: () => stub.parcels.size,
      recordedCodMinor: t => stub.parcelByTracking(t)?.codMinor ?? -1,
      rejectCredentials: () => {
        stub.rejectAuth = true;
      },
    },
  };
});
