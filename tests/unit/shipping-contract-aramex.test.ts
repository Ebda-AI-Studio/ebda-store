/**
 * The shared shipping-carrier contract run against the SOAP Aramex adapter and its WSDL-validating
 * stub. Aramex has no cancel-shipment operation, so the target sets `noCancelApi`.
 */
import { runShippingCarrierContract } from '../contract/shipping-carrier.contract';
import { AramexCarrier } from '@api/services/carriers/aramex.carrier';
import { AramexStub, ARAMEX_STUB } from '../stubs/aramex-stub';

runShippingCarrierContract('aramex (SOAP stub, WSDL-validated)', () => {
  const stub = new AramexStub();
  const carrier = new AramexCarrier({
    fetchImpl: stub.fetch,
    baseUrl: ARAMEX_STUB.baseUrl,
    timeoutMs: 200,
  });
  return {
    carrier,
    credentials: ARAMEX_STUB.credentials,
    ctx: { settings: { codEgpConfirmed: true, productType: 'CDS' } },
    ctxCodUnconfirmed: { settings: { productType: 'CDS' } },
    noCancelApi: true,
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
