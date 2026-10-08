/**
 * ShipBlu contract tests built from the DOCUMENTED examples (docs.shipblu.com quick-start +
 * tutorial, and the official OpenAPI at api.shipblu.com/docs/?format=openapi). Where the docs are
 * silent the adapter's behaviour is asserted to be SAFE (no guessed endpoint, no network).
 */
import { describe, it, expect } from 'vitest';
import {
  ShipbluCarrier,
  SHIPBLU_STATUS_MAP,
  SHIPBLU_IGNORED_STATUSES,
  SHIPBLU_BASE_URLS,
  mapShipbluStatus,
} from '@api/services/carriers/shipblu.carrier';
import { CarrierError } from '@api/services/carriers/types';
import { ShipbluStub, SHIPBLU_STUB } from '../stubs/shipblu-stub';
import { shipmentRequest } from '../contract/shipping-carrier.contract';

const CREDS = { apiKey: SHIPBLU_STUB.apiKey };

function setup() {
  const stub = new ShipbluStub();
  const carrier = new ShipbluCarrier({
    fetchImpl: stub.fetch,
    baseUrl: SHIPBLU_STUB.baseUrl,
    timeoutMs: 50,
  });
  return { stub, carrier };
}

const posts = (stub: ShipbluStub) =>
  stub.requests.filter(r => r.method === 'POST' && r.path === '/v1/delivery-orders/');

/** The 32-value `status` enum of the official OpenAPI (identical on prod and staging). */
const OPENAPI_STATUS_ENUM = [
  'created',
  'cancelled',
  'picked_up',
  'in_transit',
  'en_route',
  'return_to_origin',
  'returned_to_origin',
  'on_hold',
  'release_hold',
  'ops_delay',
  'forfeited',
  'damaged',
  'lost',
  'pickup_requested',
  'pickup_rescheduled',
  'out_for_pickup',
  'out_for_delivery',
  'delivery_attempted',
  'reattempt_delivery',
  'delivered',
  'cod_change',
  'cod_deposited',
  'return_requested',
  'out_for_return',
  'return_attempted',
  'returned',
  'return_refused',
  'return_postponed',
  'exchange_requested',
  'out_for_exchange',
  'exchange_attempted',
  'exchanged',
];

describe('shipblu: documented request shapes', () => {
  it('sends the Api-Key header and the documented minimum create body', async () => {
    const { stub, carrier } = setup();
    // no items, no notes, prepaid: exactly the tutorial's minimum + our reference
    const req = shipmentRequest({ items: [], merchantReference: 'REF-MIN' });
    await carrier.createShipment(CREDS, req, { settings: {} });
    const [create] = posts(stub);
    expect(create.authorization).toBe(`Api-Key ${SHIPBLU_STUB.apiKey}`);
    expect(create.body).toEqual({
      customer: {
        full_name: 'Mona Adel',
        email: 'mona@example.com',
        phone: '+201012345678',
        address: { line_1: '5 Nile Corniche', line_2: 'Dokki', zone: 41 },
      },
      packages: [{ package_size: 1 }],
      merchant_order_reference: 'REF-MIN',
    });
    expect(Object.keys(create.body)).not.toContain('cash_amount');
    expect(JSON.stringify(create.body)).not.toContain('weight');
  });

  it('uses the staging host for sandbox and the live host otherwise', () => {
    expect(SHIPBLU_BASE_URLS.live).toBe('https://api.shipblu.com/api');
    expect(SHIPBLU_BASE_URLS.sandbox).toBe('https://api.staging.shipblu.com/api');
  });

  it('package_size comes from settings.packageSize (1..4), default 1; out of range is refused', async () => {
    const { stub, carrier } = setup();
    await carrier.createShipment(CREDS, shipmentRequest(), { settings: { packageSize: 3 } });
    expect(posts(stub)[0].body.packages[0].package_size).toBe(3);
    for (const bad of [0, 5, 1.5, 'big']) {
      await expect(
        carrier.createShipment(CREDS, shipmentRequest(), { settings: { packageSize: bad } })
      ).rejects.toMatchObject({ code: 'CARRIER_REJECTED' });
    }
    expect(posts(stub)).toHaveLength(1);
  });

  it.each([
    [1, 0.01],
    [29, 0.29],
    [12345, 123.45],
    [999999, 9999.99],
  ])('COD %i piastres is cash_amount %d', async (piastres, egp) => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(CREDS, shipmentRequest({ codAmount: piastres }), {
      settings: {},
    });
    expect(posts(stub)[0].body.cash_amount).toBe(egp);
    expect(stub.orderByTracking(r.trackingNumber)?.codMinor).toBe(piastres);
  });

  it('re-reads the order by id when the 201 carries no tracking_number (OpenAPI create schema)', async () => {
    const { stub, carrier } = setup();
    expect(stub.createReturnsTracking).toBe(false);
    const r = await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    expect(r.trackingNumber).toMatch(/^SB\d+$/);
    expect(
      stub.requests.some(q => q.method === 'GET' && /^\/v1\/delivery-orders\/\d+\/$/.test(q.path))
    ).toBe(true);
  });

  it('uses the tracking_number from the 201 when present (no extra read)', async () => {
    const { stub, carrier } = setup();
    stub.createReturnsTracking = true;
    await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    expect(stub.requests.some(q => /^\/v1\/delivery-orders\/\d+\/$/.test(q.path))).toBe(false);
  });
});

