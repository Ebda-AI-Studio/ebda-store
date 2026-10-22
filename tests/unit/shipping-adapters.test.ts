/**
 * Adapter specifics beyond the shared contract (SP7): what is sent to the carrier on the wire.
 */
import { describe, it, expect, vi } from 'vitest';
import { BostaCarrier, mapBostaState } from '@api/services/carriers/bosta.carrier';
import { AramexCarrier } from '@api/services/carriers/aramex.carrier';
import { ManualCarrier } from '@api/services/carriers/manual.carrier';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { AramexStub, ARAMEX_STUB } from '../stubs/aramex-stub';
import { shipmentRequest } from '../contract/shipping-carrier.contract';
import { piastresToEgp, egpToPiastres } from '@api/lib/carrier-http';

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('EGP / piastre conversion at the edge', () => {
  it('round-trips every amount a cart can produce without float error', () => {
    for (const p of [0, 1, 9, 10, 29, 99, 100, 101, 12345, 999_999, 123_456_789]) {
      expect(egpToPiastres(String(piastresToEgp(p)))).toBe(p);
    }
    expect(piastresToEgp(29)).toBe(0.29);
    expect(piastresToEgp(110)).toBe(1.1);
    expect(() => egpToPiastres('1.999')).toThrow();
  });
});

describe('Bosta on the wire', () => {
  const mk = () => {
    const stub = new BostaStub();
    const carrier = new BostaCarrier({
      fetchImpl: stub.fetch,
      baseUrl: BOSTA_STUB.baseUrl,
      timeoutMs: 50,
    });
    return { stub, carrier };
  };

  it('sends COD as EGP decimal, the reference as businessReference and the secret callback URL', async () => {
    const { stub, carrier } = mk();
    const url = 'https://api.example.test/api/v1/webhooks/shipping/bosta/STORE/tok';
    const req = shipmentRequest({ codAmount: 12_345 });
    const r = await carrier.createShipment({ apiKey: BOSTA_STUB.apiKey }, req, {
      callbackUrl: url,
    });
    const p = stub.parcelByTracking(r.trackingNumber)!;
    expect(p.codSent).toBe(123.45);
    expect(p.businessReference).toBe(req.merchantReference);
    expect(p.webhookUrl).toBe(url);
  });

  it('asks the merchant to map an address with no governorate instead of guessing', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    req.deliveryAddress = { ...req.deliveryAddress, state: undefined, city: '' };
    await expect(carrier.createShipment({ apiKey: BOSTA_STUB.apiKey }, req)).rejects.toMatchObject({
      code: 'NEEDS_MAPPING',
    });
    expect(stub.parcels.size).toBe(0);
  });

  it('a missing API key is a misconfiguration, before any call', async () => {
    const { stub, carrier } = mk();
    await expect(carrier.createShipment({ apiKey: '' }, shipmentRequest())).rejects.toMatchObject({
      code: 'CARRIER_MISCONFIGURED',
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('uses the sandbox host when the merchant turns sandbox on, the live one otherwise', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(new URL(url).host);
      return new Response(JSON.stringify({ deliveries: [] }), { status: 200 });
    };
    const carrier = new BostaCarrier({ fetchImpl });
    await carrier.testConnection({ apiKey: 'k' }, { settings: { sandbox: true } });
    await carrier.testConnection({ apiKey: 'k' }, { settings: {} });
    expect(seen).toEqual(['stg-app.bosta.co', 'app.bosta.co']);
  });

  it('maps numeric, object and named states, and ignores an unknown one', () => {
    expect(mapBostaState(45)).toBe('delivered');
    expect(mapBostaState('41')).toBe('out_for_delivery');
    expect(mapBostaState({ code: 46 })).toBe('returned');
    expect(mapBostaState('Delivered')).toBe('delivered');
    expect(mapBostaState(9999)).toBeNull();
    expect(mapBostaState(undefined)).toBeNull();
  });
});

describe('Aramex COD is EGP or refused, never a 3-decimal amount', () => {
  const mk = () => {
    const stub = new AramexStub();
    const carrier = new AramexCarrier({
      fetchImpl: stub.fetch,
      baseUrl: ARAMEX_STUB.baseUrl,
      timeoutMs: 50,
    });
    return { stub, carrier };
  };

  it('sends the COD in EGP (not amount/1000) once the merchant confirmed COD in EGP', async () => {
    const { stub, carrier } = mk();
    const r = await carrier.createShipment(
      ARAMEX_STUB.credentials,
      shipmentRequest({ codAmount: 12_345 }),
      { settings: { codEgpConfirmed: true, productType: 'CDS' } }
    );
    const p = stub.parcels.get(r.trackingNumber)!;
    expect(p.codCurrency).toBe('EGP');
    expect(p.codValue).toBe(123.45); // the old code sent 12.345 (amount/1000)
  });

  it('refuses COD until it is confirmed, with a message saying what to do', async () => {
    const { stub, carrier } = mk();
    const err = await carrier
      .createShipment(ARAMEX_STUB.credentials, shipmentRequest({ codAmount: 5_000 }), {
        settings: {},
      })
      .catch(e => e);
    expect(err.code).toBe('COD_NOT_SUPPORTED');
    expect(err.message).toMatch(/confirm/i);
    expect(stub.requests).toHaveLength(0);
    // "true" as a string is not a confirmation: only the explicit boolean
    await expect(
      carrier.createShipment(ARAMEX_STUB.credentials, shipmentRequest({ codAmount: 5_000 }), {
        settings: { codEgpConfirmed: 'true', productType: 'CDS' },
      })
    ).rejects.toMatchObject({ code: 'COD_NOT_SUPPORTED' });
  });

  it('polls (no webhooks) and orders history oldest-first', () => {
    const { carrier } = mk();
    expect(carrier.capabilities.webhooks).toBe(false);
    expect(carrier.capabilities.polling).toBe(true);
    expect(carrier.capabilities.cod).toBe('unconfirmed');
  });
});

describe('manual carrier', () => {
  const carrier = new ManualCarrier();
  it('needs a carrier name and a tracking number', async () => {
    await expect(carrier.createShipment({}, shipmentRequest())).rejects.toMatchObject({
      code: 'CARRIER_REJECTED',
    });
    await expect(
      carrier.createShipment(
        {},
        shipmentRequest({ manual: { carrierName: ' ', trackingNumber: 'X' } })
      )
    ).rejects.toMatchObject({ code: 'CARRIER_REJECTED' });
  });
  it('keeps the tracking number the merchant typed', async () => {
    const r = await carrier.createShipment(
      {},
      shipmentRequest({ manual: { carrierName: 'Sprint', trackingNumber: ' SPR-77 ' } })
    );
    expect(r.trackingNumber).toBe('SPR-77');
  });
});
