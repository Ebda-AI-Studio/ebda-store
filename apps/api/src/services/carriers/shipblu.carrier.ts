// ==========================================
// ShipBlu Carrier Implementation (shipping batch)
// ==========================================
//
// ShipBlu REST (Django REST style), per-merchant API key. Sources (official only): docs.shipblu.com
// (quick-start, tutorial, js-client) and the Swagger 2.0 spec at api.shipblu.com/docs/?format=openapi
// (and the staging twin). Anything those do not state is marked `UNVERIFIED:`; the adapter behaves
// safely around it (never guesses an endpoint). No staging key has been available, so the adapter is
// contract-tested against a local stub (tests/stubs/shipblu-stub.ts) built from the documented shapes.
//
//  - Auth: `Authorization: Api-Key <key>`. A bad key answers HTTP 403 `{"detail":...}` (not 401).
//  - COD: `cash_amount` (number), converted from integer piastres at this edge.
//  - Webhooks: none documented anywhere -> polling only.
//  - Cancel: no endpoint documented -> `not_cancellable`, no network call.
//  - Idempotency: no header. `merchant_order_reference` carries our reference; before creating we
//    look it up (`GET /v1/delivery-orders/?merchant_order_reference=`) and reuse an exact match.
//  - Address: ShipBlu wants a ZONE id. It is resolved governorates -> cities -> zones by name
//    (egypt-areas.ts), or from the merchant's `zoneMap` override; no match = NEEDS_MAPPING.

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
  carrierRequestBinary,
  egpToPiastres,
  piastresToEgp,
  resolveCarrierBaseUrl,
  type CarrierHttpOptions,
} from '../../lib/carrier-http';
import { canonicalGovernorate, normalizeName, pickByName } from './egypt-areas';

export const SHIPBLU_BASE_URLS = {
  live: 'https://api.shipblu.com/api',
  sandbox: 'https://api.staging.shipblu.com/api',
};

export interface ShipbluCredentials {
  apiKey: string;
  /** Not used: ShipBlu documents no webhooks. Kept so the flat credential map can carry it. */
  webhookSecret?: string;
}

/**
 * The 32-value order status enum from the official OpenAPI (identical on prod and staging).
 * Meanings come from docs.shipblu.com/tutorial where it defines them; the rest are UNVERIFIED
 * (enum name only), which is why every mapping below is conservative.
 */
export const SHIPBLU_STATUS_MAP: Record<string, ShipmentStatus> = {
  created: 'created',
  pickup_requested: 'created',
  pickup_rescheduled: 'created',
  out_for_pickup: 'created', // UNVERIFIED meaning (name only): the courier is heading to the merchant
  picked_up: 'picked_up',
  in_transit: 'in_transit', // "order is in the warehouse"
  en_route: 'in_transit', // "moving from one warehouse to another"
  delivery_attempted: 'in_transit', // agent tried and failed: still with ShipBlu
  reattempt_delivery: 'in_transit', // UNVERIFIED meaning (name only)
  on_hold: 'in_transit', // UNVERIFIED meaning (name only)
  release_hold: 'in_transit', // UNVERIFIED meaning (name only)
  ops_delay: 'in_transit', // UNVERIFIED meaning (name only)
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  // the way back to the merchant: no "returning" status in the shared set, so the parcel is moving
  return_to_origin: 'in_transit', // automatic when the customer refused / out of zone
  returned_to_origin: 'in_transit', // UNVERIFIED meaning (name only)
  out_for_return: 'in_transit', // merchant's agent has it, returning today
  return_requested: 'in_transit',
  return_attempted: 'in_transit',
  return_postponed: 'in_transit',
  return_refused: 'in_transit', // merchant refused the returned order: still not delivered back
  returned: 'returned',
  cancelled: 'cancelled',
  lost: 'failed', // UNVERIFIED meaning (name only)
  damaged: 'failed', // UNVERIFIED meaning (name only)
};

