// ==========================================
// Bosta Carrier Implementation (SP7)
// ==========================================
//
// Built from Bosta's OFFICIAL OpenAPI (https://docs.bosta.co/api/api.yaml) and the how-to pages
// under https://docs.bosta.co/docs/how-to/. "Spec N" below = section N of the research copy
// (docs/ebda/research, scratch spec-bosta.md). Anything the official docs do not settle is marked
// `UNVERIFIED:` and coded so it can only fail safe (refuse / ask the merchant / report an outage),
// never guess. Contract-tested against tests/stubs/bosta-stub.ts, which serves the documented shapes.
//
//  - Auth (spec 0): `Authorization: <raw API key>`, NO "Bearer ".
//  - COD (spec 2): `cod` is a plain EGP number, limit 30,000 EGP (error 3007), converted here from piastres.
//  - Identity (spec 3, 9): the TRACKING NUMBER is what lookups and terminate take, so it is stored as
//    `carrierShipmentId`; Bosta's own `_id` rides in `carrierTransactionId`.
//  - Webhooks (spec 8): Bosta signs nothing. Ebda hands Bosta the secret callback URL AND a derived
//    custom header (`webhookCustomHeaders`); the service requires both (see `webhookHeader`).
//  - Idempotency (spec 3b): no idempotency header. `uniqueBusinessReference` + `businessReference`
//    carry our reference, and the reference is searched BEFORE every create.

import crypto from 'node:crypto';
import {
  CarrierCallContext,
  CarrierCancelResult,
  CarrierCapabilities,
  CarrierError,
  CarrierLabel,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierShipmentRequest,
  CarrierShipmentResponse,
  CarrierTestResult,
  CarrierTrackingResponse,
  CarrierWebhookResult,
  ShipmentAddress,
  ShipmentStatus,
  ShippingCarrierProvider,
  TrackingHistoryEntry,
} from './types';
import {
  carrierRequest,
  piastresToEgp,
  resolveCarrierBaseUrl,
  type CarrierHttpOptions,
  type ResolvedBase,
} from '../../lib/carrier-http';
import { canonicalGovernorate, pickByName } from './egypt-areas';

export const BOSTA_BASE_URLS = {
  // Spec 0: live host + `/api/v2` (https; the docs list the http:// form).
  live: 'https://app.bosta.co/api/v2',
  // UNVERIFIED: staging is named only by Bosta's own SDK README (github.com/bostaapp/bosta-nodejs),
  // not by docs.bosta.co. A probe answered identically to production.
  sandbox: 'https://stg-app.bosta.co/api/v2',
};

/** Header Bosta echoes back on every webhook delivery (set via `webhookCustomHeaders`, spec 2 + 8). */
export const BOSTA_WEBHOOK_HEADER = 'x-ebda-webhook-secret';

/**
 * The header VALUE derived from the store's webhook secret: HMAC-SHA256(secret, fixed label), hex.
 * Never the secret itself, so the URL token and the header value cannot be swapped for each other.
 */
export function webhookHeaderValue(secret: string): string {
  return crypto.createHmac('sha256', secret).update('ebda-bosta-webhook-header-v1').digest('hex');
}

export interface BostaCredentials {
  apiKey: string;
  /** Bosta pickup location id (`businessLocationId`, spec 2/6); omitted = the account's default location. */
  businessLocationId?: string;
  /** Per-store secret: the URL path token, and the source of the custom webhook header value. */
  webhookSecret?: string;
}

/** Spec 2: "limit is 30,000 EGP" (error 3007). */
export const BOSTA_MAX_COD_EGP = 30_000;
/** Spec 10: Egypt's country id for `GET /cities?countryId=`. */
const EGYPT_COUNTRY_ID = '60e4482c7cb7d4bc4849c4d5';
const LOCATION_TTL_MS = 60 * 60 * 1000;

// ------------------------------------------------------------------ state mapping (spec 7)

/**
 * The OFFICIAL state table (spec 7) mapped onto our shared statuses. Codes not listed are IGNORED
 * (null), never guessed: 40 (Cash Collection "Picking up", a type we never create) and 104 (Archived).
 */
