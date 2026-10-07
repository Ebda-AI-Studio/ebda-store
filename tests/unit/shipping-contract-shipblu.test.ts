/**
 * The shared shipping-carrier contract (tests/contract/shipping-carrier.contract.ts) run against
 * the ShipBlu adapter and its local stub. ShipBlu documents no webhooks (capabilities.webhooks is
 * false), so the webhook sections that need `control.webhookBody` self-skip.
 */
import { runShippingCarrierContract } from '../contract/shipping-carrier.contract';
import { ShipbluCarrier } from '@api/services/carriers/shipblu.carrier';
import { ShipbluStub, SHIPBLU_STUB } from '../stubs/shipblu-stub';

runShippingCarrierContract('shipblu (REST stub)', () => {
  const stub = new ShipbluStub();
  const carrier = new ShipbluCarrier({
    fetchImpl: stub.fetch,
    baseUrl: SHIPBLU_STUB.baseUrl,
    timeoutMs: 50,
  });
  return {
    carrier,
    credentials: { apiKey: SHIPBLU_STUB.apiKey },
    ctx: { settings: {} },
    noCancelApi: true, // ShipBlu documents no cancel endpoint
    control: {
      advance: (t, s) => stub.advance(t, s),
      pickUp: t => stub.advance(t, 'picked_up'),
      setHistoryOrder: o => {
        stub.historyOrder = o;
      },
      injectNextCall: f => stub.injectNextCall(f),
      parcelCount: () => stub.orders.size,
      recordedCodMinor: t => stub.orderByTracking(t)?.codMinor ?? -1,
      rejectCredentials: () => {
        stub.rejectAuth = true;
      },
    },
  };
});