/**
 * Statuses deliberately NOT mapped (never guessed): COD ledger events and the exchange flow, which
 * say nothing about where the parcel is. An event carrying one is skipped, not forced into a state.
 */
export const SHIPBLU_IGNORED_STATUSES: readonly string[] = [
  'cod_change', // UNVERIFIED (name only)
  'cod_deposited', // UNVERIFIED (name only): COD paid out, not a movement
  'forfeited', // UNVERIFIED (name only)
  'exchange_requested',
  'out_for_exchange',
  'exchange_attempted',
  'exchanged',
];

/** Normalize a ShipBlu status string (the API enum is lowercase, the docs print UPPERCASE) or null. */
export function mapShipbluStatus(status: unknown): ShipmentStatus | null {
  if (typeof status !== 'string') return null;
  return SHIPBLU_STATUS_MAP[status.trim().toLowerCase()] ?? null;
}

type Body = Record<string, any>;
type Named = { id: number; name: string };

const GEO_TTL_MS = 6 * 3_600_000;
const GEO_MAX_ACCOUNTS = 100;
const CITY_SCAN_CAP = 40;

interface GeoCache {
  at: number;
  governorates?: Named[];
  cities: Map<number, Named[]>;
  zones: Map<number, Named[]>;
}

/** A bare array (as documented for the location lists) or a `{ results: [...] }` page. */
function listOf(body: unknown): Body[] {
  if (Array.isArray(body)) return body;
  const r = (body as Body | undefined)?.results;
  return Array.isArray(r) ? r : [];
}

const asNamed = (rows: Body[]): Named[] =>
  rows
    .filter(r => Number.isInteger(Number(r?.id)) && typeof r?.name === 'string')
    .map(r => ({ id: Number(r.id), name: String(r.name) }));

export class ShipbluCarrier implements ShippingCarrierProvider {
  readonly name = 'ShipBlu';
  readonly code = 'shipblu';
  readonly capabilities: CarrierCapabilities = {
    quote: true,
    label: true,
    webhooks: false, // ShipBlu documents no webhooks / callbacks anywhere
    polling: true,
    cod: true,
    // Booking requests the pickup itself (autoPickup below); the endpoint takes no date/window.
    pickup: 'automatic',
    pickupWindow: 'none',
    pickupCancel: false,
  };

  /**
   * Governorate / city / zone lists, per account. Keyed by a HASH of (base URL + API key), never
   * global: a merchant's key can see a different location set than another's, and a sandbox key is
   * a different world from a live one. Geography is BOUNDED-stale (6h TTL, bounded size).
   */
  private readonly geo = new Map<string, GeoCache>();

  constructor(private readonly http: CarrierHttpOptions = {}) {}

  private base(ctx?: CarrierCallContext) {
    const sandbox = ctx?.settings?.sandbox === true || ctx?.settings?.sandbox === 'true';
    return resolveCarrierBaseUrl('SHIPBLU_BASE_URL', SHIPBLU_BASE_URLS, sandbox, this.http.baseUrl);
  }

