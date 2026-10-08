/**
 * A local stand-in for Bosta's REST API v2 (SP7). No real keys, no network: the adapter is given
 * `stub.fetch` as its transport. Shapes follow Bosta's OFFICIAL OpenAPI (docs.bosta.co/api/api.yaml):
 * the v2 envelope `{ success, message, data }`, errors `{ success:false, message, errorCode }`
 * (1028 bad key, 1008 forbidden, 1066 not found, 3007 COD limit, 3009 address), the real live
 * city table (spec 10) and the documented webhook body (spec 8).
 *
 * Where the docs are silent the stub makes a CHOICE, marked `STUB-CHOICE:`: it proves the adapter's
 * behaviour for that choice, not Bosta's. Deliberately NOT idempotent on create (Bosta has no
 * idempotency header); a duplicate `uniqueBusinessReference` is refused, which is the documented
 * intent of that field (the refusal text itself is a stub choice).
 */
import crypto from 'node:crypto';
import type { ShipmentStatus } from '@api/services/carriers/types';
import { FaultGate, json, headerOf, type StubFault } from './stub-common';
import { egpToPiastres } from '@api/lib/carrier-http';

export const BOSTA_STUB = { baseUrl: 'http://bosta.stub/api/v2', apiKey: 'bosta-test-key' };

/** Shared status -> the official state code the stub moves a parcel to (spec 7). */
const CODE_FOR: Record<ShipmentStatus, number> = {
  created: 10,
  picked_up: 21,
  in_transit: 24,
  out_for_delivery: 41,
  delivered: 45,
  failed: 100,
  returned: 46,
  cancelled: 48,
};

const STATE_NAME: Record<number, string> = {
  10: 'Pickup requested',
  20: 'Route Assigned',
  21: 'Picked up from business',
  24: 'Received at warehouse',
  30: 'In transit between Hubs',
  41: 'Picked up',
  45: 'Delivered',
  46: 'Returned to business',
  47: 'Exception',
  48: 'Terminated',
  49: 'Canceled',
  100: 'Lost',
  101: 'Damaged',
};

/** The live city table (spec 10, probed 2026-10-07): code, name, nameAr, id, drop-off available. */
const CITY_ROWS: Array<[string, string, string, string, boolean]> = [
  ['EG-01', 'Cairo', 'القاهره', 'FceDyHXwpSYYF9zGW', true],
  ['EG-02', 'Alexandria', 'الاسكندريه', 'Jrb6X6ucjiYgMP4T7', true],
  ['EG-03', 'North Coast', 'الساحل الشمالي', '2hGtNLfRgqGrJjnW9', true],
  ['EG-04', 'Behira', 'البحيره', 'g3GchTSmCgR2JynsJ', true],
  ['EG-05', 'Dakahlia', 'الدقهليه', 'RrDhS8YYsXAwZ9Zfo', true],
  ['EG-06', 'El Kalioubia', 'القليوبيه', 'yp3atroeTwnyiBNKE', true],
  ['EG-07', 'Gharbia', 'الغربيه', 'K3RwC677J8kJytdZD', true],
  ['EG-08', 'Kafr Alsheikh', 'كفر الشيخ', 'ByP7rFCjL6XzF6j4S', true],
  ['EG-09', 'Monufia', 'المنوفيه', 'ruBSjGBDX9wpRa3cc', true],
  ['EG-10', 'Sharqia', 'الشرقيه', '6ExcoGbpYHnggP8JD', true],
  ['EG-11', 'Ismailia', 'الاسماعيليه', 'PJqNriLtFtx2cfkKP', true],
  ['EG-12', 'Suez', 'السويس', 'PickurJ5uJZ9rDTHW', true],
  ['EG-13', 'Port Said', 'بور سعيد', 'skFtf6ZmKo8kBEBDK', true],
  ['EG-14', 'Damietta', 'دمياط', 'qoZvYcZ8Cqji4pGp5', true],
  ['EG-15', 'Fayoum', 'الفيوم', 'BW5MiNxEirB7tuz2y', true],
  ['EG-16', 'Bani Suif', 'بني سويف', 'LzbbvTzZ7D2CgE2PL', true],
  ['EG-17', 'Assuit', 'اسيوط', '7mDPAohM3ArSZmWTm', true],
  ['EG-18', 'Sohag', 'سوهاج', 'n3EENg2adhuR9xBZK', true],
  ['EG-19', 'Menya', 'المنيا', 'si6eLnKjXqTFTMBj9', true],
  ['EG-20', 'Qena', 'قنا', 'vfTHTes3uGjAszgtg', true],
  ['EG-21', 'Aswan', 'اسوان', 'kLvZ5JY6LJPL5chzN', true],
  ['EG-22', 'Luxor', 'الاقصر', 'wgYEdH2WMzxGE2Ztp', true],
  ['EG-23', 'Red Sea', 'البحر الاحمر', 'r5TscLCNSjR2GimxQ', true],
  ['EG-24', 'New Valley', 'الوادي الجديد', 'w4yDVHVJWqa4HpbzA', true],
  ['EG-25', 'Giza', 'الجيزه', '0064Qb0OgcA', true],
  ['EG-26', 'South Sinai', 'جنوب سيناء', 'nG_c44vHQht', true],
  ['EG-27', 'North Sinai', 'شمال سيناء', 'ZuCaDAVQlPT', false],
  ['EG-28', 'Matrouh', 'مرسي مطروح', 'KBpGiRZJMIx', true],
];

