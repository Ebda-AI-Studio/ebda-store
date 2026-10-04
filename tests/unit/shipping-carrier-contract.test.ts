/**
 * The shared shipping-carrier contract (tests/contract/shipping-carrier.contract.ts) run
 * against every SP7 adapter: Bosta and Aramex against their local stubs, and the manual
 * carrier (the no-network subset, with the refusals asserted).
 */
import { runShippingCarrierContract } from '../contract/shipping-carrier.contract';
import { BostaCarrier } from '@api/services/carriers/bosta.carrier';
import { AramexCarrier } from '@api/services/carriers/aramex.carrier';
import { manualCarrier } from '@api/services/carriers/manual.carrier';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { AramexStub, ARAMEX_STUB } from '../stubs/aramex-stub';

runShippingCarrierContract('bosta (REST v2 stub)', () => {
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

runShippingCarrierContract('aramex (Shipping Services stub)', () => {
  const stub = new AramexStub();
  const carrier = new AramexCarrier({
    fetchImpl: stub.fetch,
    baseUrl: ARAMEX_STUB.baseUrl,
    timeoutMs: 50,
  });
  return {
    carrier,
    credentials: ARAMEX_STUB.credentials,
    ctx: { settings: { codEgpConfirmed: true } },
    ctxCodUnconfirmed: { settings: {} },
    control: {
      advance: (t, s) => stub.advance(t, s),
      pickUp: t => stub.advance(t, 'picked_up'),
      setHistoryOrder: o => {
        stub.historyOrder = o;
      },
      injectNextCall: f => stub.injectNextCall(f),
      parcelCount: () => stub.parcels.size,
      recordedCodMinor: t => stub.parcels.get(t)?.codMinor ?? -1,
      rejectCredentials: () => {
        stub.rejectAuth = true;
      },
      quoteInForeignCurrency: () => {
        stub.quoteCurrency = 'USD';
      },
    },
  };
});

runShippingCarrierContract('manual (merchant-entered)', () => ({
  carrier: manualCarrier,
  credentials: {},
  manual: { carrierName: 'Sprint', trackingNumber: 'SPR-1' },
}));