describe('shipblu: idempotency', () => {
  it('a second create with the same merchantReference makes no second POST', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    const a = await carrier.createShipment(CREDS, req, { settings: {} });
    const b = await carrier.createShipment(CREDS, req, { settings: {} });
    expect(posts(stub)).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it('a CONTAINS-style list filter never makes a different reference reuse the wrong order', async () => {
    const { stub, carrier } = setup();
    stub.containsFilter = true;
    const a = await carrier.createShipment(CREDS, shipmentRequest({ merchantReference: 'R-1' }), {
      settings: {},
    });
    const b = await carrier.createShipment(CREDS, shipmentRequest({ merchantReference: 'R-10' }), {
      settings: {},
    });
    expect(b.carrierShipmentId).not.toBe(a.carrierShipmentId);
    expect(posts(stub)).toHaveLength(2);
  });
});

describe('shipblu: statuses', () => {
  it('every one of the 32 OpenAPI statuses is either mapped or deliberately ignored, never both', () => {
    expect(new Set(OPENAPI_STATUS_ENUM).size).toBe(32);
    const mapped = Object.keys(SHIPBLU_STATUS_MAP);
    for (const s of OPENAPI_STATUS_ENUM) {
      const m = mapped.includes(s);
      const i = SHIPBLU_IGNORED_STATUSES.includes(s);
      expect(m !== i, `${s} must be exactly one of mapped / ignored`).toBe(true);
    }
    // and nothing outside the enum is claimed
    for (const s of [...mapped, ...SHIPBLU_IGNORED_STATUSES])
      expect(OPENAPI_STATUS_ENUM).toContain(s);
  });

  it.each([
    ['created', 'created'],
    ['pickup_requested', 'created'],
    ['pickup_rescheduled', 'created'],
    ['out_for_pickup', 'created'],
    ['picked_up', 'picked_up'],
    ['in_transit', 'in_transit'],
    ['en_route', 'in_transit'],
    ['delivery_attempted', 'in_transit'],
    ['reattempt_delivery', 'in_transit'],
    ['on_hold', 'in_transit'],
    ['release_hold', 'in_transit'],
    ['ops_delay', 'in_transit'],
    ['out_for_delivery', 'out_for_delivery'],
    ['delivered', 'delivered'],
    ['return_to_origin', 'in_transit'],
    ['returned_to_origin', 'in_transit'],
    ['out_for_return', 'in_transit'],
    ['return_requested', 'in_transit'],
    ['return_attempted', 'in_transit'],
    ['return_postponed', 'in_transit'],
    ['return_refused', 'in_transit'],
    ['returned', 'returned'],
    ['cancelled', 'cancelled'],
    ['lost', 'failed'],
    ['damaged', 'failed'],
  ])('%s -> %s', (raw, expected) => {
    expect(mapShipbluStatus(raw)).toBe(expected);
    expect(mapShipbluStatus(raw.toUpperCase())).toBe(expected); // docs print UPPERCASE
  });

  it.each([
    ...[
      'cod_change',
      'cod_deposited',
      'forfeited',
      'exchange_requested',
      'out_for_exchange',
      'exchange_attempted',
      'exchanged',
    ],
    'brand_new_status',
    '',
    null,
    5,
  ])('ignores %s (never guessed)', raw => expect(mapShipbluStatus(raw)).toBeNull());

  it('an ignored or unknown newest event does not decide the status; history is oldest-first', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(CREDS, shipmentRequest(), {
      settings: { autoRequestPickup: false },
    });
    stub.advanceRaw(r.trackingNumber, 'picked_up');
    stub.advanceRaw(r.trackingNumber, 'out_for_delivery');
    stub.advanceRaw(r.trackingNumber, 'cod_change');
    stub.advanceRaw(r.trackingNumber, 'some_future_status');
    for (const order of ['asc', 'desc'] as const) {
      stub.historyOrder = order;
      const t = await carrier.trackShipment(CREDS, r.trackingNumber, { settings: {} });
      expect(t.status).toBe('out_for_delivery');
      expect(t.statusHistory.map(h => h.status)).toEqual([
        'created',
        'picked_up',
        'out_for_delivery',
      ]);
    }
  });

  it('tracking an unknown number is a refusal, not a guessed status', async () => {
    const { carrier } = setup();
    await expect(carrier.trackShipment(CREDS, 'NOPE', { settings: {} })).rejects.toMatchObject({
      code: 'CARRIER_REJECTED',
    });
  });
});