const BOSTA_STATE_MAP: Record<string, ShipmentStatus> = {
  '10': 'created', // Pickup requested
  '11': 'created', // Waiting for route (cash collection)
  '20': 'created', // Route assigned: nothing has left the business yet
  '21': 'picked_up', // Picked up from business
  '22': 'in_transit', // Picking up from consignee (CRP / exchange leg, NOT a delivery)
  '23': 'in_transit', // Picked up from consignee (CRP / exchange leg, NOT a delivery)
  '24': 'in_transit', // Received at warehouse
  '25': 'in_transit', // Fulfilled (fulfilment)
  '30': 'in_transit', // In transit between hubs
  '41': 'out_for_delivery', // Picked up / out for delivery (SEND); out for RETURN on other types
  '45': 'delivered',
  '46': 'returned', // Returned to business
  '47': 'in_transit', // Exception: a delivery attempt problem, parcel still moving (reason carried)
  '48': 'cancelled', // Terminated
  '49': 'cancelled', // Canceled
  '60': 'returned', // Returned to stock (fulfilment)
  '100': 'failed', // Lost
  '101': 'failed', // Damaged
  '102': 'in_transit', // Investigation
  '103': 'failed', // Awaiting your action (3 failed returns)
  '105': 'in_transit', // On hold
};

/** State names (spec 7, lower-case) -> code, for timeline entries that carry a name instead of a code. */
const BOSTA_STATE_NAME_TO_CODE: Record<string, number> = {
  'pickup requested': 10,
  'waiting for route': 11,
  'route assigned': 20,
  'picked up from business': 21,
  'picking up from consignee': 22,
  'picked up from consignee': 23,
  'received at warehouse': 24,
  fulfilled: 25,
  'in transit between hubs': 30,
  'picked up': 41,
  delivered: 45,
  'returned to business': 46,
  exception: 47,
  terminated: 48,
  canceled: 49,
  cancelled: 49,
  'returned to stock': 60,
  lost: 100,
  damaged: 101,
  investigation: 102,
  'awaiting your action': 103,
  'on hold': 105,
};

/** Types on which state 41 means "out for RETURN" (spec 7), not "out for delivery". */
function isReturnLeg(type: unknown): boolean {
  if (type && typeof type === 'object') {
    const o = type as Record<string, unknown>;
    return isReturnLeg(o.code ?? o.value);
  }
  if (type === 25 || type === 30 || type === '25' || type === '30') return true; // CRP, exchange
  if (typeof type !== 'string') return false;
  const t = type
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return ['EXCHANGE', 'CUSTOMER_RETURN_PICKUP', 'CRP', 'RTO'].includes(t);
}

function stateCode(state: unknown): number | null {
  if (state && typeof state === 'object') {
    const o = state as Record<string, unknown>;
    return stateCode(o.code ?? o.value);
  }
  if (typeof state === 'number' && Number.isFinite(state)) return state;
  if (typeof state === 'string') {
    const t = state.trim();
    if (/^\d+$/.test(t)) return Number(t);
    return BOSTA_STATE_NAME_TO_CODE[t.toLowerCase()] ?? null;
  }
  return null;
}

/**
 * Normalize a Bosta state (number, numeric string, name, or `{ code, value }`) to a ShipmentStatus,
 * or null for an unknown / ignored one. `type` (webhook string `SEND`... or `{code,value}`) turns
 * state 41 on a return leg into `in_transit`.
 */
export function mapBostaState(state: unknown, type?: unknown): ShipmentStatus | null {
  const code = stateCode(state);
  if (code === null) return null;
  const mapped = BOSTA_STATE_MAP[String(code)] ?? null;
  if (mapped === 'out_for_delivery' && isReturnLeg(type)) return 'in_transit';
  return mapped;
}

// ------------------------------------------------------------------ helpers

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] || 'Customer', lastName: parts.slice(1).join(' ') || '-' };
}

/**
 * UNVERIFIED: whether Bosta accepts "+20..." numbers. The docs show only the local form
 * ("01065685435"), so an Egyptian number is sent in that form; anything else is sent untouched.
 */
export function bostaPhone(phone: string): string {
  const digits = phone.replace(/[\s()-]/g, '');
  const m = /^(?:\+|00)?20(1[0125]\d{8})$/.exec(digits);
  return m ? `0${m[1]}` : digits;
}

const numeric = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** The first array found at any of these places in a v2 envelope (shapes differ per endpoint). */
function listOf(body: Body, keys: string[]): Body[] {
  const data = body?.data;
  if (Array.isArray(data)) return data;
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return data[k];
    if (Array.isArray(body?.[k])) return body[k];
  }
  return [];
}

type Body = Record<string, any>;

interface BostaCity {
  _id: string;
  name: string;
  nameAr?: string;
  alias?: string;
  code?: string;
  dropOffAvailability?: boolean;
}
interface BostaDistrict {
  zoneId?: string;
  zoneName?: string;
  zoneOtherName?: string;
  districtId: string;
  districtName: string;
  districtOtherName?: string;
  dropOffAvailability?: boolean;
}

