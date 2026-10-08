/**
 * Bosta adapter vs Bosta's OFFICIAL documented examples (docs.bosta.co/api/api.yaml and the how-to
 * pages). Where the docs are silent the assertion is about the adapter's safe handling, and says so.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BostaCarrier,
  BOSTA_WEBHOOK_HEADER,
  webhookHeaderValue,
  mapBostaState,
  clearBostaLocationCache,
} from '@api/services/carriers/bosta.carrier';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { shipmentRequest } from '../contract/shipping-carrier.contract';
import { CarrierError, type CarrierShipmentRequest } from '@api/services/carriers/types';

const creds = { apiKey: BOSTA_STUB.apiKey, businessLocationId: 'LOC1', webhookSecret: 'wh-secret' };

const mk = (baseUrl = BOSTA_STUB.baseUrl) => {
  const stub = new BostaStub();
  const carrier = new BostaCarrier({ fetchImpl: stub.fetch, baseUrl, timeoutMs: 200 });
  return { stub, carrier };
};

const posts = (stub: BostaStub, path = '/deliveries') =>
  stub.requests.filter(r => r.method === 'POST' && r.path === path);

beforeEach(() => clearBostaLocationCache());

describe('create delivery payload (api.yaml example field names)', () => {
  it('sends the documented fields, raw Authorization header, apiVersion=1', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest({ codAmount: 5000, notes: 'Welcome Note' });
    req.deliveryAddress = {
      ...req.deliveryAddress,
      line2: 'Near to Bosta school',
      building: '123',
      floor: '4',
      apartment: '2',
    };
    const r = await carrier.createShipment(creds, req, {
      callbackUrl: 'https://api.example.test/hook/tok',
    });
    const call = posts(stub)[0];
    expect(call.query).toBe('?apiVersion=1');
    expect(call.authorization).toBe(BOSTA_STUB.apiKey); // raw key
    expect(call.authorization).not.toMatch(/^Bearer /i);
    const b = call.body;
    expect(b.type).toBe(10);
    expect(b.cod).toBe(50);
    expect(b.notes).toBe('Welcome Note');
    expect(b.specs).toEqual({
      packageType: 'Parcel',
      size: 'MEDIUM',
      packageDetails: { itemsCount: 2, description: 'Linen shirt' },
    });
    expect(b.businessReference).toBe(req.merchantReference);
    expect(b.uniqueBusinessReference).toBe(req.merchantReference);
    expect(b.businessLocationId).toBe('LOC1');
    expect(b.webhookUrl).toBe('https://api.example.test/hook/tok');
    expect(b.webhookCustomHeaders).toEqual({
      [BOSTA_WEBHOOK_HEADER]: webhookHeaderValue('wh-secret'),
    });
    expect(b.receiver).toEqual({
      firstName: 'Mona',
      lastName: 'Adel',
      phone: '01012345678', // local form, as in the docs examples
      email: 'mona@example.com',
    });
    // Giza + Dokki resolved to Bosta's own ids (spec 10): city name, districtId and zoneId
    expect(b.dropOffAddress).toEqual({
      city: 'Giza',
      districtId: 'dDokki1',
      zoneId: 'zDokki',
      firstLine: '5 Nile Corniche',
      secondLine: 'Near to Bosta school',
      buildingNumber: '123',
      floor: '4',
      apartment: '2',
    });
    // tracking number is the shipment id (terminate / lookups take it); `_id` rides separately
    expect(r.carrierShipmentId).toBe(r.trackingNumber);
    expect(r.carrierTransactionId).toBe(stub.parcelByTracking(r.trackingNumber)!.id);
  });

  it('size follows ctx.settings.packageSize', async () => {
    const { stub, carrier } = mk();
    await carrier.createShipment(creds, shipmentRequest(), { settings: { packageSize: 'large' } });
    expect(posts(stub)[0].body.specs.size).toBe('LARGE');
  });

  it('city is the Bosta spelling, found by code (Beheira is "Behira" at Bosta)', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    req.deliveryAddress = {
      ...req.deliveryAddress,
      state: 'Beheira',
      city: 'Damanhur',
      area: 'Damanhur',
    };
    await carrier.createShipment(creds, req);
    const a = posts(stub)[0].body.dropOffAddress;
    expect(a.city).toBe('Behira');
    // no district list for that city in the stub: name + cityId (spec 2), never a guessed id
    expect(a).toMatchObject({ districtName: 'Damanhur', cityId: 'g3GchTSmCgR2JynsJ' });
    expect(a.districtId).toBeUndefined();
  });

  it('a merchant cityMap / districtMap override wins', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    req.deliveryAddress = { ...req.deliveryAddress, state: 'Giza', area: 'Somewhere odd' };
    await carrier.createShipment(creds, req, {
      settings: { cityMap: { Giza: 'Cairo' }, districtMap: { 'Somewhere odd': 'dMaadi1' } },
    });
    const a = posts(stub)[0].body.dropOffAddress;
    expect(a.city).toBe('Cairo');
    expect(a.districtId).toBe('dMaadi1');
    expect(a.zoneId).toBe('zMaadi');
  });

  it('no district to send is NEEDS_MAPPING (spec 2: districtId, or districtName + cityId)', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    req.deliveryAddress = { ...req.deliveryAddress, area: undefined };
    await expect(carrier.createShipment(creds, req)).rejects.toMatchObject({
      code: 'NEEDS_MAPPING',
    });
    expect(posts(stub)).toHaveLength(0);
  });

  it('refuses a first line of 5 characters or fewer (spec 2) before any call', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    req.deliveryAddress = { ...req.deliveryAddress, line1: '12 St' };
    await expect(carrier.createShipment(creds, req)).rejects.toMatchObject({
      code: 'CARRIER_REJECTED',
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('a city Bosta does not deliver to (North Sinai) is refused, nothing booked', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    req.deliveryAddress = { ...req.deliveryAddress, state: 'North Sinai', area: 'Arish' };
    await expect(carrier.createShipment(creds, req)).rejects.toMatchObject({
      code: 'CARRIER_REJECTED',
    });
    expect(stub.parcels.size).toBe(0);
  });

  it('an unknown governorate is NEEDS_MAPPING, before any network call', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    req.deliveryAddress = { ...req.deliveryAddress, state: 'Atlantis', city: 'Atlantis' };
    await expect(carrier.createShipment(creds, req)).rejects.toMatchObject({
      code: 'NEEDS_MAPPING',
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('city/district lists are cached per process but never shared across base URLs', async () => {
    const a = mk('http://bosta.stub/api/v2');
    const b = mk('http://stg.bosta.stub/api/v2');
    await a.carrier.createShipment(creds, shipmentRequest());
    await a.carrier.createShipment(creds, shipmentRequest());
    const citiesCalls = (s: BostaStub) => s.requests.filter(r => r.path === '/cities').length;
    const districtCalls = (s: BostaStub) =>
      s.requests.filter(r => /\/districts$/.test(r.path)).length;
    expect([citiesCalls(a.stub), districtCalls(a.stub)]).toEqual([1, 1]); // second booking hit the cache
    await b.carrier.createShipment(creds, shipmentRequest());
    expect([citiesCalls(b.stub), districtCalls(b.stub)]).toEqual([1, 1]); // other host: own fetch
  });
});

describe('COD (spec 2: EGP number, limit 30,000 EGP)', () => {
  it.each([
    [1, 0.01],
    [29, 0.29],
    [12345, 123.45],
    [999999, 9999.99],
  ])('%i piastres is sent as the EGP number %d', async (piastres, egp) => {
    const { stub, carrier } = mk();
    await carrier.createShipment(creds, shipmentRequest({ codAmount: piastres }));
    expect(posts(stub)[0].body.cod).toBe(egp);
  });

  it('prepaid is cod 0', async () => {
    const { stub, carrier } = mk();
    await carrier.createShipment(creds, shipmentRequest());
    expect(posts(stub)[0].body.cod).toBe(0);
  });

  it('exactly 30,000 EGP passes; one piastre more is refused with nothing sent', async () => {
    const { stub, carrier } = mk();
    await carrier.createShipment(creds, shipmentRequest({ codAmount: 3_000_000 }));
    expect(posts(stub)[0].body.cod).toBe(30000);
    const fresh = mk();
    const err = await fresh.carrier
      .createShipment(creds, shipmentRequest({ codAmount: 3_000_001 }))
      .catch(e => e);
    expect(err).toBeInstanceOf(CarrierError);
    expect(err.code).toBe('CARRIER_REJECTED');
    expect(fresh.stub.requests).toHaveLength(0);
  });
});

describe('idempotent create (spec 3b)', () => {
  it('a second create with the same reference makes no second POST /deliveries', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    const a = await carrier.createShipment(creds, req);
    const b = await carrier.createShipment(creds, req);
    expect(b.trackingNumber).toBe(a.trackingNumber);
    expect(b.carrierTransactionId).toBe(a.carrierTransactionId);
    expect(posts(stub)).toHaveLength(1);
    expect(posts(stub, '/deliveries/search')).toHaveLength(2);
  });

  it('UNVERIFIED search auth: a search Bosta refuses for an API key is treated as "none found"; uniqueBusinessReference then guards the create', async () => {
    const { stub, carrier } = mk();
    stub.searchRequiresBearer = true;
    const req = shipmentRequest();
    const a = await carrier.createShipment(creds, req);
    // the second create cannot see the first, Bosta refuses the duplicate reference, the adapter
    // searches once more (still blind) and surfaces the refusal: never a second parcel
    await expect(carrier.createShipment(creds, req)).rejects.toMatchObject({
      code: 'CARRIER_REJECTED',
    });
    expect(stub.parcels.size).toBe(1);
    expect(a.trackingNumber).toBeTruthy();
  });

  it('an OUTAGE on the search propagates as CARRIER_UNAVAILABLE and books nothing', async () => {
    const { stub, carrier } = mk();
    stub.faults.down = 'unavailable';
    const err = await carrier.createShipment(creds, shipmentRequest()).catch(e => e);
    expect(err.code).toBe('CARRIER_UNAVAILABLE');
    expect(stub.parcels.size).toBe(0);
    expect(posts(stub)).toHaveLength(0);
  });

  it('UNVERIFIED duplicate refusal: when two creates race past the search, the loser reuses the winner', async () => {
    const { stub, carrier } = mk();
    const req = shipmentRequest();
    const winner = await carrier.createShipment(creds, req);
    // simulate the race: the first search call sees nothing, the create is refused as a duplicate,
    // the second search finds the parcel
    let searches = 0;
    const real = stub.fetch;
    const racing = new BostaCarrier({
      baseUrl: BOSTA_STUB.baseUrl,
      timeoutMs: 200,
      fetchImpl: async (url, init) => {
        if (new URL(url).pathname.endsWith('/deliveries/search') && searches++ === 0) {
          return new Response(JSON.stringify({ success: true, data: { deliveries: [] } }), {
            status: 200,
          });
        }
        return real(url, init);
      },
    });
    const loser = await racing.createShipment(creds, req);
    expect(loser.trackingNumber).toBe(winner.trackingNumber);
    expect(stub.parcels.size).toBe(1);
  });
});

describe('state table (spec 7)', () => {
  it.each([
    [10, 'created'],
    [11, 'created'],
    [20, 'created'],
    [21, 'picked_up'],
    [22, 'in_transit'],
    [23, 'in_transit'],
    [24, 'in_transit'],
    [25, 'in_transit'],
    [30, 'in_transit'],
    [41, 'out_for_delivery'],
    [45, 'delivered'],
    [46, 'returned'],
    [47, 'in_transit'],
    [48, 'cancelled'],
    [49, 'cancelled'],
    [60, 'returned'],
    [100, 'failed'],
    [101, 'failed'],
    [102, 'in_transit'],
    [103, 'failed'],
    [105, 'in_transit'],
  ])('state %i -> %s (number, string and {code})', (code, status) => {
    expect(mapBostaState(code)).toBe(status);
    expect(mapBostaState(String(code))).toBe(status);
    expect(mapBostaState({ code, value: 'x' })).toBe(status);
  });

  it('104 Archived, 40 (cash collection) and unknown codes are ignored, never guessed', () => {
    for (const s of [104, 40, 9999, 0, -1, 'garbage', null, undefined, {}, []]) {
      expect(mapBostaState(s)).toBeNull();
    }
  });

  it('the exchange/CRP legs (22, 23) are never delivered', () => {
    expect(mapBostaState(22)).not.toBe('delivered');
    expect(mapBostaState(23)).not.toBe('delivered');
  });

  it('state 41 means out-for-RETURN on a return leg, out for delivery on SEND', () => {
    expect(mapBostaState(41, 'SEND')).toBe('out_for_delivery');
    expect(mapBostaState(41, 'FXF_SEND')).toBe('out_for_delivery');
    for (const t of ['EXCHANGE', 'CUSTOMER_RETURN_PICKUP', 'RTO', { code: 25 }, { code: 30 }]) {
      expect(mapBostaState(41, t)).toBe('in_transit');
    }
  });

  it('maps by official state NAME when a timeline entry has no code', () => {
    expect(mapBostaState('Delivered')).toBe('delivered');
    expect(mapBostaState('Picked up from business')).toBe('picked_up');
    expect(mapBostaState('Received at warehouse')).toBe('in_transit');
    expect(mapBostaState('Terminated')).toBe('cancelled');
  });
});

describe('webhook (spec 8, both documented examples verbatim)', () => {
  const { carrier } = mk();
  const normal = {
    _id: '15LmfpKYp0YILntA3jbyd',
    trackingNumber: 48089608,
    state: 24,
    type: 'SEND',
    timeStamp: 1689252908261,
    deliveryPromiseDate: '13-07-2023',
    numberOfAttempts: 0,
  };
  const exception = {
    _id: '15LmfpKYp0YILntA3jbyd',
    trackingNumber: 48089608,
    state: 47,
    type: 'SEND',
    timeStamp: 1689253131024,
    deliveryPromiseDate: '15-07-2023',
    numberOfAttempts: 1,
    exceptionReason: 'Postponed - the customer requested postponement for another day.',
    exceptionCode: 3,
  };

  it('parses the normal example (trackingNumber as a Number)', () => {
    const r = carrier.processWebhook(normal, {});
    expect(r).toMatchObject({ trackingNumber: '48089608', status: 'in_transit' });
    expect(r!.timestamp.getTime()).toBe(1689252908261);
    expect(r!.description).toBeUndefined();
  });

  it('parses the same body with trackingNumber as a String', () => {
    const r = carrier.processWebhook({ ...normal, trackingNumber: '48089608' }, {});
    expect(r).toMatchObject({ trackingNumber: '48089608', status: 'in_transit' });
  });

  it('the exception example (47) keeps the parcel moving and carries the reason', () => {
    const r = carrier.processWebhook(exception, {});
    expect(r).toMatchObject({ trackingNumber: '48089608', status: 'in_transit' });
    expect(r!.timestamp.getTime()).toBe(1689253131024);
    expect(r!.description).toBe(exception.exceptionReason);
  });

  it('Delivered (45) with cod and isConfirmedDelivery, return-leg 41, unknown state, garbage', () => {
    expect(
      carrier.processWebhook(
        { ...normal, state: 45, cod: 50, isConfirmedDelivery: true, timeStamp: 1689253999999 },
        {}
      )
    ).toMatchObject({ status: 'delivered' });
    expect(carrier.processWebhook({ ...normal, state: 41, type: 'RTO' }, {})).toMatchObject({
      status: 'in_transit',
    });
    expect(carrier.processWebhook({ ...normal, state: 104 }, {})).toBeNull();
    expect(carrier.processWebhook({ ...normal, state: 7777 }, {})).toBeNull();
    expect(carrier.processWebhook({ ...normal, trackingNumber: undefined }, {})).toBeNull();
    expect(carrier.processWebhook('nope', {})).toBeNull();
    expect(carrier.processWebhook(null, {})).toBeNull();
  });
});

describe('webhook header derivation', () => {
  it('is HMAC-derived, deterministic, never the secret, and different per secret', () => {
    const a = webhookHeaderValue('secret-a');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe('secret-a');
    expect(webhookHeaderValue('secret-a')).toBe(a);
    expect(webhookHeaderValue('secret-b')).not.toBe(a);
  });

  it('the adapter declares the header the service must require', () => {
    const { carrier } = mk();
    expect(carrier.webhookHeader.name).toBe('x-ebda-webhook-secret');
    expect(BOSTA_WEBHOOK_HEADER).toBe('x-ebda-webhook-secret');
    expect(carrier.webhookHeader.valueFor('s')).toBe(webhookHeaderValue('s'));
  });

  it('no callback URL, no webhook fields at all', async () => {
    const { stub, carrier } = mk();
    await carrier.createShipment(creds, shipmentRequest());
    expect(posts(stub)[0].body.webhookUrl).toBeUndefined();
    expect(posts(stub)[0].body.webhookCustomHeaders).toBeUndefined();
  });
});

describe('terminate (spec 9)', () => {
  const book = async (stub: BostaStub, carrier: BostaCarrier) =>
    carrier.createShipment(creds, shipmentRequest());

  it('uses DELETE on the TRACKING NUMBER path and reports cancelled on 2xx', async () => {
    const { stub, carrier } = mk();
    const r = await book(stub, carrier);
    const out = await carrier.cancelShipment(creds, r.carrierShipmentId);
    expect(out.status).toBe('cancelled');
    const del = stub.requests.find(x => x.method === 'DELETE')!;
    expect(del.path).toBe(`/deliveries/business/${r.trackingNumber}/terminate`);
    expect(stub.parcelByTracking(r.trackingNumber)!.state).toBe(48);
  });

  it('a 404 is never reported cancelled', async () => {
    const { carrier } = mk();
    const out = await carrier.cancelShipment(creds, '000');
    expect(out).toEqual({ status: 'failed', message: 'not found at Bosta' });
  });

  it("a parcel Bosta already has (400) is not_cancellable with Bosta's message", async () => {
    const { stub, carrier } = mk();
    const r = await book(stub, carrier);
    stub.advance(r.trackingNumber, 'picked_up');
    const out = await carrier.cancelShipment(creds, r.carrierShipmentId);
    expect(out.status).toBe('not_cancellable');
    expect(out.message).toMatch(/already picked up/);
  });

  it('403 / 1008 says the key needs Full access, and is not cancelled', async () => {
    const { stub, carrier } = mk();
    const r = await book(stub, carrier);
    stub.keyScope = 'write';
    const out = await carrier.cancelShipment(creds, r.carrierShipmentId);
    expect(out.status).toBe('not_cancellable');
    expect(out.message).toMatch(/Full access/);
    expect(stub.parcelByTracking(r.trackingNumber)!.state).toBe(10);
  });

  it('an outage is thrown, never "cancelled"', async () => {
    const { stub, carrier } = mk();
    const r = await book(stub, carrier);
    stub.faults.down = 'unavailable';
    await expect(carrier.cancelShipment(creds, r.carrierShipmentId)).rejects.toMatchObject({
      code: 'CARRIER_UNAVAILABLE',
    });
  });
});

describe('testConnection (spec 1)', () => {
  it('200 on /pickup-locations is success', async () => {
    const { stub, carrier } = mk();
    expect(await carrier.testConnection(creds)).toEqual({ success: true });
    expect(stub.requests.at(-1)).toMatchObject({ method: 'GET', path: '/pickup-locations' });
  });

  it('a bad key (401 / 1028) is bad_credentials and the message never contains the key', async () => {
    const { carrier } = mk();
    const out = await carrier.testConnection({ apiKey: 'super-secret-key-123' });
    expect(out).toMatchObject({ success: false, code: 'bad_credentials' });
    expect(JSON.stringify(out)).not.toContain('super-secret-key-123');
  });

  it('an outage is "unreachable"', async () => {
    const { stub, carrier } = mk();
    stub.faults.down = 'unavailable';
    expect(await carrier.testConnection(creds)).toMatchObject({
      success: false,
      code: 'unreachable',
    });
  });

  it('an unknown pickup location id names the ones Bosta knows', async () => {
    const { carrier } = mk();
    const out = await carrier.testConnection({ ...creds, businessLocationId: 'NOPE' });
    expect(out).toMatchObject({ success: false, code: 'unknown' });
    expect(out.error).toBe('Bosta does not know the pickup location "NOPE". Known: LOC1, LOC2');
  });
});

describe('label, quote, pickup, tracking', () => {
  it('label: mass-awb with the tracking number, base64 PDF from JSON or raw text', async () => {
    const { stub, carrier } = mk();
    const r = await carrier.createShipment(creds, shipmentRequest());
    for (const fmt of ['json', 'raw'] as const) {
      stub.awbFormat = fmt;
      const label = await carrier.getLabel(creds, r);
      expect(Buffer.from(label.pdfBase64!, 'base64').subarray(0, 4).toString()).toBe('%PDF');
    }
    expect(posts(stub, '/deliveries/mass-awb')[0].body).toEqual({
      trackingNumbers: r.trackingNumber,
      requestedAwbType: 'A4',
      lang: 'ar',
    });
  });

  it('label: a body that is not a PDF is an error, not a label', async () => {
    const carrier = new BostaCarrier({
      baseUrl: BOSTA_STUB.baseUrl,
      fetchImpl: async () => new Response('<html>gateway</html>', { status: 200 }),
    });
    await expect(
      carrier.getLabel(creds, { carrierShipmentId: '1', trackingNumber: '1' })
    ).rejects.toBeInstanceOf(CarrierError);
  });

  it('quote: city NAMES in the query, price parsed defensively, no number means no quote', async () => {
    const { stub, carrier } = mk();
    const pickup = shipmentRequest().pickupAddress;
    const dest = shipmentRequest().deliveryAddress;
    const q = await carrier.quote(creds, {
      pickupAddress: pickup,
      deliveryAddress: dest,
      codAmount: 10000,
    });
    expect(q).toEqual({ amountPiastres: 4550, source: 'api' });
    const call = stub.requests.find(r => r.path === '/pricing/shipment/calculator')!;
    const qs = new URLSearchParams(call.query);
    expect(qs.get('pickupCity')).toBe('Cairo');
    expect(qs.get('dropOffCity')).toBe('Giza');
    expect(qs.get('cod')).toBe('100');
    expect(qs.get('type')).toBe('SEND');

    const empty = new BostaCarrier({
      baseUrl: BOSTA_STUB.baseUrl,
      fetchImpl: async (url, init) =>
        new URL(url).pathname.endsWith('/calculator')
          ? new Response(JSON.stringify({ success: true, data: { currency: 'EGP' } }), {
              status: 200,
            })
          : stub.fetch(url, init),
    });
    await expect(
      empty.quote(creds, { pickupAddress: pickup, deliveryAddress: dest })
    ).rejects.toMatchObject({ code: 'CARRIER_UNAVAILABLE' });
  });

  it('quote: a bundle account (priceAfterVat 0, bundleDiscount == shippingFee) is a real 0 quote', async () => {
    const { stub } = mk();
    const pickup = shipmentRequest().pickupAddress;
    const dest = shipmentRequest().deliveryAddress;
    const calc = (data: object) =>
      new BostaCarrier({
        baseUrl: BOSTA_STUB.baseUrl,
        fetchImpl: async (url, init) =>
          new URL(url).pathname.endsWith('/calculator')
            ? new Response(JSON.stringify({ success: true, data }), { status: 200 })
            : stub.fetch(url, init),
      });
    // Shape observed on a live Bosta account, 2026-10-08.
    const bundle = {
      shippingFee: 102,
      bundleDiscount: { amount: 102 },
      priceAfterVat: 0,
      vat: 0.14,
    };
    await expect(
      calc(bundle).quote(creds, { pickupAddress: pickup, deliveryAddress: dest })
    ).resolves.toEqual({ amountPiastres: 0, source: 'api' });
    // A 0 without the itemised discount is still no quote.
    await expect(
      calc({ priceAfterVat: 0 }).quote(creds, { pickupAddress: pickup, deliveryAddress: dest })
    ).rejects.toMatchObject({ code: 'CARRIER_UNAVAILABLE' });
  });

  it('requestPickup: POST /pickups with the location id; needs businessLocationId', async () => {
    const { stub, carrier } = mk();
    const out = await carrier.requestPickup(
      creds,
      {
        scheduledDate: '2026-10-12',
        numberOfParcels: 3,
        contactPerson: { name: 'Amelia', phone: '+201000000001' },
        trackingNumbers: ['5108001'],
      },
      undefined
    );
    expect(out).toMatchObject({
      pickupId: '7878001',
      scheduledDate: '2026-10-12',
      state: 'Requested',
    });
    expect(stub.pickups[0]).toMatchObject({
      businessLocationId: 'LOC1',
      numberOfParcels: 3,
      contactPerson: { name: 'Amelia', phone: '01000000001' },
      trackingNumbers: ['5108001'],
    });
    await expect(
      carrier.requestPickup(
        { apiKey: BOSTA_STUB.apiKey },
        {
          scheduledDate: '2026-10-12',
          numberOfParcels: 1,
          contactPerson: { name: 'A', phone: '0100' },
        }
      )
    ).rejects.toMatchObject({ code: 'CARRIER_MISCONFIGURED' });
  });

  it('track: GET /deliveries/business/{trackingNumber}; state.code decides, history oldest first', async () => {
    const { stub, carrier } = mk();
    const r = await carrier.createShipment(creds, shipmentRequest());
    stub.advance(r.trackingNumber, 'picked_up');
    stub.advanceToCode(r.trackingNumber, 47);
    const t = await carrier.trackShipment(creds, r.trackingNumber);
    expect(stub.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: `/deliveries/business/${r.trackingNumber}`,
    });
    expect(t.status).toBe('in_transit'); // 47 Exception: still moving
    expect(t.statusHistory.map(h => h.status)).toEqual(['created', 'picked_up', 'in_transit']);
  });

  it('track: with no usable history entries the documented timeline (by state name) is used', async () => {
    const carrier = new BostaCarrier({
      baseUrl: BOSTA_STUB.baseUrl,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              state: { code: 45, value: 'Delivered' },
              type: { code: 10, value: 'Send' },
              timeline: [
                { value: 'Pickup requested', done: true, date: '2026-10-06T10:00:00Z' },
                { value: 'Delivered', done: true, date: '2026-10-07T10:00:00Z' },
                { value: 'Returned to business', done: false },
              ],
            },
          }),
          { status: 200 }
        ),
    });
    const t = await carrier.trackShipment(creds, '1');
    expect(t.status).toBe('delivered');
    expect(t.statusHistory.map(h => h.status)).toEqual(['created', 'delivered']);
  });
});

describe('host selection and auth', () => {
  it('sandbox setting picks the staging host (UNVERIFIED host), live otherwise', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(new URL(url).host);
      return new Response(JSON.stringify({ success: true, data: { list: [] } }), { status: 200 });
    };
    const carrier = new BostaCarrier({ fetchImpl });
    await carrier.testConnection({ apiKey: 'k' }, { settings: { sandbox: true } });
    await carrier.testConnection({ apiKey: 'k' }, { settings: {} });
    expect(seen).toEqual(['stg-app.bosta.co', 'app.bosta.co']);
  });

  it('a missing key is a misconfiguration before any call', async () => {
    const { stub, carrier } = mk();
    await expect(
      carrier.createShipment({ apiKey: '' }, shipmentRequest() as CarrierShipmentRequest)
    ).rejects.toMatchObject({ code: 'CARRIER_MISCONFIGURED' });
    expect(stub.requests).toHaveLength(0);
  });
});