  private headers(c: ShipbluCredentials): Record<string, string> {
    const key = typeof c?.apiKey === 'string' ? c.apiKey.trim() : '';
    if (!key) throw new CarrierError('CARRIER_MISCONFIGURED', 'ShipBlu apiKey is missing');
    return { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' };
  }

  private call<T = Body>(
    op: string,
    c: ShipbluCredentials,
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

  // ---- location resolution (governorate -> city -> zone) ----

  private geoFor(c: ShipbluCredentials, ctx?: CarrierCallContext): GeoCache {
    const id = crypto
      .createHash('sha256')
      .update(`${this.base(ctx).url}\n${c.apiKey}`)
      .digest('hex');
    const hit = this.geo.get(id);
    if (hit && Date.now() - hit.at < GEO_TTL_MS) return hit;
    const fresh: GeoCache = { at: Date.now(), cities: new Map(), zones: new Map() };
    this.geo.delete(id);
    if (this.geo.size >= GEO_MAX_ACCOUNTS) {
      const oldest = this.geo.keys().next().value;
      if (oldest !== undefined) this.geo.delete(oldest);
    }
    this.geo.set(id, fresh);
    return fresh;
  }

  private async governorates(c: ShipbluCredentials, ctx?: CarrierCallContext): Promise<Named[]> {
    const g = this.geoFor(c, ctx);
    if (!g.governorates) {
      const res = await this.call<unknown>('shipblu.governorates', c, ctx, '/v1/governorates/');
      g.governorates = asNamed(listOf(res.body));
    }
    return g.governorates;
  }

  private async cities(
    c: ShipbluCredentials,
    ctx: CarrierCallContext | undefined,
    governorateId: number
  ): Promise<Named[]> {
    const g = this.geoFor(c, ctx);
    let list = g.cities.get(governorateId);
    if (!list) {
      const res = await this.call<unknown>(
        'shipblu.cities',
        c,
        ctx,
        `/v1/governorates/${governorateId}/cities/`
      );
      list = asNamed(listOf(res.body));
      g.cities.set(governorateId, list);
    }
    return list;
  }

  private async zones(
    c: ShipbluCredentials,
    ctx: CarrierCallContext | undefined,
    cityId: number
  ): Promise<Named[]> {
    const g = this.geoFor(c, ctx);
    let list = g.zones.get(cityId);
    if (!list) {
      const res = await this.call<unknown>('shipblu.zones', c, ctx, `/v1/cities/${cityId}/zones/`);
      list = asNamed(listOf(res.body));
      g.zones.set(cityId, list);
    }
    return list;
  }

  /** The governorate id for an address (also what pricing needs), or null when it cannot be matched. */
  private async resolveGovernorate(
    c: ShipbluCredentials,
    ctx: CarrierCallContext | undefined,
    a: ShipmentAddress
  ): Promise<Named | null> {
    const canon = canonicalGovernorate(a.state) ?? canonicalGovernorate(a.city);
    const query = canon?.en ?? a.state ?? a.city;
    if (!query) return null;
    return pickByName(await this.governorates(c, ctx), g => [g.name], query);
  }

  private async resolveZone(
    c: ShipbluCredentials,
    ctx: CarrierCallContext | undefined,
    a: ShipmentAddress
  ): Promise<number> {
    // the merchant's own mapping wins: { "<area / city / governorate name>": zoneId }
    const override = ctx?.settings?.zoneMap;
    if (override && typeof override === 'object') {
      const folded = new Map(
        Object.entries(override as Record<string, unknown>).map(([k, v]) => [normalizeName(k), v])
      );
      for (const name of [a.area, a.city, a.state]) {
        const v = name ? folded.get(normalizeName(name)) : undefined;
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
      }
    }
    const placeNames = [a.area, a.city].filter((s): s is string => !!s?.trim());
    const gov = await this.resolveGovernorate(c, ctx, a);
    if (gov && placeNames.length) {
      const cities = await this.cities(c, ctx, gov.id);
      const pickZone = async (cityId: number): Promise<number | null> => {
        const zones = await this.zones(c, ctx, cityId);
        for (const n of placeNames) {
          const z = pickByName(zones, x => [x.name], n);
          if (z) return z.id;
        }
        return null; // a lone zone is still a guess: ask the merchant instead
      };
      for (const n of placeNames) {
        const city = pickByName(cities, x => [x.name], n);
        if (city) {
          const zone = await pickZone(city.id);
          if (zone !== null) return zone;
        }
      }
      // no city matched by name: the district may be a zone under a differently named city
      if (cities.length <= CITY_SCAN_CAP) {
        const found = new Set<number>();
        for (const city of cities) {
          // the district only: matching the city/governorate name against zone names would
          // put a "Cairo" address into whichever zone happens to contain the word
          if (!a.area?.trim()) break;
          const z = pickByName(await this.zones(c, ctx, city.id), x => [x.name], a.area);
          if (z) found.add(z.id);
        }
        if (found.size === 1) return [...found][0];
      }
    }
    throw new CarrierError(
      'NEEDS_MAPPING',
      'The delivery address could not be matched to a ShipBlu zone: set a zone mapping for it in the carrier settings'
    );
  }

  private packageSize(ctx?: CarrierCallContext): number {
    const raw = ctx?.settings?.packageSize;
    if (raw === undefined || raw === null || raw === '') return 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      throw new CarrierError('CARRIER_REJECTED', 'ShipBlu packageSize must be 1, 2, 3 or 4');
    }
    return n;
  }

  // ---- shipments ----

  /** The order we already booked for this reference, if any (exact match; the filter's own matching is UNVERIFIED). */
  private async findByReference(
    c: ShipbluCredentials,
    ctx: CarrierCallContext | undefined,
    reference: string
  ): Promise<{ id: string; trackingNumber?: string } | null> {
    const res = await this.call<Body>(
      'shipblu.lookup',
      c,
      ctx,
      `/v1/delivery-orders/?merchant_order_reference=${encodeURIComponent(reference)}`
    );
    const hit = listOf(res.body).find(o => o.merchant_order_reference === reference);
    if (!hit) return null;
    return {
      id: String(hit.id),
      trackingNumber: hit.tracking_number ? String(hit.tracking_number) : undefined,
    };
  }

  private async fetchTracking(
    c: ShipbluCredentials,
    ctx: CarrierCallContext | undefined,
    id: string
  ): Promise<string> {
    const res = await this.call<Body>(
      'shipblu.order',
      c,
      ctx,
      `/v1/delivery-orders/${encodeURIComponent(id)}/`
    );
    if (!res.body.tracking_number) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'shipblu.order: no tracking number yet');
    }
    return String(res.body.tracking_number);
  }

  async createShipment(
    credentials: ShipbluCredentials,
    data: CarrierShipmentRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierShipmentResponse> {
    const reference = data.merchantReference ?? data.orderId;
    const cod = data.codAmount ?? 0;
    if (!Number.isSafeInteger(cod) || cod < 0) {
      throw new CarrierError('CARRIER_REJECTED', 'codAmount must be integer piastres');
    }
    const size = this.packageSize(ctx);

    const existing = await this.findByReference(credentials, ctx, reference);
    if (existing) {
      const trackingNumber =
        existing.trackingNumber ?? (await this.fetchTracking(credentials, ctx, existing.id));
      return {
        carrierShipmentId: existing.id,
        trackingNumber,
        ...(await this.autoPickup(credentials, trackingNumber, ctx)),
      };
    }

    const dest = data.deliveryAddress;
    const zone = await this.resolveZone(credentials, ctx, dest);
    const description = data.items
      .map(i => i.name)
      .join(', ')
      .slice(0, 200);
    // Body fields per the OpenAPI + the tutorial's minimum. UNVERIFIED: `address.what3words` is
    // marked required by the OpenAPI but absent from the tutorial's minimum call; it is not sent.
    const payload: Body = {
      customer: {
        full_name: dest.name,
        ...(dest.email ? { email: dest.email } : {}),
        phone: dest.phone.replace(/\s+/g, ''),
        address: {
          line_1: dest.line1,
          line_2: dest.line2 || dest.area || dest.city,
          zone,
        },
      },
      packages: [{ package_size: size, ...(description ? { description } : {}) }],
      // UNVERIFIED: the unit of `cash_amount` (no page states it; EGP pounds is assumed for an
      // Egyptian carrier). Prepaid omits the field (the tutorial's minimum has none).
      ...(cod > 0 ? { cash_amount: piastresToEgp(cod) } : {}),
      merchant_order_reference: reference,
      ...(data.notes ? { order_notes: data.notes } : {}),
    };

    const res = await this.call<Body>('shipblu.create', credentials, ctx, '/v1/delivery-orders/', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const id = res.body.id;
    if (id === undefined || id === null) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'shipblu.create: no order id in the response');
    }
    // UNVERIFIED: the 201 may not echo `tracking_number` (the OpenAPI's create schema omits it);
    // re-read the order by id in that case. A failure there is retryable and safe: the retry
    // finds the order by its reference instead of booking a second one.
    const trackingNumber = res.body.tracking_number
      ? String(res.body.tracking_number)
      : await this.fetchTracking(credentials, ctx, String(id));
    return {
      carrierShipmentId: String(id),
      trackingNumber,
      ...(await this.autoPickup(credentials, trackingNumber, ctx)),
    };
  }

  /**
   * ShipBlu keeps an order `created` until a pickup is requested (docs.shipblu.com, statuses), so
   * booking asks for it unless the merchant turned `settings.autoRequestPickup` off. BEST EFFORT:
   * the parcel is already booked, so a refusal or an outage must not fail (and so re-book) the
   * order; it is reported as a warning the service stores on the shipment, never swallowed.
   */
  private async autoPickup(
    credentials: ShipbluCredentials,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<{ warning?: string }> {
    if (ctx?.settings?.autoRequestPickup === false) return {};
    try {
      await this.requestPickup(credentials, [trackingNumber], ctx);
      return {};
    } catch {
      return {
        warning:
          'Booked, but ShipBlu did not accept the pickup request: request the pickup in your ShipBlu dashboard',
      };
    }
  }

  async getLabel(
    credentials: ShipbluCredentials,
    shipment: { carrierShipmentId: string; trackingNumber: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierLabel> {
    // The OpenAPI lists this path with no params and an empty schema; the tutorial says the answer
    // is the PDF itself. UNVERIFIED: its content-type, so the bytes are checked, not the header.
    const res = await carrierRequestBinary(
      'shipblu.label',
      this.base(ctx),
      `/v1/delivery-orders/${encodeURIComponent(shipment.carrierShipmentId)}/shipping-label/`,
      { method: 'GET', headers: { ...this.headers(credentials), Accept: 'application/pdf' } },
      this.http
    );
    if (res.bytes.length < 5 || res.bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'shipblu.label: the answer is not a PDF');
    }
    return { pdfBase64: res.bytes.toString('base64') };
  }

  async quote(
    credentials: ShipbluCredentials,
    data: CarrierQuoteRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierQuote> {
    const cod = data.codAmount ?? 0;
    if (!Number.isSafeInteger(cod) || cod < 0) {
      throw new CarrierError('CARRIER_REJECTED', 'codAmount must be integer piastres');
    }
    const gov = await this.resolveGovernorate(credentials, ctx, data.deliveryAddress);
    if (!gov) {
      throw new CarrierError(
        'NEEDS_MAPPING',
        'The delivery governorate could not be matched to a ShipBlu governorate'
      );
    }
    const res = await this.call<Body>(
      'shipblu.quote',
      credentials,
      ctx,
      '/v1/pricing/orders/delivery/',
      {
        method: 'POST',
        body: JSON.stringify({
          to_governorate: gov.id,
          cash_amount: piastresToEgp(cod),
          packages: [this.packageSize(ctx)],
        }),
      }
    );
    const total = res.body.total;
    if (typeof total !== 'number' && typeof total !== 'string') {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'shipblu.quote: no total in the response');
    }
    // UNVERIFIED: currency/unit of `total` (the OpenAPI does not state it); EGP pounds is assumed.
    return { amountPiastres: egpToPiastres(total), source: 'api' };
  }

  /**
   * Ask ShipBlu to collect the given orders (they stay `created` until this is called). Not part of
   * the shared interface. UNVERIFIED: which pickup point / date is used (the endpoint takes neither).
   */
  async requestPickup(
    credentials: ShipbluCredentials,
    trackingNumbers: string[],
    ctx?: CarrierCallContext
  ): Promise<{ requested: number }> {
    const numbers = trackingNumbers.map(t => String(t).trim()).filter(Boolean);
    if (numbers.length === 0) {
      throw new CarrierError(
        'CARRIER_REJECTED',
        'requestPickup needs at least one tracking number'
      );
    }
    const res = await this.call<unknown>(
      'shipblu.pickup',
      credentials,
      ctx,
      `/v1/delivery-orders/request-pickup/?tracking_numbers=${numbers.map(encodeURIComponent).join(',')}`,
      { method: 'POST' }
    );
    return { requested: Array.isArray(res.body) ? res.body.length : 0 };
  }

  async trackShipment(
    credentials: ShipbluCredentials,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierTrackingResponse> {
    const res = await this.call<Body>(
      'shipblu.track',
      credentials,
      ctx,
      `/v1/delivery-orders/?tracking_number=${encodeURIComponent(trackingNumber)}`
    );
    const order = listOf(res.body).find(o => String(o.tracking_number) === trackingNumber);
    if (!order) throw new CarrierError('CARRIER_REJECTED', 'shipblu.track: shipment not found');

    const events: Body[] = Array.isArray(order.tracking_events) ? order.tracking_events : [];
    const history: TrackingHistoryEntry[] = [];
    for (const e of events) {
      const status = mapShipbluStatus(e.status);
      if (!status) continue; // unknown or deliberately ignored: skipped, never guessed
      const at = new Date(e.created ?? e.modified ?? Number.NaN);
      if (Number.isNaN(at.getTime())) continue;
      history.push({
        status,
        timestamp: at,
        location: e.current_warehouse?.name ?? undefined,
        description: typeof e.comment === 'string' && e.comment ? e.comment : undefined,
      });
    }
    history.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const current = history.at(-1)?.status ?? mapShipbluStatus(order.status) ?? 'created';
    return { status: current, statusHistory: history };
  }

  async cancelShipment(
    _credentials: ShipbluCredentials,
    _carrierShipmentId: string,
    _ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult> {
    // UNVERIFIED: the official OpenAPI has no cancel endpoint (only GET/POST on delivery orders) and
    // the docs only say a merchant can cancel a `created` order. Nothing is called: guessing a
    // PATCH/DELETE could mutate a live parcel.
    return {
      status: 'not_cancellable',
      message:
        'ShipBlu has no documented cancel API: cancel the order in your ShipBlu dashboard, then force-cancel here',
    };
  }

  /** ShipBlu documents no webhooks / callbacks (UNVERIFIED that none exist): tracking is polled. */
  processWebhook(_body: unknown, _headers: Record<string, string>): CarrierWebhookResult | null {
    return null;
  }

  async testConnection(
    credentials: ShipbluCredentials,
    ctx?: CarrierCallContext
  ): Promise<CarrierTestResult> {
    try {
      // `/v1/merchants/` is the quick-start's key test but is NOT in the OpenAPI (UNVERIFIED);
      // if it is absent (404) fall back to the spec'd read-only governorate list.
      const res = await this.call('shipblu.test', credentials, ctx, '/v1/merchants/', {}, [404]);
      if (res.status === 404) {
        await this.call('shipblu.test', credentials, ctx, '/v1/governorates/');
      }
      return { success: true };
    } catch (err) {
      if (err instanceof CarrierError) {
        if (err.code === 'CARRIER_MISCONFIGURED') {
          return { success: false, code: 'bad_credentials', error: 'ShipBlu refused the API key' };
        }
        if (err.code === 'CARRIER_UNAVAILABLE') {
          return { success: false, code: 'unreachable', error: 'ShipBlu could not be reached' };
        }
      }
      return { success: false, code: 'unknown', error: 'ShipBlu connection test failed' };
    }
  }
}

export const shipbluCarrier = new ShipbluCarrier();