const CITIES = CITY_ROWS.map(([code, name, nameAr, _id, dropOff]) => ({
  _id,
  name,
  nameAr,
  code,
  alias: nameAr,
  sector: 1,
  pickupAvailability: true,
  dropOffAvailability: dropOff,
  showAsDropOff: dropOff,
  showAsPickup: true,
}));

/** STUB-CHOICE: a compact subset of districts (the real list is large). */
const DISTRICTS: Record<string, Array<[string, string, string, string]>> = {
  // cityId -> [zoneId, zoneName, districtId, districtName]
  FceDyHXwpSYYF9zGW: [
    ['zNasr', 'Nasr City', 'dNasr1', 'Nasr City'],
    ['zMaadi', 'Maadi', 'dMaadi1', 'Maadi'],
    ['zHeli', 'Heliopolis', 'dHeli1', 'Heliopolis'],
  ],
  '0064Qb0OgcA': [
    ['zDokki', 'Dokki', 'dDokki1', 'Dokki'],
    ['zHaram', 'Haram', 'dHaram1', 'Haram'],
    ['zOct', '6th of October', 'dOct1', '6th of October'],
  ],
  Jrb6X6ucjiYgMP4T7: [['zSmouha', 'Smouha', 'dSmouha1', 'Smouha']],
};

const districtRows = (cityId: string) =>
  (DISTRICTS[cityId] ?? []).map(([zoneId, zoneName, districtId, districtName]) => ({
    zoneId,
    zoneName,
    zoneOtherName: zoneName,
    districtId,
    districtName,
    districtOtherName: districtName,
    pickupAvailability: true,
    dropOffAvailability: true,
  }));

export interface BostaParcel {
  /** Bosta's own `_id` (the adapter keeps it as `carrierTransactionId`). */
  id: string;
  trackingNumber: string;
  businessReference: string;
  uniqueBusinessReference: string;
  /** What the adapter sent, verbatim (EGP number). */
  codSent: number;
  /** The same, as the stub reads it: integer piastres. */
  codMinor: number;
  webhookUrl?: string;
  webhookCustomHeaders?: Record<string, string>;
  /** The whole create body, verbatim. */
  createBody: Record<string, any>;
  state: number;
  events: Array<{ code: number; date: string }>;
}

export interface BostaRequestLog {
  method: string;
  path: string;
  query: string;
  authorization?: string;
  body?: any;
}

const ok = (data: unknown, message = 'Done successfully.') =>
  json(200, { success: true, message, data });
const fail = (status: number, message: string, errorCode: number) =>
  json(status, { success: false, message, errorCode, data: null });

export class BostaStub {
  readonly faults = new FaultGate();
  readonly parcels = new Map<string, BostaParcel>();
  readonly requests: BostaRequestLog[] = [];
  readonly pickups: Array<Record<string, any>> = [];
  /** The order the `history` array is returned in. */
  historyOrder: 'asc' | 'desc' = 'desc';
  /** The price the rate endpoint answers (EGP). */
  price = 45.5;
  rejectAuth = false;
  /** Key scope: `write` = Read/Write (terminate answers 403 / 1008), `full` = Full access. */
  keyScope: 'write' | 'full' = 'full';
  /** STUB-CHOICE: the search endpoint is documented Bearer-only; `true` makes it refuse an API key. */
  searchRequiresBearer = false;
  /** STUB-CHOICE: the AWB answers JSON `{ data: base64 }` or the raw base64 text. */
  awbFormat: 'json' | 'raw' = 'json';
  /** Pickup locations the account owns. */
  locations = ['LOC1', 'LOC2'];
  // Carrier events must be NEWER than the shipment's own `created` history entry (stamped at
  // booking, i.e. now) or mergeTracking ignores them as stale. A fixed past date here was a time
  // bomb: it passed until the wall clock moved past it. Start ahead of "now" instead.
  private clock = Date.now() + 6 * 3_600_000;
  private seq = 5_108_000;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = u.pathname.replace('/api/v2', '');
    let body: any;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    this.requests.push({
      method,
      path,
      query: u.search,
      authorization: headerOf(init, 'authorization'),
      body,
    });
    const early = await this.faults.enter();
    if (early) return early;