/**
 * Spec 10 (live probe 2026-10-07): the Bosta city code per governorate. Used before name matching
 * because Bosta spells some differently ("Behira", "Menya", "Bani Suif"). Verified against the live
 * list at call time: a code the list does not contain falls through to name matching.
 */
const GOVERNORATE_TO_BOSTA_CODE: Record<string, string> = {
  cairo: 'EG-01',
  alexandria: 'EG-02',
  beheira: 'EG-04',
  dakahlia: 'EG-05',
  qalyubia: 'EG-06',
  gharbia: 'EG-07',
  'kafr-el-sheikh': 'EG-08',
  monufia: 'EG-09',
  sharqia: 'EG-10',
  ismailia: 'EG-11',
  suez: 'EG-12',
  'port-said': 'EG-13',
  damietta: 'EG-14',
  fayoum: 'EG-15',
  'beni-suef': 'EG-16',
  assiut: 'EG-17',
  sohag: 'EG-18',
  minya: 'EG-19',
  qena: 'EG-20',
  aswan: 'EG-21',
  luxor: 'EG-22',
  'red-sea': 'EG-23',
  'new-valley': 'EG-24',
  giza: 'EG-25',
  'south-sinai': 'EG-26',
  'north-sinai': 'EG-27',
  matrouh: 'EG-28',
};

// Per-process cache of Bosta's public location lists, keyed by BASE URL (a staging list must never
// answer for production) with a 1h TTL. Failures are never cached.
interface LocationCache {
  at: number;
  cities: BostaCity[];
  districts: Map<string, { at: number; list: BostaDistrict[] }>;
}
const locationCache = new Map<string, LocationCache>();

/** Drop every cached city / district list (tests; also a manual "refresh locations"). */
export function clearBostaLocationCache(): void {
  locationCache.clear();
}

interface Resolved {
  city: BostaCity;
}

// ------------------------------------------------------------------ the adapter

export interface BostaPickupInput {
  /** YYYY-MM-DD (spec 6). */
  scheduledDate: string;
  numberOfParcels: number;
  contactPerson: { name: string; phone: string; email?: string };
  trackingNumbers?: string[];
}

export interface BostaPickupResult {
  /** Bosta's pickup request id (PUID). */
  pickupId?: string;
  scheduledDate?: string;
  scheduledTimeSlot?: string;
  state?: string;
}

const DUPLICATE_RE = /duplicat|already (exist|used|taken)|must be unique|not unique/i;

export class BostaCarrier implements ShippingCarrierProvider {
  readonly name = 'Bosta';
  readonly code = 'bosta';
  readonly capabilities: CarrierCapabilities = {
    quote: true,
    label: true,
    webhooks: true,
    polling: true,
    cod: true,
  };
  readonly webhookHeader = { name: BOSTA_WEBHOOK_HEADER, valueFor: webhookHeaderValue };

  constructor(private readonly http: CarrierHttpOptions = {}) {}

  private base(ctx?: CarrierCallContext): ResolvedBase {
    const sandbox = ctx?.settings?.sandbox === true || ctx?.settings?.sandbox === 'true';
    return resolveCarrierBaseUrl('BOSTA_BASE_URL', BOSTA_BASE_URLS, sandbox, this.http.baseUrl);
  }

  // Spec 0: the raw key, no "Bearer ".
  private headers(c: BostaCredentials): Record<string, string> {
    if (!c?.apiKey) throw new CarrierError('CARRIER_MISCONFIGURED', 'Bosta apiKey is missing');
    return { Authorization: c.apiKey, 'Content-Type': 'application/json' };
  }

  private call<T = Body>(
    op: string,
    c: BostaCredentials,
    ctx: CarrierCallContext | undefined,
    path: string,
    init: RequestInit = {},
    acceptStatus?: number[]
  ) {
    return carrierRequest<T>(
      op,
      this.base(ctx),
      path,
      { ...init, headers: { ...this.headers(c), ...(init.headers as Record<string, string>) } },
      { ...this.http, acceptStatus }
    );
  }

  /** A call to the public location endpoints (spec 10: no auth). */
  private callPublic<T = Body>(op: string, ctx: CarrierCallContext | undefined, path: string) {
    return carrierRequest<T>(
      op,
      this.base(ctx),
      path,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      this.http
    );
  }

  // ---------------------------------------------------------------- locations (spec 10)

