/**
 * The shared shipping-carrier contract (tests/contract/shipping-carrier.contract.ts) run against
 * the Bosta adapter and its local stub (official v2 shapes: tests/stubs/bosta-stub.ts).
 */
import { runShippingCarrierContract } from '../contract/shipping-carrier.contract';
import { BostaCarrier } from '@api/services/carriers/bosta.carrier';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';

runShippingCarrierContract('bosta (official REST v2 stub)', () => {
  const stub = new BostaStub();
  const carrier = new BostaCarrier({
    fetchImpl: stub.fetch,
    baseUrl: BOSTA_STUB.baseUrl,
    timeoutMs: 50,
  });
  return {
    carrier,
    credentials: { apiKey: BOSTA_STUB.apiKey, businessLocationId: 'LOC1', webhookSecret: 's3cret' },
    ctx: {
      settings: {},
      callbackUrl: 'https://api.example.test/api/v1/webhooks/shipping/bosta/S/s3cret',
    },
    control: {
      advance: (t, s) => stub.advance(t, s),
      webhookBody: (t, s, ts) => stub.webhookBody(t, s, ts),
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
