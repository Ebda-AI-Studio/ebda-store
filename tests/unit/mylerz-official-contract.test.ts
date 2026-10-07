/**
 * Mylerz adapter against the DOCUMENTED shapes (spec: S1 official Swagger, S2 live probes,
 * S3 Mylerz API v1.3.1 PDF). Statuses other than "Not Picked Yet" are NOT documented, so the
 * mapping tests cover only that one documented value plus the adapter's own plain-English names,
 * and assert that anything else is ignored rather than guessed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shipmentRequest } from '../contract/shipping-carrier.contract';
import {
  MYLERZ_STATUS_MAP,
  MylerzCarrier,
  mapMylerzStatus,
} from '@api/services/carriers/mylerz.carrier';
import { CarrierError } from '@api/services/carriers/types';
import { json } from '../stubs/stub-common';
import { MylerzStub, MYLERZ_STUB } from '../stubs/mylerz-stub';

const creds = () => ({ ...MYLERZ_STUB.credentials });
const setup = () => {
  const stub = new MylerzStub();
  const carrier = new MylerzCarrier({
    fetchImpl: stub.fetch,
    baseUrl: MYLERZ_STUB.baseUrl,
    timeoutMs: 100,
  });
  return { stub, carrier };
};
const addOrdersBodies = (stub: MylerzStub) =>
  stub.requests.filter(r => r.path === '/api/Orders/AddOrders').map(r => JSON.parse(r.body!));

describe('mylerz: auth (S1/S2/S3)', () => {
  it('POSTs /token as a urlencoded password grant and sends the token as a Bearer header', async () => {
    const { stub, carrier } = setup();
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const carrier2 = new MylerzCarrier({
      baseUrl: MYLERZ_STUB.baseUrl,
      fetchImpl: async (u, i) => {
        seen.push({ url: u, init: i });
        return stub.fetch(u, i);
      },
    });
    expect((await carrier2.testConnection(creds(), { settings: {} })).success).toBe(true);
    const tok = seen[0];
    expect(tok.url).toBe('http://mylerz.stub/token');
    expect(tok.init?.method).toBe('POST');
    expect((tok.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(String(tok.init?.body)).toBe(
      `grant_type=password&username=${encodeURIComponent(MYLERZ_STUB.username)}&password=${MYLERZ_STUB.password}`
    );
    const api = seen[1];
    expect(api.url).toBe('http://mylerz.stub/api/Orders/GetWarehouses');
    expect((api.init?.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer [0-9a-f]{20,}$/
    );
    void carrier;
  });

  it('token endpoint 400 invalid_grant (S2) is CARRIER_MISCONFIGURED', async () => {
    const { stub, carrier } = setup();
    stub.rejectAuth = true;
    const err = await carrier
      .createShipment(creds(), shipmentRequest(), { settings: {} })
      .catch(e => e);
    expect(err).toBeInstanceOf(CarrierError);
    expect(err.code).toBe('CARRIER_MISCONFIGURED');
    expect(stub.parcels.size).toBe(0);
  });

  it('reuses the token across calls (one /token for several API calls)', async () => {
    const { stub, carrier } = setup();
    await carrier.testConnection(creds(), { settings: {} });
    await carrier.testConnection(creds(), { settings: {} });
    expect(stub.tokensIssued()).toBe(1);
  });

  it('re-logs in ONCE on a 401 and retries', async () => {
    const { stub, carrier } = setup();
    await carrier.testConnection(creds(), { settings: {} });
    stub.revokeTokens();
    expect((await carrier.testConnection(creds(), { settings: {} })).success).toBe(true);
    expect(stub.tokensIssued()).toBe(2);
  });

  it('a second 401 right after a fresh login is bad credentials, not a loop', async () => {
    let tokens = 0;
    const carrier = new MylerzCarrier({
      baseUrl: 'http://x.stub',
      fetchImpl: async u =>
        u.endsWith('/token')
          ? (tokens++, json(200, { access_token: 'tok-abc-123', expires_in: 100000 }))
          : json(401, { Message: 'Authorization has been denied for this request.' }),
    });
    const out = await carrier.testConnection(creds(), { settings: {} });
    expect(out).toMatchObject({ success: false, code: 'bad_credentials' });
    expect(tokens).toBe(2);
  });

  it('refreshes an expired token: expires_in is honoured with a 60 s skew', async () => {
    vi.useFakeTimers();
    try {
      const { stub, carrier } = setup();
      stub.expiresIn = 3600;
      await carrier.testConnection(creds(), { settings: {} });
      vi.advanceTimersByTime(3_500_000); // before expiry - skew
      await carrier.testConnection(creds(), { settings: {} });
      expect(stub.tokensIssued()).toBe(1);
      vi.advanceTimersByTime(100_000); // past expiry - 60 s
      await carrier.testConnection(creds(), { settings: {} });
      expect(stub.tokensIssued()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('token cache isolation: a second merchant triggers its own /token call', async () => {
    const tokenUsers: string[] = [];
    const bearerByUser = new Map<string, string>();
    const calls: Array<{ user?: string }> = [];
    const carrier = new MylerzCarrier({
      baseUrl: 'http://iso.stub',
      fetchImpl: async (u, init) => {
        if (u.endsWith('/token')) {
          const user = new URLSearchParams(String(init?.body)).get('username')!;
          tokenUsers.push(user);
          const t = `token-for-${bearerByUser.size}-${user.length}`;
          bearerByUser.set(t, user);
          return json(200, { access_token: t, expires_in: 99999 });
        }
        const bearer = String((init?.headers as Record<string, string>).Authorization).slice(7);
        calls.push({ user: bearerByUser.get(bearer) });
        return json(200, { Value: [{ Name: 'W' }], IsErrorState: false });
      },
    });
    const a = { username: 'alice', password: 'pw-a', warehouseName: 'W' };
    const b = { username: 'bobby', password: 'pw-b', warehouseName: 'W' };
    await carrier.testConnection(a, { settings: {} });
    await carrier.testConnection(b, { settings: {} });
    await carrier.testConnection(a, { settings: {} });
    await carrier.testConnection(b, { settings: {} });
    expect(tokenUsers).toEqual(['alice', 'bobby']); // two logins, never shared, each reused
    expect(calls.map(c => c.user)).toEqual(['alice', 'bobby', 'alice', 'bobby']);
    // same username with another password is another merchant too
    await carrier.testConnection({ ...a, password: 'pw-other' }, { settings: {} });
    expect(tokenUsers).toHaveLength(3);
  });
});

describe('mylerz: sandbox has no host', () => {
  const saved = process.env.MYLERZ_BASE_URL;
  beforeEach(() => {
    delete process.env.MYLERZ_BASE_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYLERZ_BASE_URL;
    else process.env.MYLERZ_BASE_URL = saved;
  });

  const TEXT = 'Mylerz has no public sandbox: ask Mylerz for a staging host';

  it('refuses every operation and makes NO network call', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const carrier = new MylerzCarrier({ fetchImpl });
    const ctx = { settings: { sandbox: true } };
    const calls = [
      () => carrier.createShipment(creds(), shipmentRequest(), ctx),
      () => carrier.trackShipment(creds(), 'X', ctx),
      () => carrier.cancelShipment(creds(), 'X', ctx),
      () => carrier.getLabel(creds(), { carrierShipmentId: 'X', trackingNumber: 'X' }, ctx),
      () =>
        carrier.quote(
          creds(),
          {
            pickupAddress: shipmentRequest().pickupAddress,
            deliveryAddress: shipmentRequest().deliveryAddress,
          },
          ctx
        ),
    ];
    for (const run of calls) {
      const err = await run().catch(e => e);
      expect(err).toBeInstanceOf(CarrierError);
      expect(err.code).toBe('CARRIER_MISCONFIGURED');
      expect(err.message).toBe(TEXT);
    }
    expect(await carrier.testConnection(creds(), ctx)).toEqual({
      success: false,
      code: 'unknown',
      error: TEXT,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sandbox mode with the string "true" is the same refusal', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const out = await new MylerzCarrier({ fetchImpl }).testConnection(creds(), {
      settings: { sandbox: 'true' },
    });
    expect(out.error).toBe(TEXT);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('MYLERZ_BASE_URL is the only sandbox host (honoured outside production)', async () => {
    const stub = new MylerzStub();
    process.env.MYLERZ_BASE_URL = 'http://mylerz.stub/';
    const carrier = new MylerzCarrier({ fetchImpl: stub.fetch });
    const out = await carrier.testConnection(creds(), { settings: { sandbox: true } });
    expect(out.success).toBe(true);
    expect(stub.requests[0].path).toBe('/token');
  });
});

describe('mylerz: createShipment body (S3 sample + S1 required union)', () => {
  it('builds the S3 sample as a one-element OrderDTO array', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T09:00:00Z'));
    try {
      const { stub, carrier } = setup();
      stub.cities[0].Zones.push({ Code: 'CAI-MAA2', EnName: 'Maadi Degla', ArName: 'دجلة' });
      const req = shipmentRequest({
        merchantReference: '1000',
        orderId: '1000',
        codAmount: 30000,
        items: [{ name: 'A package with 2 items', quantity: 1 }],
        deliveryAddress: {
          name: 'Mohamed Nasr',
          phone: '01111111111',
          line1: 'Sherief Hosney',
          city: 'Cairo',
          state: 'Cairo',
          area: 'Maadi',
          country: 'EG',
        },
      });
      const r = await carrier.createShipment(creds(), req, { settings: {} });
      const [orders] = addOrdersBodies(stub);
      expect(Array.isArray(orders)).toBe(true);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        WarehouseName: 'Main Warehouse',
        PickupDueDate: '2026-10-08T09:00:00',
        Package_Serial: 1,
        Reference: '1000',
        Description: '1 x A package with 2 items',
        Service_Type: 'DTD',
        Service: 'ND',
        Service_Category: 'DELIVERY',
        Payment_Type: 'COD',
        COD_Value: 300,
        Customer_Name: 'Mohamed Nasr',
        Mobile_No: '01111111111',
        Street: 'Sherief Hosney',
        Country: 'Egypt',
        City: 'Cairo',
        Neighborhood: 'Maadi',
        Pieces: [{ PieceNo: 1 }],
      });
      // barcode of the first package is both the tracking number and the shipment id
      expect(r.trackingNumber).toBe(r.carrierShipmentId);
      expect(r.trackingNumber).toMatch(/^6374\d{7}001$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepaid is Payment_Type PP with COD_Value 0; Service is overridable', async () => {
    const { stub, carrier } = setup();
    await carrier.createShipment(creds(), shipmentRequest(), { settings: { mylerzService: 'SD' } });
    expect(addOrdersBodies(stub)[0][0]).toMatchObject({
      Payment_Type: 'PP',
      COD_Value: 0,
      Service: 'SD',
    });
  });

  it.each([
    [1, 0.01],
    [29, 0.29],
    [12345, 123.45],
    [999999, 9999.99],
  ])('COD %i piastres is COD_Value %d (no float drift)', async (piastres, egp) => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(creds(), shipmentRequest({ codAmount: piastres }), {
      settings: {},
    });
    expect(addOrdersBodies(stub)[0][0].COD_Value).toBe(egp);
    expect(stub.parcelByTracking(r.trackingNumber)?.codMinor).toBe(piastres);
  });

  it('an unmapped area is NEEDS_MAPPING and books nothing; a zoneMap override resolves it', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    req.deliveryAddress.area = 'Atlantis';
    const err = await carrier.createShipment(creds(), req, { settings: {} }).catch(e => e);
    expect(err.code).toBe('NEEDS_MAPPING');
    expect(stub.parcels.size).toBe(0);
    const ok = await carrier.createShipment(
      creds(),
      shipmentRequest({ ...req, merchantReference: 'ref-zm' }),
      {
        settings: { zoneMap: { atlantis: { city: 'Giza', neighborhood: 'Dokki' } } },
      }
    );
    expect(ok.trackingNumber).toBeTruthy();
    expect(addOrdersBodies(stub).at(-1)[0]).toMatchObject({ City: 'Giza', Neighborhood: 'Dokki' });
  });
});

describe('mylerz: envelope errors (S1: HTTP 200 + IsErrorState)', () => {
  const withBooking = (reply: (path: string) => unknown) => {
    const stub = new MylerzStub();
    const carrier = new MylerzCarrier({
      baseUrl: MYLERZ_STUB.baseUrl,
      fetchImpl: async (u, i) => {
        const p = new URL(u).pathname;
        if (p === '/api/Orders/AddOrders') return json(200, reply(p));
        return stub.fetch(u, i);
      },
    });
    return carrier;
  };

  it('IsErrorState true is CARRIER_REJECTED carrying ErrorDescription', async () => {
    const carrier = withBooking(() => ({
      Value: null,
      IsErrorState: true,
      ErrorDescription: 'Invalid warehouse',
    }));
    const err = await carrier
      .createShipment(creds(), shipmentRequest(), { settings: {} })
      .catch(e => e);
    expect(err.code).toBe('CARRIER_REJECTED');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Invalid warehouse');
  });

  it('a long ErrorDescription is truncated', async () => {
    const carrier = withBooking(() => ({
      Value: null,
      IsErrorState: true,
      ErrorDescription: 'x'.repeat(5000),
    }));
    const err = await carrier
      .createShipment(creds(), shipmentRequest(), { settings: {} })
      .catch(e => e);
    expect(err.message.length).toBeLessThan(300);
  });

  it('a per-package ErrorCode/ErrorMessage is a refusal', async () => {
    const carrier = withBooking(() => ({
      Value: {
        Packages: [
          { packageNo: 1, BarCode: null, ErrorCode: '300', ErrorMessage: 'Missing required field' },
        ],
      },
      IsErrorState: false,
    }));
    const err = await carrier
      .createShipment(creds(), shipmentRequest(), { settings: {} })
      .catch(e => e);
    expect(err.code).toBe('CARRIER_REJECTED');
    expect(err.message).toContain('Missing required field');
  });

  it('an order-level ErrorMessage is a refusal', async () => {
    const carrier = withBooking(() => ({
      Value: { ErrorCode: 'E1', ErrorMessage: 'Warehouse not found', Packages: [] },
      IsErrorState: false,
    }));
    const err = await carrier
      .createShipment(creds(), shipmentRequest(), { settings: {} })
      .catch(e => e);
    expect(err.code).toBe('CARRIER_REJECTED');
  });

  it('a success without a barcode is retryable (the parcel may exist), not a refusal', async () => {
    const carrier = withBooking(() => ({
      Value: { PickupOrderCode: '1', Packages: [{ packageNo: 1 }] },
      IsErrorState: false,
    }));
    const err = await carrier
      .createShipment(creds(), shipmentRequest(), { settings: {} })
      .catch(e => e);
    expect(err.code).toBe('CARRIER_UNAVAILABLE');
  });
});

describe('mylerz: idempotency', () => {
  it('a repeat in the same process books one parcel', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    const a = await carrier.createShipment(creds(), req, { settings: {} });
    const b = await carrier.createShipment(creds(), req, { settings: {} });
    expect(b).toEqual(a);
    expect(addOrdersBodies(stub)).toHaveLength(1);
  });

  it('a fresh process finds the parcel by Reference first and does NOT call AddOrders again', async () => {
    const { stub, carrier } = setup();
    const req = shipmentRequest();
    const a = await carrier.createShipment(creds(), req, { settings: {} });
    const restarted = new MylerzCarrier({
      fetchImpl: stub.fetch,
      baseUrl: MYLERZ_STUB.baseUrl,
      timeoutMs: 100,
    });
    const b = await restarted.createShipment(creds(), req, { settings: {} });
    expect(b.trackingNumber).toBe(a.trackingNumber);
    expect(addOrdersBodies(stub)).toHaveLength(1);
    const lookup = stub.requests.filter(r => r.path === '/api/packages/TrackPackages').at(-1)!;
    expect(JSON.parse(lookup.body!)).toEqual([{ ReferenceNumber: req.merchantReference }]);
  });

  it('the same reference at another merchant is not collapsed', async () => {
    const stub = new MylerzStub();
    const carrier = new MylerzCarrier({ fetchImpl: stub.fetch, baseUrl: MYLERZ_STUB.baseUrl });
    const req = shipmentRequest();
    await carrier.createShipment(creds(), req, { settings: {} });
    // other merchant (same stub only knows one login, so a failed login proves a separate scope)
    const err = await carrier
      .createShipment({ ...creds(), username: 'other@example.test' }, req, { settings: {} })
      .catch(e => e);
    expect(err.code).toBe('CARRIER_MISCONFIGURED');
    expect(addOrdersBodies(stub)).toHaveLength(1);
  });
});

describe('mylerz: cancel (S1 ChangePackageStatusResponseDTO)', () => {
  it('IsChanged true is cancelled; the body is an array of {Barcode}', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(creds(), shipmentRequest(), { settings: {} });
    expect(await carrier.cancelShipment(creds(), r.carrierShipmentId, { settings: {} })).toEqual({
      status: 'cancelled',
    });
    const sent = stub.requests.find(x => x.path === '/api/packages/CancelPackage')!;
    expect(JSON.parse(sent.body!)).toEqual([{ Barcode: r.carrierShipmentId }]);
  });

  it('IsChanged false is not_cancellable with the ErrorMessage', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(creds(), shipmentRequest(), { settings: {} });
    stub.advance(r.trackingNumber, 'picked_up');
    expect(await carrier.cancelShipment(creds(), r.carrierShipmentId, { settings: {} })).toEqual({
      status: 'not_cancellable',
      message: 'Package already picked up',
    });
  });

  it('an unknown barcode is never reported cancelled', async () => {
    const { carrier } = setup();
    const out = await carrier.cancelShipment(creds(), 'nope', { settings: {} });
    expect(out.status).not.toBe('cancelled');
  });

  it('an empty / odd Value is never reported cancelled', async () => {
    for (const Value of [
      [],
      null,
      [{ Barcode: 'B', ErrorMessage: 'x' }],
      [{ Barcode: 'B', IsChanged: 'true' }],
    ]) {
      const stub = new MylerzStub();
      const carrier = new MylerzCarrier({
        baseUrl: MYLERZ_STUB.baseUrl,
        fetchImpl: async (u, i) =>
          new URL(u).pathname === '/api/packages/CancelPackage'
            ? json(200, { Value, IsErrorState: false })
            : stub.fetch(u, i),
      });
      const out = await carrier.cancelShipment(creds(), 'B', { settings: {} });
      expect(out.status).not.toBe('cancelled');
    }
  });
});

describe('mylerz: status mapping (only documented / plainly named; the rest is not guessed)', () => {
  it('"Not Picked Yet" (the documented S3 status) is created', () => {
    expect(mapMylerzStatus('Not Picked Yet')).toBe('created');
    expect(MYLERZ_STATUS_MAP['not picked yet']).toBe('created');
  });

  it.each([
    ['Picked Up', 'picked_up'],
    ['IN TRANSIT', 'in_transit'],
    ['out for delivery', 'out_for_delivery'],
    ['Delivered', 'delivered'],
    ['Returned', 'returned'],
    ['Cancelled', 'cancelled'],
    ['  Canceled ', 'cancelled'],
  ])('%s -> %s (case-insensitive)', (name, status) => {
    expect(mapMylerzStatus(name)).toBe(status);
  });

  it.each(['Delivery Attempt Failed', 'Hub Scan 7', 'Lost', '', '17', null, undefined, 5])(
    'unknown status %j is not mapped',
    s => {
      expect(mapMylerzStatus(s)).toBeNull();
    }
  );

  it('an unknown status is kept out of the history; the last KNOWN status stays current', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(creds(), shipmentRequest(), { settings: {} });
    stub.advance(r.trackingNumber, 'picked_up');
    stub.addRawEvent(r.trackingNumber, 'Sorted At Hub 42');
    stub.addRawEvent(r.trackingNumber, 'Delivery Attempt Failed');
    const t = await carrier.trackShipment(creds(), r.trackingNumber, { settings: {} });
    expect(t.status).toBe('picked_up');
    expect(t.statusHistory.map(h => h.status)).toEqual(['created', 'picked_up']);
  });

  it('only unknown statuses: falls back to created, never throws, never invents', async () => {
    const stub = new MylerzStub();
    const carrier = new MylerzCarrier({
      baseUrl: MYLERZ_STUB.baseUrl,
      fetchImpl: async (u, i) =>
        new URL(u).pathname === '/api/packages/TrackPackages'
          ? json(200, {
              Value: [
                {
                  Barcode: 'B1',
                  TrackLog: [
                    {
                      StatusCode: '99',
                      StatusEnName: 'Mystery',
                      ChangedDate: '2026-10-07T10:00:00',
                    },
                  ],
                },
              ],
              IsErrorState: false,
            })
          : stub.fetch(u, i),
    });
    const t = await carrier.trackShipment(creds(), 'B1', { settings: {} });
    expect(t).toEqual({ status: 'created', statusHistory: [] });
  });

  it('webhooks are undocumented: capability off and every payload ignored', () => {
    const { carrier } = setup();
    expect(carrier.capabilities.webhooks).toBe(false);
    expect(carrier.processWebhook({ Barcode: 'B', StatusEnName: 'Delivered' }, {})).toBeNull();
  });
});

describe('mylerz: label, quote, pickup, test connection', () => {
  it('label is base64 decoded and checked for %PDF; a non-PDF is refused', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(creds(), shipmentRequest(), { settings: {} });
    const l = await carrier.getLabel(creds(), r, { settings: {} });
    expect(Buffer.from(l.pdfBase64!, 'base64').toString().startsWith('%PDF')).toBe(true);
    const sent = stub.requests.find(x => x.path === '/api/packages/GetAWB')!;
    expect(JSON.parse(sent.body!)).toEqual({ Barcode: r.trackingNumber });

    const bad = new MylerzCarrier({
      baseUrl: MYLERZ_STUB.baseUrl,
      fetchImpl: async (u, i) =>
        new URL(u).pathname === '/api/packages/GetAWB'
          ? json(200, {
              Value: Buffer.from('<html>oops</html>').toString('base64'),
              IsErrorState: false,
            })
          : stub.fetch(u, i),
    });
    await expect(bad.getLabel(creds(), r, { settings: {} })).rejects.toMatchObject({
      code: 'CARRIER_UNAVAILABLE',
    });
  });

  it('quote maps ShippingFees to piastres and refuses a non-finite price', async () => {
    const { stub, carrier } = setup();
    const q = {
      pickupAddress: shipmentRequest().pickupAddress,
      deliveryAddress: shipmentRequest().deliveryAddress,
    };
    expect(await carrier.quote(creds(), q, { settings: {} })).toEqual({
      amountPiastres: 4550,
      source: 'api',
    });
    for (const fee of [Number.NaN, null, 'abc', -5]) {
      stub.fee = fee as number;
      const s2 = new MylerzCarrier({
        baseUrl: MYLERZ_STUB.baseUrl,
        fetchImpl: async (u, i) =>
          new URL(u).pathname === '/api/packages/GetExpectedCharges'
            ? json(200, { Value: { ShippingFees: fee, TotalTransfer: fee }, IsErrorState: false })
            : stub.fetch(u, i),
      });
      await expect(s2.quote(creds(), q, { settings: {} })).rejects.toBeInstanceOf(CarrierError);
    }
  });

  it('createPickup posts to CreatePickupOrder and returns the PickupOrderCode', async () => {
    const { stub, carrier } = setup();
    const out = await carrier.createPickup(creds(), ['B1', 'B2'], { settings: {} });
    expect(out.pickupOrderCode).toBe('PU1');
    const sent = JSON.parse(
      stub.requests.find(x => x.path === '/api/PickupOrder/CreatePickupOrder')!.body!
    );
    expect(sent).toMatchObject({
      PickupLocationName: 'Main Warehouse',
      ExpectedPackageCount: 2,
      Packages: [{ Barcode: 'B1' }, { Barcode: 'B2' }],
    });
  });

  it('testConnection checks the warehouse name and lists up to 5 known names', async () => {
    const { stub, carrier } = setup();
    stub.warehouses = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(Name => ({ Name }));
    const out = await carrier.testConnection(creds(), { settings: {} });
    expect(out).toEqual({
      success: false,
      code: 'unknown',
      error: 'Mylerz does not know a warehouse called "Main Warehouse". Known: A, B, C, D, E',
    });
  });

  it('bad credentials -> bad_credentials; outage -> unreachable', async () => {
    const a = setup();
    a.stub.rejectAuth = true;
    expect(await a.carrier.testConnection(creds(), { settings: {} })).toMatchObject({
      success: false,
      code: 'bad_credentials',
    });
    const b = setup();
    b.stub.faults.down = 'unavailable';
    expect(await b.carrier.testConnection(creds(), { settings: {} })).toMatchObject({
      success: false,
      code: 'unreachable',
    });
  });
});

describe('mylerz: no credential or token ever reaches a message or result', () => {
  const USER = 'secret.user@example.test';
  const PASS = 'p@ss-w0rd-SECRET';
  const c = { username: USER, password: PASS, warehouseName: 'Main Warehouse' };
  const TOKEN = 'tok-SECRETTOKEN-0123456789';
  const clean = (v: unknown) => {
    const s =
      JSON.stringify(v instanceof Error ? { m: v.message, n: v.name, s: String(v) } : v) ?? '';
    for (const secret of [USER, PASS, TOKEN, encodeURIComponent(USER), encodeURIComponent(PASS)]) {
      expect(s).not.toContain(secret);
    }
  };

  // A hostile carrier that echoes our secrets back in every error text it can.
  const echoing = (mode: 'envelope' | 'http400' | 'http500' | 'login400') =>
    new MylerzCarrier({
      baseUrl: 'http://echo.stub',
      fetchImpl: async (u, i) => {
        if (u.endsWith('/token')) {
          if (mode === 'login400')
            return json(400, { error: PASS, error_description: `${USER}/${PASS}` });
          return json(200, { access_token: TOKEN, expires_in: 9999 });
        }
        if (mode === 'http400') return json(400, { message: `bad ${TOKEN} ${USER} ${PASS}` });
        if (mode === 'http500') return json(500, { message: `${TOKEN}` });
        return json(200, {
          Value: null,
          IsErrorState: true,
          ErrorDescription: `denied for ${USER} with ${PASS} and ${TOKEN}`,
        });
      },
    });

  it.each(['envelope', 'http400', 'http500', 'login400'] as const)(
    'thrown messages are scrubbed (%s)',
    async mode => {
      const carrier = echoing(mode);
      const ctx = { settings: {} };
      const attempts: Array<() => Promise<unknown>> = [
        () => carrier.createShipment(c, shipmentRequest(), ctx),
        () => carrier.trackShipment(c, 'B', ctx),
        () => carrier.getLabel(c, { carrierShipmentId: 'B', trackingNumber: 'B' }, ctx),
        () => carrier.cancelShipment(c, 'B', ctx),
        () => carrier.testConnection(c, ctx),
      ];
      for (const run of attempts) {
        try {
          clean(await run());
        } catch (err) {
          expect(err).toBeInstanceOf(CarrierError);
          clean(err);
        }
      }
    }
  );

  it('a missing-credential error names the field, never a value', async () => {
    const carrier = new MylerzCarrier({
      fetchImpl: async () => json(200, {}),
      baseUrl: 'http://x.stub',
    });
    const err = await carrier
      .createShipment({ username: USER, password: '', warehouseName: 'W' }, shipmentRequest(), {
        settings: {},
      })
      .catch(e => e);
    expect(err.code).toBe('CARRIER_MISCONFIGURED');
    expect(err.message).toBe('Mylerz password is missing');
    clean(err);
  });

  it('successful results carry no secrets either', async () => {
    const { stub, carrier } = setup();
    const r = await carrier.createShipment(creds(), shipmentRequest(), { settings: {} });
    for (const secret of [MYLERZ_STUB.password, MYLERZ_STUB.username]) {
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(await carrier.testConnection(creds(), { settings: {} }))).not.toContain(
        secret
      );
    }
    void stub;
  });
});