describe('shipblu: label, quote, pickup', () => {
  it('returns the label as base64 of a real PDF (magic bytes checked)', async () => {
    const { carrier } = setup();
    const r = await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    const label = await carrier.getLabel(CREDS, r, { settings: {} });
    const bytes = Buffer.from(label.pdfBase64!, 'base64');
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('refuses an answer that is not a PDF', async () => {
    const stub = new ShipbluStub();
    const html = async () => new Response('<div>label</div>', { status: 200 });
    const carrier = new ShipbluCarrier({
      fetchImpl: html,
      baseUrl: SHIPBLU_STUB.baseUrl,
      timeoutMs: 50,
    });
    await expect(
      carrier.getLabel(CREDS, { carrierShipmentId: '1', trackingNumber: 'T' }, { settings: {} })
    ).rejects.toMatchObject({ code: 'CARRIER_UNAVAILABLE' });
    void stub;
  });

  it('quote posts the governorate id, COD and package sizes; total becomes piastres', async () => {
    const { stub, carrier } = setup();
    stub.price = 63.25;
    const q = await carrier.quote(
      CREDS,
      {
        pickupAddress: shipmentRequest().pickupAddress,
        deliveryAddress: shipmentRequest().deliveryAddress,
        codAmount: 12345,
      },
      { settings: { packageSize: 2 } }
    );
    expect(q).toEqual({ amountPiastres: 6325, source: 'api' });
    const call = stub.requests.find(r => r.path === '/v1/pricing/orders/delivery/')!;
    expect(call.body).toEqual({ to_governorate: 4, cash_amount: 123.45, packages: [2] });
  });

  it('quote for an unmatchable governorate is NEEDS_MAPPING', async () => {
    const { carrier } = setup();
    const addr = { ...shipmentRequest().deliveryAddress, state: 'Atlantis', city: 'Atlantis' };
    await expect(
      carrier.quote(
        CREDS,
        { pickupAddress: shipmentRequest().pickupAddress, deliveryAddress: addr },
        { settings: {} }
      )
    ).rejects.toMatchObject({ code: 'NEEDS_MAPPING' });
  });

  it('booking asks ShipBlu for the pickup by default (orders stay `created` until it is requested)', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    const calls = stub.requests.filter(x =>
      x.path.startsWith('/v1/delivery-orders/request-pickup/')
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(
      `/v1/delivery-orders/request-pickup/?tracking_numbers=${r.trackingNumber}`
    );
    expect(r.warning).toBeUndefined();
  });

  it('the merchant can turn the automatic pickup request off', async () => {
    const { stub, carrier } = setup();
    await carrier.createShipment(CREDS, shipmentRequest(), {
      settings: { autoRequestPickup: false },
    });
    expect(stub.requests.some(x => x.path.startsWith('/v1/delivery-orders/request-pickup/'))).toBe(
      false
    );
  });

  it('a refused pickup request does NOT fail (and so re-book) the order: it is a warning on the booking', async () => {
    const stub = new ShipbluStub();
    const carrier = new ShipbluCarrier({
      fetchImpl: (url: string, init?: RequestInit) =>
        String(url).includes('/request-pickup/')
          ? Promise.resolve(new Response('{"detail":"no"}', { status: 400 }))
          : stub.fetch(url, init),
      baseUrl: SHIPBLU_STUB.baseUrl,
      timeoutMs: 50,
    });
    const r = await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    expect(r.trackingNumber).toBeTruthy();
    expect(r.warning).toMatch(/pickup/i);
    expect(r.warning).not.toContain(CREDS.apiKey);
  });

  it('requestPickup posts comma-separated tracking numbers in the query, no body', async () => {
    const { stub, carrier } = setup();
    const off = { settings: { autoRequestPickup: false } };
    const a = await carrier.createShipment(CREDS, shipmentRequest(), off);
    const b = await carrier.createShipment(CREDS, shipmentRequest(), off);
    const out = await carrier.requestPickup(CREDS, [a.trackingNumber, b.trackingNumber], {
      settings: {},
    });
    expect(out.requested).toBe(2);
    const call = stub.requests.find(r => r.path.startsWith('/v1/delivery-orders/request-pickup/'))!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe(
      `/v1/delivery-orders/request-pickup/?tracking_numbers=${a.trackingNumber},${b.trackingNumber}`
    );
    expect(call.body).toBeUndefined();
    await expect(carrier.requestPickup(CREDS, [], { settings: {} })).rejects.toBeInstanceOf(
      CarrierError
    );
  });
});

describe('shipblu: cancel and webhooks (undocumented: safe, no network)', () => {
  it('cancel is not_cancellable and makes NO network call', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    const before = stub.requests.length;
    const out = await carrier.cancelShipment(CREDS, r.carrierShipmentId, { settings: {} });
    expect(out.status).toBe('not_cancellable');
    expect(out.message).toContain('ShipBlu dashboard');
    expect(stub.requests.length).toBe(before);
  });

  it('declares no webhooks and ignores every payload', () => {
    const { carrier } = setup();
    expect(carrier.capabilities).toEqual({
      quote: true,
      label: true,
      webhooks: false,
      polling: true,
      cod: true,
      // PROVIDERS-18: booking requests the pickup; there is nothing for the merchant to ask.
      pickup: 'automatic',
      pickupWindow: 'none',
      pickupCancel: false,
    });
    for (const p of [null, {}, { tracking_number: 'T', status: 'delivered' }, 'x']) {
      expect(carrier.processWebhook(p, {})).toBeNull();
    }
  });
});

describe('shipblu: testConnection and secrecy', () => {
  const SECRET = 'sk-live-SUPER-SECRET-0123456789';

  it('succeeds with a valid key', async () => {
    const { stub, carrier } = setup();
    expect(await carrier.testConnection(CREDS, { settings: {} })).toEqual({ success: true });
    expect(stub.requests[0].path).toBe('/v1/merchants/');
  });

  it('HTTP 403 (and 401) -> bad_credentials, without the key', async () => {
    const { stub, carrier } = setup();
    const out = await carrier.testConnection({ apiKey: SECRET }, { settings: {} });
    expect(out).toEqual({
      success: false,
      code: 'bad_credentials',
      error: 'ShipBlu refused the API key',
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    stub.validKeys.add(SECRET);
    stub.rejectAuth = true;
    expect((await carrier.testConnection({ apiKey: SECRET }, { settings: {} })).code).toBe(
      'bad_credentials'
    );
    const f401 = new ShipbluCarrier({
      fetchImpl: async () => new Response('{}', { status: 401 }),
      baseUrl: SHIPBLU_STUB.baseUrl,
    });
    expect((await f401.testConnection({ apiKey: SECRET })).code).toBe('bad_credentials');
  });

  it('a missing key is bad_credentials with no request made', async () => {
    const { stub, carrier } = setup();
    expect((await carrier.testConnection({ apiKey: '' }, { settings: {} })).code).toBe(
      'bad_credentials'
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('outage -> unreachable; any other failure -> unknown; neither leaks the key or a raw body', async () => {
    const { stub, carrier } = setup();
    stub.validKeys.add(SECRET);
    stub.injectNextCall('unavailable');
    const down = await carrier.testConnection({ apiKey: SECRET }, { settings: {} });
    expect(down.code).toBe('unreachable');
    stub.injectNextCall('rejected');
    const other = await carrier.testConnection({ apiKey: SECRET }, { settings: {} });
    expect(other.code).toBe('unknown');
    const odd = new ShipbluCarrier({
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: `echo ${SECRET}` }), { status: 400 }),
      baseUrl: SHIPBLU_STUB.baseUrl,
    });
    for (const out of [down, other, await odd.testConnection({ apiKey: SECRET })]) {
      expect(out.success).toBe(false);
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(JSON.stringify(out)).not.toContain('echo');
    }
  });

  it('a 404 on /v1/merchants/ (docs-only endpoint) falls back to the spec governorate list', async () => {
    const calls: string[] = [];
    const carrier = new ShipbluCarrier({
      baseUrl: SHIPBLU_STUB.baseUrl,
      fetchImpl: async url => {
        calls.push(new URL(url).pathname);
        return new Response(url.includes('merchants') ? '{"detail":"Not found."}' : '[]', {
          status: url.includes('merchants') ? 404 : 200,
        });
      },
    });
    expect((await carrier.testConnection({ apiKey: SECRET })).success).toBe(true);
    expect(calls).toEqual(['/api/v1/merchants/', '/api/v1/governorates/']);
  });

  it('errors thrown by create/label/track never contain the API key', async () => {
    const { stub, carrier } = setup();
    stub.rejectAuth = true;
    const errs: string[] = [];
    for (const run of [
      () => carrier.createShipment({ apiKey: SECRET }, shipmentRequest(), { settings: {} }),
      () =>
        carrier.getLabel(
          { apiKey: SECRET },
          { carrierShipmentId: '1', trackingNumber: 'T' },
          { settings: {} }
        ),
      () => carrier.trackShipment({ apiKey: SECRET }, 'T', { settings: {} }),
      () =>
        carrier.quote(
          { apiKey: SECRET },
          {
            pickupAddress: shipmentRequest().pickupAddress,
            deliveryAddress: shipmentRequest().deliveryAddress,
          },
          { settings: {} }
        ),
    ]) {
      const e = await run().catch(x => x);
      expect(e).toBeInstanceOf(CarrierError);
      expect(e.code).toBe('CARRIER_MISCONFIGURED');
      errs.push(String(e.message), String(e.stack ?? '').split('\n')[0]);
    }
    for (const m of errs) expect(m).not.toContain(SECRET);
  });
});

describe('shipblu: address -> zone mapping', () => {
  it('NEEDS_MAPPING when no zone matches, and nothing is booked', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    req.deliveryAddress = {
      ...req.deliveryAddress,
      state: 'Atlantis',
      city: 'Atlantis',
      area: 'Reef',
    };
    await expect(carrier.createShipment(CREDS, req, { settings: {} })).rejects.toMatchObject({
      code: 'NEEDS_MAPPING',
    });
    expect(posts(stub)).toHaveLength(0);
  });

  it('a known governorate whose district matches no zone is NEEDS_MAPPING too (no guessing)', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    req.deliveryAddress = {
      ...req.deliveryAddress,
      state: 'Cairo',
      city: 'Cairo',
      area: 'Nowhereville',
    };
    await expect(carrier.createShipment(CREDS, req, { settings: {} })).rejects.toMatchObject({
      code: 'NEEDS_MAPPING',
    });
    expect(posts(stub)).toHaveLength(0);
  });

  it('resolves Arabic and English spellings of governorate, city and zone', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    req.deliveryAddress = {
      ...req.deliveryAddress,
      state: 'القاهرة',
      city: 'القاهرة الجديدة',
      area: 'التجمع الخامس',
    };
    await carrier.createShipment(CREDS, req, { settings: {} });
    expect(posts(stub)[0].body.customer.address.zone).toBe(12);
  });

  it('settings.zoneMap overrides name matching and skips the location calls', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    req.deliveryAddress = {
      ...req.deliveryAddress,
      state: 'Atlantis',
      city: 'Atlantis',
      area: 'Reef',
    };
    await carrier.createShipment(CREDS, req, { settings: { zoneMap: { reef: 777 } } });
    expect(posts(stub)[0].body.customer.address.zone).toBe(777);
    expect(stub.requests.some(r => r.path.includes('governorates'))).toBe(false);
  });

  it('caches the location lists per call account: the second order needs no lookups', async () => {
    const { stub, carrier } = setup();
    await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    const lookups = () => stub.requests.filter(r => /governorates|cities/.test(r.path)).length;
    const first = lookups();
    expect(first).toBeGreaterThan(0);
    await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    expect(lookups()).toBe(first);
  });

  it('two different credentials never share a location cache (keyed by credential hash)', async () => {
    const { stub, carrier } = setup();
    stub.validKeys.add('other-merchant-key');
    await carrier.createShipment(CREDS, shipmentRequest(), { settings: {} });
    const govCalls = () => stub.requests.filter(r => r.path === '/v1/governorates/');
    expect(govCalls()).toHaveLength(1);
    await carrier.createShipment({ apiKey: 'other-merchant-key' }, shipmentRequest(), {
      settings: {},
    });
    expect(govCalls()).toHaveLength(2);
    expect(govCalls()[1].authorization).toBe('Api-Key other-merchant-key');
    // a key the carrier would refuse must not ride on the first merchant's warm cache
    stub.rejectAuth = true;
    await expect(
      carrier.createShipment({ apiKey: 'third-key' }, shipmentRequest(), { settings: {} })
    ).rejects.toMatchObject({ code: 'CARRIER_MISCONFIGURED' });
  });

  it('a sandbox call and a live call keep separate caches for the same key', async () => {
    const stub = new ShipbluStub();
    const seen: string[] = [];
    const carrier = new ShipbluCarrier({
      fetchImpl: (u, i) => {
        seen.push(new URL(u).host);
        return stub.fetch(u.replace(/^https:\/\/[^/]+/, 'http://shipblu.stub'), i);
      },
    });
    await carrier.createShipment(CREDS, shipmentRequest(), { settings: { sandbox: true } });
    await carrier.createShipment(CREDS, shipmentRequest(), { settings: { sandbox: false } });
    expect(new Set(seen)).toEqual(new Set(['api.staging.shipblu.com', 'api.shipblu.com']));
    expect(stub.requests.filter(r => r.path === '/v1/governorates/')).toHaveLength(2);
  });
});