  private async cities(ctx: CarrierCallContext | undefined): Promise<BostaCity[]> {
    const key = this.base(ctx).url;
    const hit = locationCache.get(key);
    if (hit && Date.now() - hit.at < LOCATION_TTL_MS) return hit.cities;
    const res = await this.callPublic<Body>(
      'bosta.cities',
      ctx,
      `/cities?countryId=${EGYPT_COUNTRY_ID}`
    );
    const cities = listOf(res.body, ['list', 'cities']).filter(
      c => c && typeof c._id === 'string' && typeof c.name === 'string'
    ) as BostaCity[];
    if (cities.length === 0) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'bosta.cities: no cities in the response');
    }
    locationCache.set(key, { at: Date.now(), cities, districts: new Map() });
    return cities;
  }

  private async districts(
    ctx: CarrierCallContext | undefined,
    cityId: string
  ): Promise<BostaDistrict[]> {
    await this.cities(ctx); // makes sure the cache entry for this base URL exists
    const entry = locationCache.get(this.base(ctx).url)!;
    const hit = entry.districts.get(cityId);
    if (hit && Date.now() - hit.at < LOCATION_TTL_MS) return hit.list;
    const res = await this.callPublic<Body>(
      'bosta.districts',
      ctx,
      `/cities/${encodeURIComponent(cityId)}/districts`
    );
    const list = listOf(res.body, ['list', 'districts']).filter(
      d => d && typeof d.districtId === 'string' && typeof d.districtName === 'string'
    ) as BostaDistrict[];
    entry.districts.set(cityId, { at: Date.now(), list });
    return list;
  }

  /** What the merchant's own map or the governorate table says this address's city is. */
  private cityHint(
    a: ShipmentAddress,
    ctx: CarrierCallContext | undefined
  ): { override?: string; code?: string; en?: string; ar?: string } {
    const map = (ctx?.settings?.cityMap ?? {}) as Record<string, string>;
    for (const k of [a.state, a.city]) {
      if (k && typeof map[k] === 'string' && map[k]) return { override: map[k] };
    }
    const gov = canonicalGovernorate(a.state) ?? canonicalGovernorate(a.city);
    if (!gov) {
      throw new CarrierError(
        'NEEDS_MAPPING',
        `Bosta: the governorate "${a.state || a.city || ''}" is not recognised; map it in the Bosta settings`
      );
    }
    return { code: GOVERNORATE_TO_BOSTA_CODE[gov.key], en: gov.en, ar: gov.ar };
  }

  private async resolveCity(
    a: ShipmentAddress,
    ctx: CarrierCallContext | undefined,
    hint = this.cityHint(a, ctx)
  ): Promise<Resolved> {
    const cities = await this.cities(ctx);
    let city: BostaCity | null = null;
    if (hint.override) {
      city =
        cities.find(c => c._id === hint.override) ??
        pickByName(cities, c => [c.name, c.nameAr ?? '', c.alias ?? ''], hint.override);
    } else {
      city =
        (hint.code ? cities.find(c => c.code === hint.code) : undefined) ??
        pickByName(cities, c => [c.name, c.nameAr ?? '', c.alias ?? ''], hint.en) ??
        pickByName(cities, c => [c.name, c.nameAr ?? '', c.alias ?? ''], hint.ar) ??
        null;
    }
    if (!city) {
      throw new CarrierError(
        'NEEDS_MAPPING',
        `Bosta: no city matches "${hint.override ?? hint.en}"; map it in the Bosta settings`
      );
    }
    return { city };
  }

  // ---------------------------------------------------------------- idempotency (spec 3b)

  /**
   * The delivery Bosta already holds for this reference, if any.
   * UNVERIFIED: `POST /deliveries/search` is documented with Bearer security only, and its
   * response shape is undocumented, so the body is parsed defensively. A 401/403/404 (the key is
   * not accepted by this endpoint) means "cannot look, assume none": the create below still carries
   * `uniqueBusinessReference`. An OUTAGE or any other refusal propagates: assuming "none" then
   * could book a second parcel.
   */
  private async findByReference(
    c: BostaCredentials,
    ctx: CarrierCallContext | undefined,
    reference: string
  ): Promise<{ id?: string; trackingNumber: string } | null> {
    let res;
    try {
      res = await this.call<Body>(
        'bosta.search',
        c,
        ctx,
        '/deliveries/search',
        { method: 'POST', body: JSON.stringify({ businessReference: reference }) },
        [404]
      );
    } catch (err) {
      if (err instanceof CarrierError && err.code === 'CARRIER_MISCONFIGURED') return null;
      throw err;
    }
    if (res.status === 404) return null;
    const list = listOf(res.body, ['deliveries', 'list', 'results']);
    const hit = list.find(d => d && String(d.businessReference ?? '') === reference);
    if (!hit || hit.trackingNumber === undefined || hit.trackingNumber === null) return null;
    return {
      id: hit._id ? String(hit._id) : undefined,
      trackingNumber: String(hit.trackingNumber),
    };
  }

  private shipmentOf(tracking: string, id?: string): CarrierShipmentResponse {
    return {
      // Spec 3a + 9: lookups and terminate take the TRACKING NUMBER, so that is our shipment id.
      carrierShipmentId: tracking,
      trackingNumber: tracking,
      ...(id ? { carrierTransactionId: id } : {}),
      // UNVERIFIED: the public tracking page URL (not in the official docs).
      trackingUrl: `https://bosta.co/tracking-shipment/?lang=en&shipment_number=${encodeURIComponent(tracking)}`,
    };
  }

  // ---------------------------------------------------------------- create (spec 2)

  async createShipment(
    credentials: BostaCredentials,
    data: CarrierShipmentRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierShipmentResponse> {
    this.headers(credentials); // a missing key is a misconfiguration before anything else
    const reference = data.merchantReference ?? data.orderId;

    // COD: piastres -> EGP number at the edge; refuse over the documented limit before any call.
    const cod = piastresToEgp(data.codAmount ?? 0);
    if (cod > BOSTA_MAX_COD_EGP) {
      throw new CarrierError(
        'CARRIER_REJECTED',
        `Bosta cannot collect more than ${BOSTA_MAX_COD_EGP} EGP cash on delivery (this order: ${cod} EGP)`
      );
    }

    const dest = data.deliveryAddress;
    const hint = this.cityHint(dest, ctx); // NEEDS_MAPPING before any network call
    const firstLine = (dest.line1 ?? '').trim();
    if (firstLine.length <= 5) {
      // Spec 2: firstLine must be longer than 5 characters.
      throw new CarrierError(
        'CARRIER_REJECTED',
        'Bosta needs a street address of more than 5 characters in the first address line'
      );
    }

    const existing = await this.findByReference(credentials, ctx, reference);
    if (existing) return this.shipmentOf(existing.trackingNumber, existing.id);

    const { city } = await this.resolveCity(dest, ctx, hint);
    if (city.dropOffAvailability === false) {
      throw new CarrierError('CARRIER_REJECTED', `Bosta does not deliver to ${city.name}`);
    }
    const district = await this.resolveDistrict(dest, city, ctx);

    const { firstName, lastName } = splitName(dest.name);
    const sizeSetting = String(ctx?.settings?.packageSize ?? 'MEDIUM').toUpperCase();
    const size = ['SMALL', 'MEDIUM', 'LARGE'].includes(sizeSetting) ? sizeSetting : 'MEDIUM';

    const payload: Body = {
      type: 10, // spec 2: 10 = Deliver (SEND)
      // UNVERIFIED: whether decimals are accepted (docs show integers only). A fractional COD is
      // still sent as the exact decimal; the integration test against a real account settles it.
      cod,
      ...(data.notes ? { notes: data.notes } : {}),
      specs: {
        packageType: 'Parcel',
        size,
        packageDetails: {
          itemsCount: data.items.reduce((n, i) => n + i.quantity, 0) || 1,
          description: data.items
            .map(i => i.name)
            .join(', ')
            .slice(0, 200),
        },
      },
      receiver: {
        firstName,
        lastName,
        phone: bostaPhone(dest.phone),
        ...(dest.email ? { email: dest.email } : {}),
      },
      dropOffAddress: {
        city: city.name,
        ...district,
        firstLine,
        ...(dest.line2 ? { secondLine: dest.line2 } : {}),
        ...(dest.building ? { buildingNumber: dest.building } : {}),
        ...(dest.floor ? { floor: dest.floor } : {}),
        ...(dest.apartment ? { apartment: dest.apartment } : {}),
      },
      businessReference: reference,
      uniqueBusinessReference: reference,
      ...(credentials.businessLocationId
        ? { businessLocationId: credentials.businessLocationId }
        : {}),
      ...(ctx?.callbackUrl
        ? {
            webhookUrl: ctx.callbackUrl,
            // Without a secret there is nothing to derive the header from; the service then rejects
            // these callbacks (it requires the header) and tracking falls back to polling.
            ...(credentials.webhookSecret
              ? {
                  webhookCustomHeaders: {
                    [BOSTA_WEBHOOK_HEADER]: webhookHeaderValue(credentials.webhookSecret),
                  },
                }
              : {}),
          }
        : {}),
    };

    let res;
    try {
      res = await this.call<Body>('bosta.create', credentials, ctx, '/deliveries?apiVersion=1', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // UNVERIFIED: the error code / text of a duplicate `uniqueBusinessReference` (docs silent).
      // On a refusal that reads like one, look the reference up once more and reuse the hit.
      if (
        err instanceof CarrierError &&
        err.code === 'CARRIER_REJECTED' &&
        DUPLICATE_RE.test(err.message)
      ) {
        const again = await this.findByReference(credentials, ctx, reference);
        if (again) return this.shipmentOf(again.trackingNumber, again.id);
      }
      throw err;
    }
    if (res.body.success === false) {
      throw new CarrierError(
        'CARRIER_REJECTED',
        `bosta.create: ${String(res.body.message ?? 'refused')}`.slice(0, 220)
      );
    }
    const d: Body = res.body.data ?? {};
    if (!d._id || d.trackingNumber === undefined || d.trackingNumber === null) {
      // The parcel may exist: the retry's reference search will find it rather than book twice.
      throw new CarrierError('CARRIER_UNAVAILABLE', 'bosta.create: no delivery id in the response');
    }
    return this.shipmentOf(String(d.trackingNumber), String(d._id));
  }

  /**
   * Spec 2: city + firstLine, and EITHER `districtId` (+ `zoneId`) OR `districtName` + `cityId`.
   * A merchant `districtMap` entry wins; otherwise the district is matched by name against the
   * city's own list. A name Bosta's list does not know is still sent as `districtName` + `cityId`
   * (Bosta answers 3003 if it cannot resolve it: a refusal, not a wrong parcel); no area at all
   * cannot be mapped, so the merchant is asked.
   */
  private async resolveDistrict(
    dest: ShipmentAddress,
    city: BostaCity,
    ctx: CarrierCallContext | undefined
  ): Promise<Body> {
    const area = (dest.area ?? '').trim();
    const map = (ctx?.settings?.districtMap ?? {}) as Record<string, string>;
    const mapped = area && typeof map[area] === 'string' ? map[area] : undefined;
    if (!area && !mapped) {
      throw new CarrierError(
        'NEEDS_MAPPING',
        'Bosta needs the district (area) of the delivery address; ask the customer or map it in the Bosta settings'
      );
    }
    const list = (await this.districts(ctx, city._id)).filter(d => d.dropOffAvailability !== false);
    const names = (d: BostaDistrict) => [d.districtName, d.districtOtherName ?? ''];

    let hit: BostaDistrict | null = null;
    if (mapped) {
      hit = list.find(d => d.districtId === mapped) ?? pickByName(list, names, mapped);
      if (!hit) return { districtId: mapped }; // the merchant gave an id we cannot cross-check
    } else {
      hit = pickByName(list, names, area);
      if (!hit) {
        // the area may be a ZONE; use it only when the zone has exactly one district
        const zones = [...new Map(list.map(d => [d.zoneId, d])).values()].filter(d => d.zoneId);
        const zone = pickByName(zones, d => [d.zoneName ?? '', d.zoneOtherName ?? ''], area);
        const inZone = zone ? list.filter(d => d.zoneId === zone.zoneId) : [];
        if (inZone.length === 1) hit = inZone[0];
      }
    }
    if (hit) return { districtId: hit.districtId, ...(hit.zoneId ? { zoneId: hit.zoneId } : {}) };
    return { districtName: area, cityId: city._id };
  }

  // ---------------------------------------------------------------- label (spec 4)

  async getLabel(
    credentials: BostaCredentials,
    shipment: { carrierShipmentId: string; trackingNumber: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierLabel> {
    // The single-AWB route is not in the official docs; mass-awb with one tracking number is.
    const res = await this.call<unknown>(
      'bosta.awb',
      credentials,
      ctx,
      '/deliveries/mass-awb',
      {
        method: 'POST',
        body: JSON.stringify({
          trackingNumbers: shipment.trackingNumber,
          requestedAwbType: 'A4',
          lang: 'ar',
        }),
      },
      [200] // the docs say "base64 encoded pdf file": a 200 that is not JSON is the label itself
    );
    // UNVERIFIED: the exact envelope. Either JSON with the base64 in `data`, or the raw base64 text.
    const body = res.body as unknown;
    let candidate: unknown;
    if (typeof body === 'string') candidate = body;
    else if (body && typeof body === 'object' && Object.keys(body).length > 0) {
      candidate = (body as Body).data;
      if (candidate && typeof candidate === 'object') {
        candidate = (candidate as Body).pdf ?? (candidate as Body).awb ?? (candidate as Body).data;
      }
    } else candidate = res.text;
    const b64 = typeof candidate === 'string' ? candidate.trim().replace(/^"|"$/g, '') : '';
    const bytes = b64 && /^[A-Za-z0-9+/=\s]+$/.test(b64) ? Buffer.from(b64, 'base64') : null;
    if (!bytes || bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'bosta.awb: the response is not a PDF label');
    }
    return { pdfBase64: bytes.toString('base64') };
  }

  // ---------------------------------------------------------------- quote (spec 5)

  async quote(
    credentials: BostaCredentials,
    data: CarrierQuoteRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierQuote> {
    this.headers(credentials);
    const [pickup, drop] = [
      this.cityHint(data.pickupAddress, ctx),
      this.cityHint(data.deliveryAddress, ctx),
    ];
    const from = await this.resolveCity(data.pickupAddress, ctx, pickup);
    const to = await this.resolveCity(data.deliveryAddress, ctx, drop);
    const qs = new URLSearchParams({
      pickupCity: from.city.name,
      dropOffCity: to.city.name,
      cod: String(piastresToEgp(data.codAmount ?? 0)),
      type: 'SEND',
      size: 'Normal',
    });
    const res = await this.call<Body>(
      'bosta.quote',
      credentials,
      ctx,
      `/pricing/shipment/calculator?${qs.toString()}`
    );
    // UNVERIFIED: every pricing response body (the docs list status codes only). Parsed defensively;
    // when no positive number is found there is no quote: never a guess.
    const d = res.body.data;
    const fee = [d?.priceAfterVat, d?.price, res.body.priceAfterVat, res.body.price, d]
      .map(numeric)
      .find(n => n !== null && n > 0);
    if (fee === undefined || fee === null) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'bosta.quote: no price in the response');
    }
    return { amountPiastres: Math.round(fee * 100), source: 'api' };
  }

  // ---------------------------------------------------------------- pickup (spec 6)

  /** Not part of the shared interface: ask Bosta to collect parcels from the business location. */
  async requestPickup(
    credentials: BostaCredentials,
    input: BostaPickupInput,
    ctx?: CarrierCallContext
  ): Promise<BostaPickupResult> {
    this.headers(credentials);
    if (!credentials.businessLocationId) {
      throw new CarrierError(
        'CARRIER_MISCONFIGURED',
        'Bosta pickup needs a pickup location id (businessLocationId) in the Bosta settings'
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduledDate)) {
      throw new CarrierError('CARRIER_REJECTED', 'Bosta pickup date must be YYYY-MM-DD');
    }
    const res = await this.call<Body>('bosta.pickup', credentials, ctx, '/pickups', {
      method: 'POST',
      body: JSON.stringify({
        businessLocationId: credentials.businessLocationId,
        scheduledDate: input.scheduledDate,
        numberOfParcels: input.numberOfParcels,
        contactPerson: {
          name: input.contactPerson.name,
          phone: bostaPhone(input.contactPerson.phone),
          ...(input.contactPerson.email ? { email: input.contactPerson.email } : {}),
        },
        ...(input.trackingNumbers?.length ? { trackingNumbers: input.trackingNumbers } : {}),
      }),
    });
    const d: Body = res.body.data ?? {};
    return {
      pickupId: d.puid ? String(d.puid) : d._id ? String(d._id) : undefined,
      scheduledDate: d.scheduledDate,
      scheduledTimeSlot: d.scheduledTimeSlot,
      state: typeof d.state === 'string' ? d.state : undefined,
    };
  }

  // ---------------------------------------------------------------- tracking (spec 3a, 7)

  async trackShipment(
    credentials: BostaCredentials,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierTrackingResponse> {
    const res = await this.call<Body>(
      'bosta.track',
      credentials,
      ctx,
      `/deliveries/business/${encodeURIComponent(trackingNumber)}`
    );
    const d: Body = res.body.data ?? {};
    const type = d.type;
    const dateOf = (v: unknown): Date | null => {
      if (v === undefined || v === null || v === '') return null;
      const dt = new Date(v as string | number);
      return Number.isNaN(dt.getTime()) ? null : dt;
    };

    // UNVERIFIED: the entry shape of `history` (undocumented). Entries are read as `{ state | code,
    // date | timestamp }`; `timeline` (documented: value / done / date) is the fallback, by state name.
    const fromHistory: TrackingHistoryEntry[] = [];
    for (const e of Array.isArray(d.history) ? d.history : []) {
      if (!e || typeof e !== 'object') continue;
      const status = mapBostaState(e.state ?? e.code ?? e.value, type);
      const when = dateOf(e.date ?? e.timestamp ?? e.createdAt);
      if (status && when) {
        fromHistory.push({
          status,
          timestamp: when,
          description: typeof e.state?.value === 'string' ? e.state.value : undefined,
        });
      }
    }
    const fromTimeline: TrackingHistoryEntry[] = [];
    for (const e of Array.isArray(d.timeline) ? d.timeline : []) {
      if (!e || typeof e !== 'object' || e.done === false) continue;
      const status = mapBostaState(e.value, type);
      const when = dateOf(e.date);
      if (status && when) {
        fromTimeline.push({ status, timestamp: when, description: String(e.value) });
      }
    }
    const history = (fromHistory.length ? fromHistory : fromTimeline).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    // The state object is authoritative; without a usable one the newest event decides.
    const current = mapBostaState(d.state, type) ?? history.at(-1)?.status ?? 'created';
    if (history.length === 0) {
      history.push({
        status: current,
        timestamp: dateOf(d.updatedAt) ?? new Date(),
        description: typeof d.state?.value === 'string' ? d.state.value : undefined,
      });
    }
    return { status: current, statusHistory: history };
  }

  // ---------------------------------------------------------------- cancel (spec 9)

  /**
   * `carrierShipmentId` is the TRACKING NUMBER here (see `createShipment`). Needs a FULL-access key.
   * Only a 2xx is ever "cancelled". UNVERIFIED: which states Bosta allows terminate in; a refusal
   * is surfaced as `not_cancellable` with Bosta's message.
   */
  async cancelShipment(
    credentials: BostaCredentials,
    carrierShipmentId: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult> {
    const res = await this.call<Body>(
      'bosta.terminate',
      credentials,
      ctx,
      `/deliveries/business/${encodeURIComponent(carrierShipmentId)}/terminate`,
      { method: 'DELETE' },
      [400, 403, 404, 409, 422]
    );
    if (res.status >= 200 && res.status < 300) return { status: 'cancelled' };
    const b = (res.body ?? {}) as Body;
    if (res.status === 404) return { status: 'failed', message: 'not found at Bosta' };
    if (res.status === 403 && b.errorCode === 1008) {
      return {
        status: 'not_cancellable',
        message:
          'Bosta refused: the API key needs Full access (not Read/Write) to cancel a delivery',
      };
    }
    return {
      status: 'not_cancellable',
      message: typeof b.message === 'string' ? b.message.slice(0, 200) : undefined,
    };
  }

  // ---------------------------------------------------------------- webhook (spec 8)

  /**
   * Payload (spec 8): `{ _id, trackingNumber (String or Number), state: Number, type, cod (only on
   * 45), timeStamp: epoch ms, isConfirmedDelivery, exceptionReason / exceptionCode (only on 47),
   * businessReference, numberOfAttempts }`. Not authenticated here: the service checks the URL
   * token and `webhookHeader`. An unknown state is ignored rather than guessed.
   */
  processWebhook(body: unknown, _headers: Record<string, string>): CarrierWebhookResult | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const p = body as Body;
    const tn = p.trackingNumber;
    if (tn === undefined || tn === null || tn === '' || typeof tn === 'object') return null;
    const status = mapBostaState(p.state, p.type);
    if (!status) return null;
    const ts = numeric(p.timeStamp);
    const when = ts !== null ? new Date(ts) : new Date();
    return {
      trackingNumber: String(tn),
      status,
      timestamp: Number.isNaN(when.getTime()) ? new Date() : when,
      description:
        p.state === 47 || p.state === '47'
          ? typeof p.exceptionReason === 'string' && p.exceptionReason
            ? p.exceptionReason
            : undefined
          : undefined,
    };
  }

  // ---------------------------------------------------------------- test connection (spec 1)

  async testConnection(
    credentials: BostaCredentials,
    ctx?: CarrierCallContext
  ): Promise<CarrierTestResult> {
    try {
      const res = await this.call<Body>('bosta.test', credentials, ctx, '/pickup-locations');
      const wanted = credentials.businessLocationId;
      const list = res.body?.data?.list;
      if (wanted && Array.isArray(list) && !list.some((l: Body) => l?._id === wanted)) {
        const known = list
          .map((l: Body) => String(l?._id ?? ''))
          .filter(Boolean)
          .slice(0, 5)
          .join(', ');
        return {
          success: false,
          code: 'unknown',
          error: `Bosta does not know the pickup location "${wanted}". Known: ${known || 'none'}`,
        };
      }
      return { success: true };
    } catch (err) {
      if (err instanceof CarrierError) {
        if (err.code === 'CARRIER_MISCONFIGURED') {
          return { success: false, code: 'bad_credentials', error: 'Bosta refused the API key' };
        }
        if (err.code === 'CARRIER_UNAVAILABLE') {
          return { success: false, code: 'unreachable', error: 'Bosta could not be reached' };
        }
      }
      return { success: false, code: 'unknown', error: 'Bosta answered unexpectedly' };
    }
  }
}

export const bostaCarrier = new BostaCarrier();