    // Spec 10: cities / zones / districts need no auth.
    if (method === 'GET' && path === '/cities') return ok({ list: CITIES });
    let m = /^\/cities\/([^/]+)\/districts$/.exec(path);
    if (method === 'GET' && path === '/cities/getAllDistricts') {
      return ok(
        CITIES.map(c => ({
          cityId: c._id,
          cityName: c.name,
          cityOtherName: c.nameAr,
          cityCode: c.code,
          districts: districtRows(c._id),
          pickupAvailability: true,
          dropOffAvailability: c.dropOffAvailability,
        }))
      );
    }
    if (method === 'GET' && m) return ok(districtRows(m[1]));

    if (this.rejectAuth || headerOf(init, 'authorization') !== BOSTA_STUB.apiKey) {
      return fail(401, 'Invalid authorization token or API key.', 1028);
    }

    if (method === 'POST' && path === '/deliveries') return this.create(body ?? {});
    if (method === 'POST' && path === '/deliveries/search') {
      if (this.searchRequiresBearer)
        return fail(401, 'Invalid authorization token or API key.', 1028);
      const hits = [...this.parcels.values()].filter(
        p => p.businessReference === body?.businessReference
      );
      return ok({
        deliveries: hits.map(p => ({
          _id: p.id,
          trackingNumber: p.trackingNumber,
          businessReference: p.businessReference,
          state: { code: p.state, value: STATE_NAME[p.state] },
        })),
      });
    }
    if (method === 'POST' && path === '/deliveries/mass-awb') {
      const tn = String(body?.trackingNumbers ?? '');
      if (!this.parcelByTracking(tn)) return fail(404, 'Delivery not found', 1066);
      const pdf = Buffer.from('%PDF-1.4\n% stub awb\n%%EOF\n').toString('base64');
      if (this.awbFormat === 'raw') {
        return new Response(pdf, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return ok(pdf);
    }
    if (method === 'GET' && path === '/pickup-locations') {
      return ok({
        total: this.locations.length,
        list: this.locations.map(id => ({
          _id: id,
          locationName: `Location ${id}`,
          contactPerson: { name: 'Stub', email: 'stub@example.test', phone: '01000000000' },
          address: { firstLine: 'Stub St 1', city: { _id: CITIES[0]._id, name: 'cairo' } },
          isDefault: id === this.locations[0],
        })),
        page: 1,
        limit: 50,
        pages: 1,
      });
    }
    if (method === 'POST' && path === '/pickups') {
      if (!body?.businessLocationId || !body?.scheduledDate) {
        return fail(400, 'businessLocationId and scheduledDate are required', 1010);
      }
      const puid = String(7_878_000 + this.pickups.length + 1);
      // The docs' create answer carries both `puid` and the document `_id` ('070000002519').
      const _id = `07000000${String(2_500 + this.pickups.length + 1).padStart(4, '0')}`;
      this.pickups.push({ ...body, puid, _id, state: 'Requested' });
      return ok(
        {
          type: 'Business Pickup',
          scheduledDate: body.scheduledDate,
          scheduledTimeSlot: '10:00 to 13:00',
          state: 'Requested',
          puid,
          _id,
          businessLocationId: body.businessLocationId,
          contactPerson: body.contactPerson,
          deliveries: [],
        },
        'Pickup Request Created Successfully.'
      );
    }
    // DELETE /pickups/{id} ("Deletes a pickup by ID"; 200 with no documented body, 400 Bad Request).
    // STUB-CHOICE: a pickup already picked up (state not Requested) answers 400.
    const del = method === 'DELETE' ? /^\/pickups\/([^/]+)$/.exec(path) : null;
    if (del) {
      const pu = this.pickups.find(x => x._id === decodeURIComponent(del[1]));
      if (!pu || pu.state !== 'Requested') return fail(400, 'Pickup cannot be cancelled', 1011);
      pu.state = 'Canceled';
      return ok({}, 'Done successfully.');
    }
    // STUB-CHOICE: the pricing response body is undocumented; `data.priceAfterVat` is one shape the adapter reads.
    if (method === 'GET' && path === '/pricing/shipment/calculator') {
      return ok({ priceAfterVat: this.price });
    }

    m = /^\/deliveries\/business\/([^/]+)\/terminate$/.exec(path);
    if (method === 'DELETE' && m) {
      if (this.keyScope !== 'full') {
        return fail(403, 'Access to the requested resource is forbidden', 1008);
      }
      const p = this.parcelByTracking(decodeURIComponent(m[1]));
      if (!p) return fail(404, 'Delivery not found', 1066);
      // STUB-CHOICE: the states that allow terminate are undocumented; here only before pickup.
      if (p.state >= 21) {
        return fail(400, 'Delivery already picked up, cannot terminate', 1093);
      }
      this.setState(p, 48);
      return ok({ _id: p.id }, 'Delivery has been terminated successfully.');
    }
    m = /^\/deliveries\/business\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const p = this.parcelByTracking(decodeURIComponent(m[1]));
      if (!p) return fail(404, 'Delivery not found', 1066);
      const entries = p.events.map(e => ({
        state: { code: e.code, value: STATE_NAME[e.code] ?? String(e.code) },
        date: e.date,
      }));
      // `timeline` is the documented progress track (value / done / date), always oldest first;
      // `history` entry shape is a STUB-CHOICE (undocumented) and honours `historyOrder`.
      const timeline = p.events.map(e => ({
        value: STATE_NAME[e.code] ?? String(e.code),
        done: true,
        date: e.date,
      }));
      const history = this.historyOrder === 'desc' ? [...entries].reverse() : entries;
      return ok({
        _id: p.id,
        trackingNumber: p.trackingNumber,
        businessReference: p.businessReference,
        cod: p.codSent,
        type: { code: 10, value: 'Send' },
        state: { code: p.state, value: STATE_NAME[p.state] ?? String(p.state) },
        timeline,
        history,
      });
    }
    return fail(404, `stub: no route ${method} ${path}`, 1066);
  };

