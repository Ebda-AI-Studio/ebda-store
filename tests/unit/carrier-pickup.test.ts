/**
 * PROVIDERS-18 — the shared pickup actions on each carrier adapter, against the local stubs that
 * follow each carrier's OFFICIAL spec (Bosta api.yaml `/pickups`, Aramex Shipping WSDL
 * CreatePickup / CancelPickup, Mylerz swagger PickupOrder/CreatePickupOrder +
 * Lookup/GetAllPickupTimeWindow). No real carrier is called and no real pickup is booked.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { BostaCarrier } from '@api/services/carriers/bosta.carrier';
import { AramexCarrier } from '@api/services/carriers/aramex.carrier';
import { MylerzCarrier } from '@api/services/carriers/mylerz.carrier';
import { CARRIER_REGISTRY } from '@api/services/carriers/registry';
import { cairoToday, cairoWallClock, isPickupDate } from '@api/services/carriers/pickup-time';
import type { CarrierPickupRequest } from '@api/services/carriers/types';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { AramexStub, ARAMEX_NS, ARAMEX_STUB } from '../stubs/aramex-stub';
import { MylerzStub, MYLERZ_STUB } from '../stubs/mylerz-stub';
import { shipmentRequest } from '../contract/shipping-carrier.contract';

const pickupReq = (over: Partial<CarrierPickupRequest> = {}): CarrierPickupRequest => ({
  date: '2026-10-12',
  address: shipmentRequest().pickupAddress,
  trackingNumbers: ['TRK-1'],
  reference: 'pickup-row-1',
  ...over,
});

describe('capabilities say what each carrier offers', () => {
  it('Bosta request/no window/cancel; Aramex request/times/cancel; Mylerz request/slots/no cancel; ShipBlu automatic; manual none', () => {
    const cap = (c: keyof typeof CARRIER_REGISTRY) => {
      const k = CARRIER_REGISTRY[c].capabilities;
      return [k.pickup, k.pickupWindow, k.pickupCancel];
    };
    expect(cap('bosta')).toEqual(['request', 'none', true]);
    expect(cap('aramex')).toEqual(['request', 'times', true]);
    expect(cap('mylerz')).toEqual(['request', 'carrier_slots', false]);
    expect(cap('shipblu')).toEqual(['automatic', 'none', false]);
    expect(cap('manual')).toEqual(['none', 'none', false]);
    // A carrier that declares a request has the method behind it (and cancel likewise).
    for (const impl of Object.values(CARRIER_REGISTRY)) {
      expect(!!impl.schedulePickup).toBe(impl.capabilities.pickup === 'request');
      expect(!!impl.cancelPickup).toBe(impl.capabilities.pickupCancel);
      expect(!!impl.pickupWindows).toBe(impl.capabilities.pickupWindow === 'carrier_slots');
    }
  });
});

describe('Bosta: POST /pickups, DELETE /pickups/{id}', () => {
  const creds = { apiKey: BOSTA_STUB.apiKey, businessLocationId: 'LOC1' };
  const mk = () => {
    const stub = new BostaStub();
    return {
      stub,
      carrier: new BostaCarrier({
        fetchImpl: stub.fetch,
        baseUrl: BOSTA_STUB.baseUrl,
        timeoutMs: 200,
      }),
    };
  };

  it('books the date with the location, contact and tracking numbers; keeps _id for cancel and PUID to quote', async () => {
    const { stub, carrier } = mk();
    const out = await carrier.schedulePickup(creds, pickupReq({ trackingNumbers: ['5108001'] }));
    expect(stub.pickups[0]).toMatchObject({
      businessLocationId: 'LOC1',
      scheduledDate: '2026-10-12',
      numberOfParcels: 1,
      trackingNumbers: ['5108001'],
      contactPerson: { name: shipmentRequest().pickupAddress.name },
    });
    expect(out.carrierPickupId).toBe(stub.pickups[0]._id);
    expect(out.carrierReference).toBe(stub.pickups[0].puid);
    expect(out.timeSlot).toBe('10:00 to 13:00'); // assigned by Bosta
  });

  it('cancels by _id; a second cancel is reported not_cancellable, not thrown', async () => {
    const { stub, carrier } = mk();
    const out = await carrier.schedulePickup(creds, pickupReq());
    expect(await carrier.cancelPickup(creds, out)).toEqual({ status: 'cancelled' });
    const del = stub.requests.find(r => r.method === 'DELETE');
    expect(del?.path).toBe(`/pickups/${out.carrierPickupId}`);
    expect((await carrier.cancelPickup(creds, out)).status).toBe('not_cancellable');
  });
});

describe('Aramex: Shipping/CreatePickup + CancelPickup', () => {
  const creds = ARAMEX_STUB.credentials;
  const ctx = { settings: { productType: 'CDS' } };
  const mk = () => {
    const stub = new AramexStub();
    return {
      stub,
      carrier: new AramexCarrier({
        fetchImpl: stub.fetch,
        baseUrl: ARAMEX_STUB.baseUrl,
        timeoutMs: 200,
      }),
    };
  };
  const dom = (xml: string) =>
    new new JSDOM('').window.DOMParser().parseFromString(xml, 'text/xml');

  it('sends the Cairo window as ReadyTime/LastPickupTime in UTC (EEST +3 in October)', async () => {
    const { stub, carrier } = mk();
    const out = await carrier.schedulePickup(
      creds,
      pickupReq({ window: { from: '10:00', to: '16:00' }, trackingNumbers: ['AWB1'] }),
      ctx
    );
    expect(out.carrierPickupId).toMatch(/^[0-9a-f-]{36}$/); // CancelPickup takes the GUID
    expect(out.carrierReference).toBe('PU1');
    const xml = stub.log.find(l => l.action?.endsWith('/CreatePickup'))!.xml;
    const doc = dom(xml);
    const v = (n: string) => doc.getElementsByTagNameNS(ARAMEX_NS, n)[0]?.textContent;
    expect(v('ReadyTime')).toBe('2026-10-12T07:00:00.000Z');
    expect(v('LastPickupTime')).toBe('2026-10-12T13:00:00.000Z');
    expect(v('Reference1')).toBe('pickup-row-1');
    expect(stub.violations).toEqual([]);
  });

  it('refuses without a window, before any call', async () => {
    const { stub, carrier } = mk();
    await expect(carrier.schedulePickup(creds, pickupReq(), ctx)).rejects.toMatchObject({
      code: 'CARRIER_REJECTED',
    });
    expect(stub.log).toHaveLength(0);
  });

  it('CancelPickup by GUID in the WSDL element order; HasErrors is not_cancellable', async () => {
    const { stub, carrier } = mk();
    const out = await carrier.schedulePickup(
      creds,
      pickupReq({ window: { from: '10:00', to: '12:00' } }),
      ctx
    );
    expect(await carrier.cancelPickup(creds, out, ctx)).toEqual({ status: 'cancelled' });
    const xml = stub.log.find(l => l.action?.endsWith('/CancelPickup'))!.xml;
    const w = dom(xml).getElementsByTagNameNS('*', 'Body')[0].children[0];
    expect(Array.from(w.children).map(c => c.localName)).toEqual([
      'ClientInfo',
      'Transaction',
      'PickupGUID',
      'Comments',
    ]);
    expect(stub.violations).toEqual([]);
    expect((await carrier.cancelPickup(creds, out, ctx)).status).toBe('not_cancellable');
  });
});

describe('Mylerz: GetAllPickupTimeWindow + CreatePickupOrder', () => {
  const creds = () => ({ ...MYLERZ_STUB.credentials });
  const mk = () => {
    const stub = new MylerzStub();
    return {
      stub,
      carrier: new MylerzCarrier({
        fetchImpl: stub.fetch,
        baseUrl: MYLERZ_STUB.baseUrl,
        timeoutMs: 100,
      }),
    };
  };

  it('lists the carrier slots (Id, SlotTime, IsDefault)', async () => {
    const { carrier } = mk();
    expect(await carrier.pickupWindows(creds(), { settings: {} })).toEqual([
      { id: '1', label: '09:00 - 13:00', isDefault: true },
      { id: '2', label: '13:00 - 17:00', isDefault: false },
    ]);
  });

  it('orders the pickup for the chosen date and slot with the barcode', async () => {
    const { stub, carrier } = mk();
    const out = await carrier.schedulePickup(
      creds(),
      pickupReq({ windowId: '2', trackingNumbers: ['12345678901234'] }),
      { settings: {} }
    );
    expect(out).toEqual({ carrierPickupId: 'PU1' });
    const sent = JSON.parse(
      stub.requests.find(r => r.path === '/api/PickupOrder/CreatePickupOrder')!.body!
    );
    expect(sent).toMatchObject({
      PickupLocationName: MYLERZ_STUB.credentials.warehouseName,
      PickupDueDate: '2026-10-12T09:00:00',
      PickupTimeWindowId: 2,
      ExpectedPackageCount: 1,
      Packages: [{ Barcode: '12345678901234' }],
    });
  });

  it('a non-numeric slot id is refused before any call', async () => {
    const { stub, carrier } = mk();
    await expect(
      carrier.schedulePickup(creds(), pickupReq({ windowId: 'x' }), { settings: {} })
    ).rejects.toMatchObject({ code: 'CARRIER_REJECTED' });
    expect(stub.requests.some(r => r.path === '/api/PickupOrder/CreatePickupOrder')).toBe(false);
  });
});

describe('Cairo wall clock', () => {
  it('follows Egypt DST: +3 in October 2026 (EEST), +2 in January (EET)', () => {
    expect(cairoWallClock('2026-10-12', '10:00').toISOString()).toBe('2026-10-12T07:00:00.000Z');
    expect(cairoWallClock('2027-01-12', '10:00').toISOString()).toBe('2027-01-12T08:00:00.000Z');
  });
  it('validates calendar dates', () => {
    expect(isPickupDate('2026-02-29')).toBe(false);
    expect(isPickupDate('2028-02-29')).toBe(true);
    expect(isPickupDate(cairoToday())).toBe(true);
  });
});