  private create(body: Record<string, any>): Response {
    const cod = Number(body.cod);
    if (body.type !== 10) return fail(400, 'stub: only type 10 (SEND) is served', 3005);
    if (!Number.isFinite(cod) || cod < 0) return fail(400, 'cod is required', 3006);
    if (cod > 30_000) return fail(400, 'COD exceeds 30,000 EGP', 3007);
    const a = body.dropOffAddress ?? {};
    if (!a.city || !a.firstLine || String(a.firstLine).length <= 5) {
      return fail(400, 'dropOffAddress.city and a firstLine over 5 characters are required', 3009);
    }
    if (!a.districtId && !(a.districtName && a.cityId)) {
      return fail(400, 'districtId, or districtName with cityId, is required', 3009);
    }
    const ref = String(body.uniqueBusinessReference ?? '');
    if (ref && [...this.parcels.values()].some(p => p.uniqueBusinessReference === ref)) {
      // STUB-CHOICE: the duplicate refusal's code and text are undocumented.
      return fail(400, 'uniqueBusinessReference already exists', 2088);
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 21);
    const trackingNumber = String(++this.seq);
    const parcel: BostaParcel = {
      id,
      trackingNumber,
      businessReference: String(body.businessReference ?? ''),
      uniqueBusinessReference: ref,
      codSent: cod,
      codMinor: egpToPiastres(String(cod)),
      webhookUrl: body.webhookUrl,
      webhookCustomHeaders: body.webhookCustomHeaders,
      createBody: body,
      state: 10,
      events: [{ code: 10, date: this.tick() }],
    };
    this.parcels.set(id, parcel);
    return ok(
      {
        _id: id,
        trackingNumber,
        businessReference: parcel.businessReference,
        message: 'Delivery created successfully!',
        state: { code: 10, value: 'Pickup requested' },
        creationSrc: 'API',
      },
      'Done successfully.'
    );
  }

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private setState(p: BostaParcel, code: number, date?: string) {
    p.state = code;
    p.events.push({ code, date: date ?? this.tick() });
  }

  parcelByTracking(t: string): BostaParcel | undefined {
    return [...this.parcels.values()].find(p => p.trackingNumber === t);
  }

  advance(trackingNumber: string, status: ShipmentStatus) {
    this.advanceToCode(trackingNumber, CODE_FOR[status]);
  }

  /** Move a parcel to an exact official state code (e.g. 47 Exception). */
  advanceToCode(trackingNumber: string, code: number) {
    const p = this.parcelByTracking(trackingNumber);
    if (!p) throw new Error(`stub: unknown parcel ${trackingNumber}`);
    this.setState(p, code);
  }

  /** The body Bosta would POST to the callback URL (spec 8: `state` Number, `timeStamp` epoch ms). */
  webhookBody(trackingNumber: string, status: ShipmentStatus, timestamp: Date) {
    const p = this.parcelByTracking(trackingNumber);
    return {
      _id: p?.id,
      trackingNumber: Number(trackingNumber),
      state: CODE_FOR[status],
      type: 'SEND',
      timeStamp: timestamp.getTime(),
      businessReference: p?.businessReference,
      numberOfAttempts: 0,
    };
  }

  /** The custom headers Bosta would send with that webhook (what the adapter registered at create). */
  webhookHeaders(trackingNumber: string): Record<string, string> {
    return this.parcelByTracking(trackingNumber)?.webhookCustomHeaders ?? {};
  }

  injectNextCall(fault: StubFault) {
    this.faults.injectNextCall(fault);
  }
}
