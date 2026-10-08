// ==========================================
// Mylerz Carrier Implementation (shipping batch)
// ==========================================
//
// Mylerz merchant Integration API (Egypt). Sources, in order of authority:
//   S1 = official Swagger JSON https://integration.mylerz.net/swagger/docs/v1 (shapes only: no
//        descriptions, no examples, no status table);
//   S2 = unauthenticated live probes of integration.mylerz.net (token error shape, 401 shape);
//   S3 = Mylerz API v1.3.1 PDF (official content, third-party host: SlideShare).
// Anything those sources do not state is marked `UNVERIFIED:` and the adapter behaves safely
// (refuses or ignores) instead of guessing.
//
//  - Auth: POST /token (form: grant_type=password, username, password) -> bearer token (S1, S2, S3).
//    Tokens are cached in memory per credential hash and re-issued once on a 401.
//  - Envelope: every /api/* call answers HTTP 200 {Value, IsErrorState, ErrorDescription} (S1).
//    IsErrorState=true is a refusal (CARRIER_REJECTED); per-package ErrorCode/ErrorMessage too.
//  - NO SANDBOX: Mylerz publishes none. integration.mylerz.net is LIVE. Sandbox mode resolves
//    only the MYLERZ_BASE_URL env host (honoured outside production); with none set, every call
//    refuses instead of silently booking real parcels.
//  - COD: `COD_Value` in EGP as a decimal number, converted from integer piastres at the edge.
//    UNVERIFIED: S1/S3 never state the currency or unit (EGP assumed from the Egypt host).
//  - Idempotency: Mylerz documents no duplicate-`Reference` behaviour. Before AddOrders we look
//    the reference up (TrackPackages accepts a ReferenceNumber) and reuse an existing barcode,
//    and a per-process IdempotencyCache keyed by credential hash + reference collapses retries.
//  - Webhooks: S1 has POST /api/Merchant (EnableWebhookDTO) but payload, auth and statuses are
//    UNDOCUMENTED, so webhooks=false and processWebhook ignores everything; tracking is polled.

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
  ShipmentStatus,
  ShippingCarrierProvider,
  TrackingHistoryEntry,
  type CarrierPickupRequest,
  type CarrierPickupResult,
  type CarrierPickupWindow,
} from './types';
import {
  carrierRequest,
  piastresToEgp,
  resolveCarrierBaseUrl,
  type CarrierHttpOptions,
  type ResolvedBase,
} from '../../lib/carrier-http';
import { IdempotencyCache } from '../payment-providers/gateway-http';
import { canonicalGovernorate, normalizeName, pickByName } from './egypt-areas';

export const MYLERZ_BASE_URLS = {
  // Mylerz publishes no sandbox. Empty = "no host": sandbox mode refuses unless MYLERZ_BASE_URL is set.
  sandbox: '',
  live: 'https://integration.mylerz.net',
};

export const MYLERZ_NO_SANDBOX_MESSAGE =
  'Mylerz has no public sandbox: ask Mylerz for a staging host';

export interface MylerzCredentials {
  username: string;
  password: string;
  /** The Mylerz warehouse (pickup location) name; AddOrders.WarehouseName must match it. */
  warehouseName: string;
  /** Unused today (no Mylerz webhook is documented); kept so the stored shape is uniform. */
  webhookSecret?: string;
}

/**
 * UNVERIFIED: Mylerz publishes NO status table (S1 has only field shapes; the single official
 * status string seen is "Not Picked Yet", S3). Keys are lower-cased `StatusEnName` / `StatusCode`
 * values; the English names below are plain-language guesses of what a real TrackLog will say.
 * A status that is not here is NOT guessed: it is kept out of the history. Complete this single
 * table once real TrackLog values are captured from a live account.
 */
export const MYLERZ_STATUS_MAP: Record<string, ShipmentStatus> = {
  'not picked yet': 'created', // documented (S3)
  'picked up': 'picked_up',
  'in transit': 'in_transit',
  'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
  returned: 'returned',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

/** A Mylerz status string to a ShipmentStatus, or null (unknown: never guessed). */
export function mapMylerzStatus(name: unknown): ShipmentStatus | null {
  if (typeof name !== 'string') return null;
  return MYLERZ_STATUS_MAP[name.trim().toLowerCase()] ?? null;
}

type Body = Record<string, any>;

interface ZoneChoice {
  city: string;
  neighborhood: string;
  /** The Mylerz zone `Code` (rate quote); absent for a merchant override that gave none. */
  zoneCode?: string;
}

const TOKEN_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_S = 3600;
const ZONES_TTL_MS = 3_600_000;
const MAX_CACHE = 500;

const truncate = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);
const isSandbox = (ctx?: CarrierCallContext) =>
  ctx?.settings?.sandbox === true || ctx?.settings?.sandbox === 'true';

function cap<K, V>(m: Map<K, V>) {
  if (m.size > MAX_CACHE) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

export class MylerzCarrier implements ShippingCarrierProvider {
  readonly name = 'Mylerz';
  readonly code = 'mylerz';
  readonly capabilities: CarrierCapabilities = {
    quote: true,
    label: true,
    // Webhook payload/auth are undocumented (see the header): polling only.
    webhooks: false,
    polling: true,
    cod: true,
    // PickupOrder/CreatePickupOrder with a slot from Lookup/GetAllPickupTimeWindow.
    pickup: 'request',
    pickupWindow: 'carrier_slots',
    // The spec has no pickup-cancel operation (only packages/CancelPackage).
    pickupCancel: false,
  };

  // Keyed by sha256(username + password + host): never the raw credentials, never shared
  // between two merchants.
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly logins = new Map<string, Promise<string>>();
  private readonly zones = new Map<string, { at: number; list: Body[] }>();
  private readonly created = new IdempotencyCache<CarrierShipmentResponse>();

  constructor(private readonly http: CarrierHttpOptions = {}) {}

  // ---- plumbing -------------------------------------------------------------------------

  private base(ctx?: CarrierCallContext): ResolvedBase {
    const sandbox = isSandbox(ctx);
    const base = resolveCarrierBaseUrl(
      'MYLERZ_BASE_URL',
      MYLERZ_BASE_URLS,
      sandbox,
      this.http.baseUrl
    );
    if (sandbox && !base.stubbed) {
      throw new CarrierError('CARRIER_MISCONFIGURED', MYLERZ_NO_SANDBOX_MESSAGE);
    }
    return base;
  }

  private creds(c: MylerzCredentials): MylerzCredentials {
    for (const k of ['username', 'password', 'warehouseName'] as const) {
      if (!c || typeof c[k] !== 'string' || !c[k].trim()) {
        throw new CarrierError('CARRIER_MISCONFIGURED', `Mylerz ${k} is missing`);
      }
    }
    return c;
  }

  private key(c: MylerzCredentials, host: string): string {
    return crypto
      .createHash('sha256')
      .update(`${c.username}\0${c.password}\0${host}`)
      .digest('hex');
  }

  /** Remove every secret we hold from a string headed for a message. */
  private scrub(s: string, secrets: Array<string | undefined>): string {
    let out = s;
    for (const x of secrets) if (x && x.length >= 3) out = out.split(x).join('***');
    return out;
  }

  private async login(
    c: MylerzCredentials,
    base: ResolvedBase,
    key: string,
    force: boolean
  ): Promise<string> {
    const hit = this.tokens.get(key);
    if (!force && hit && hit.expiresAt > Date.now()) return hit.token;
    const inflight = this.logins.get(key);
    if (inflight) return inflight;
    const run = (async () => {
      const body = new URLSearchParams({
        grant_type: 'password',
        username: c.username,
        password: c.password,
      }).toString();
      let res;
      try {
        res = await carrierRequest<Body>(
          'mylerz.token',
          base,
          '/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          },
          { ...this.http, acceptStatus: [400, 401] }
        );
      } catch (err) {
        if (err instanceof CarrierError) {
          throw new CarrierError(err.code, this.scrub(err.message, [c.username, c.password]));
        }
        throw err;
      }
      if (res.status === 400 || res.status === 401) {
        const e = res.body?.error;
        // S2: bad credentials answer 400 {"error":"invalid_grant"}.
        if (res.status === 401 || e === 'invalid_grant') {
          throw new CarrierError(
            'CARRIER_MISCONFIGURED',
            'Mylerz refused the username or password'
          );
        }
        throw new CarrierError(
          'CARRIER_REJECTED',
          `mylerz.token: carrier HTTP 400${typeof e === 'string' ? `: ${truncate(this.scrub(e, [c.username, c.password]), 60)}` : ''}`
        );
      }
      const token = res.body?.access_token;
      if (typeof token !== 'string' || !token) {
        throw new CarrierError(
          'CARRIER_UNAVAILABLE',
          'mylerz.token: no access_token in the response'
        );
      }
      const exp = Number(res.body.expires_in);
      const ttl = Number.isFinite(exp) && exp > 0 ? exp : DEFAULT_TOKEN_TTL_S;
      this.tokens.set(key, { token, expiresAt: Date.now() + ttl * 1000 - TOKEN_SKEW_MS });
      cap(this.tokens);
      return token;
    })();
    this.logins.set(key, run);
    try {
      return await run;
    } finally {
      this.logins.delete(key);
    }
  }

  /**
   * One authenticated /api call. A 401 re-logs in ONCE and retries; the envelope's
   * IsErrorState is a refusal. Returns the envelope's `Value`.
   */
  private async api<T = any>(
    op: string,
    c: MylerzCredentials,
    ctx: CarrierCallContext | undefined,
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    this.creds(c);
    const base = this.base(ctx);
    const key = this.key(c, base.url);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.login(c, base, key, attempt === 1);
      const secrets = [c.username, c.password, token];
      let res;
      try {
        res = await carrierRequest<Body>(
          op,
          base,
          path,
          {
            ...init,
            headers: {
              ...(init.body ? { 'Content-Type': 'application/json' } : {}),
              Authorization: `Bearer ${token}`,
            },
          },
          { ...this.http, acceptStatus: [401] }
        );
      } catch (err) {
        if (err instanceof CarrierError)
          throw new CarrierError(err.code, this.scrub(err.message, secrets));
        throw err;
      }
      if (res.status === 401) {
        this.tokens.delete(key);
        if (attempt === 1) {
          throw new CarrierError(
            'CARRIER_MISCONFIGURED',
            `${op}: Mylerz refused the merchant credentials`
          );
        }
        continue;
      }
      const env = res.body;
      if (!env || typeof env !== 'object' || Array.isArray(env)) {
        throw new CarrierError(
          'CARRIER_UNAVAILABLE',
          `${op}: carrier answered with an unexpected body`
        );
      }
      if (env.IsErrorState === true) {
        const d = typeof env.ErrorDescription === 'string' && env.ErrorDescription.trim();
        throw new CarrierError(
          'CARRIER_REJECTED',
          `${op}: ${truncate(this.scrub(d || 'Mylerz refused the request', secrets))}`
        );
      }
      return env.Value as T;
    }
    /* istanbul ignore next: the loop always returns or throws */
    throw new CarrierError('CARRIER_UNAVAILABLE', `${op}: no answer`);
  }

  private post<T = any>(
    op: string,
    c: MylerzCredentials,
    ctx: CarrierCallContext | undefined,
    path: string,
    payload: unknown
  ) {
    return this.api<T>(op, c, ctx, path, { method: 'POST', body: JSON.stringify(payload) });
  }

  // ---- address mapping ------------------------------------------------------------------

  private async zoneList(c: MylerzCredentials, ctx?: CarrierCallContext): Promise<Body[]> {
    const key = this.key(c, this.base(ctx).url);
    const hit = this.zones.get(key);
    if (hit && Date.now() - hit.at < ZONES_TTL_MS) return hit.list;
    const value = await this.api<Body[]>('mylerz.zones', c, ctx, '/api/packages/GetCityZoneList');
    const list = Array.isArray(value) ? value : [];
    if (list.length) {
      this.zones.set(key, { at: Date.now(), list });
      cap(this.zones);
    }
    return list;
  }

  /**
   * The Mylerz City + Neighborhood for the delivery address: the merchant's `zoneMap` override
   * (settings.zoneMap: { "<area or governorate>": { city, neighborhood, zoneCode? } }) first, else
   * GetCityZoneList matched by name. Unresolved is NEEDS_MAPPING, never a guess.
   * UNVERIFIED: whether Mylerz wants the zone `Code` or the English name in City / Neighborhood;
   * the only official sample (S3) sends a free-text name ("Maadi"), so the name is sent.
   */
  private async resolveZone(
    c: MylerzCredentials,
    ctx: CarrierCallContext | undefined,
    dest: CarrierShipmentRequest['deliveryAddress']
  ): Promise<ZoneChoice> {
    const map = ctx?.settings?.zoneMap;
    if (map && typeof map === 'object') {
      for (const q of [dest.area, dest.state, dest.city]) {
        if (!q) continue;
        const nq = normalizeName(q);
        const k = Object.keys(map).find(x => normalizeName(x) === nq);
        const v = k ? (map as Record<string, any>)[k] : undefined;
        if (v && typeof v.city === 'string' && typeof v.neighborhood === 'string') {
          return {
            city: v.city,
            neighborhood: v.neighborhood,
            zoneCode: typeof v.zoneCode === 'string' ? v.zoneCode : undefined,
          };
        }
      }
    }
    const gov = canonicalGovernorate(dest.state) ?? canonicalGovernorate(dest.city);
    const cityQueries = [gov?.en, gov?.ar, dest.state, dest.city].filter(Boolean) as string[];
    const cities = await this.zoneList(c, ctx);
    const nameOf = (x: Body) => [x.EnName, x.ArName].filter(s => typeof s === 'string') as string[];
    let city: Body | null = null;
    for (const q of cityQueries) {
      city = pickByName(cities, nameOf, q);
      if (city) break;
    }
    const where = [dest.area, dest.state ?? dest.city].filter(Boolean).join(', ');
    if (!city) {
      throw new CarrierError(
        'NEEDS_MAPPING',
        `Mylerz has no city matching "${where}"; add a zoneMap entry`
      );
    }
    const zones: Body[] = Array.isArray(city.Zones) ? city.Zones : [];
    let zone: Body | null = null;
    for (const q of [dest.area, dest.city]) {
      zone = pickByName(zones, nameOf, q);
      if (zone) break;
    }
    if (!zone) {
      throw new CarrierError(
        'NEEDS_MAPPING',
        `Mylerz has no neighborhood matching "${where}"; add a zoneMap entry`
      );
    }
    return {
      city: String(city.EnName ?? city.ArName ?? city.Code),
      neighborhood: String(zone.EnName ?? zone.ArName ?? zone.Code),
      zoneCode: zone.Code != null ? String(zone.Code) : undefined,
    };
  }

  // ---- shipments ------------------------------------------------------------------------

  /**
   * The barcode we already booked for this reference, if any. Mylerz documents no duplicate
   * guard, so TrackPackages (which accepts a ReferenceNumber, S1) is the lookup.
   * UNVERIFIED: that an empty Barcode + ReferenceNumber is answered with the parcel; an
   * IsErrorState answer is read as "not found" (the in-process cache still collapses retries).
   */
  private async findByReference(
    c: MylerzCredentials,
    ctx: CarrierCallContext | undefined,
    reference: string
  ): Promise<string | null> {
    let value: Body[];
    try {
      value = await this.post<Body[]>('mylerz.lookup', c, ctx, '/api/packages/TrackPackages', [
        { ReferenceNumber: reference },
      ]);
    } catch (err) {
      if (err instanceof CarrierError && err.code === 'CARRIER_REJECTED') return null;
      throw err;
    }
    const hit = Array.isArray(value)
      ? value.find(
          p =>
            p &&
            (p.RefNumber === reference || p.ReferenceNumber === reference) &&
            (p.Barcode || p.BarCode)
        )
      : null;
    return hit ? String(hit.Barcode ?? hit.BarCode) : null;
  }

  async createShipment(
    credentials: MylerzCredentials,
    data: CarrierShipmentRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierShipmentResponse> {
    const cod = data.codAmount ?? 0;
    if (!Number.isSafeInteger(cod) || cod < 0) {
      throw new CarrierError('CARRIER_REJECTED', 'codAmount must be integer piastres');
    }
    const c = this.creds(credentials);
    const base = this.base(ctx); // sandbox without a host refuses here, before any network call
    const reference = data.merchantReference ?? data.orderId;
    return this.created.once(this.key(c, base.url), reference, () =>
      this.book(c, data, ctx, cod, reference)
    );
  }

  private async book(
    c: MylerzCredentials,
    data: CarrierShipmentRequest,
    ctx: CarrierCallContext | undefined,
    cod: number,
    reference: string
  ): Promise<CarrierShipmentResponse> {
    const dest = data.deliveryAddress;
    const zone = await this.resolveZone(c, ctx, dest);

    const existing = await this.findByReference(c, ctx, reference);
    if (existing) return { carrierShipmentId: existing, trackingNumber: existing };

    const description =
      data.items
        .map(i => `${i.quantity} x ${i.name}`)
        .join(', ')
        .slice(0, 1000) || `Order ${data.orderNumber}`;
    const service =
      typeof ctx?.settings?.mylerzService === 'string' && ctx.settings.mylerzService
        ? ctx.settings.mylerzService
        : 'ND';
    // S3 requires PickupDueDate; its sample has no timezone. Next day, ISO without the zone.
    const pickupDue = new Date(Date.now() + 86_400_000).toISOString().slice(0, 19);
    const order: Body = {
      // The UNION of S1's and S3's required fields (they disagree), so either validator passes.
      Package_Serial: 1,
      Reference: reference.slice(0, 150),
      Description: description,
      Service_Type: 'DTD',
      Service: service,
      Service_Category: 'DELIVERY',
      Payment_Type: cod > 0 ? 'COD' : 'PP',
      // UNVERIFIED: unit/currency of COD_Value (S1 types it string, S3 sends a number); EGP number.
      COD_Value: piastresToEgp(cod),
      Customer_Name: dest.name.slice(0, 200),
      Mobile_No: dest.phone.slice(0, 20),
      Street: [dest.line1, dest.line2].filter(Boolean).join(', ').slice(0, 500),
      Country: 'Egypt',
      City: zone.city,
      Neighborhood: zone.neighborhood,
      PickupDueDate: pickupDue,
      WarehouseName: c.warehouseName,
      Pieces: [{ PieceNo: 1 }],
      ...(data.weight ? { Total_Weight: data.weight } : {}),
      ...(dest.email ? { Customer_Email: dest.email.slice(0, 254) } : {}),
      ...(dest.building ? { Building_No: dest.building.slice(0, 50) } : {}),
      ...(dest.floor ? { Floor_No: dest.floor.slice(0, 50) } : {}),
      ...(dest.apartment ? { Apartment_No: dest.apartment.slice(0, 50) } : {}),
      ...(data.notes ? { Special_Notes: data.notes.slice(0, 500) } : {}),
    };

    const value = await this.post<Body>('mylerz.create', c, ctx, '/api/Orders/AddOrders', [order]);
    if (value && (value.ErrorCode || value.ErrorMessage)) {
      throw new CarrierError(
        'CARRIER_REJECTED',
        `mylerz.create: ${truncate(String(value.ErrorMessage ?? value.ErrorCode))}`
      );
    }
    const pkg: Body | undefined = Array.isArray(value?.Packages) ? value.Packages[0] : undefined;
    if (pkg && (pkg.ErrorCode || pkg.ErrorMessage)) {
      throw new CarrierError(
        'CARRIER_REJECTED',
        `mylerz.create: ${truncate(String(pkg.ErrorMessage ?? pkg.ErrorCode))}`
      );
    }
    const barcode = pkg?.BarCode ?? pkg?.Barcode ?? pkg?.Pieces?.[0]?.Barcode;
    if (!barcode) {
      // The parcel may exist; a retry finds it by reference instead of booking a second one.
      throw new CarrierError('CARRIER_UNAVAILABLE', 'mylerz.create: no barcode in the response');
    }
    return { carrierShipmentId: String(barcode), trackingNumber: String(barcode) };
  }

  async getLabel(
    credentials: MylerzCredentials,
    shipment: { carrierShipmentId: string; trackingNumber: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierLabel> {
    const value = await this.post<unknown>('mylerz.awb', credentials, ctx, '/api/packages/GetAWB', {
      Barcode: shipment.trackingNumber || shipment.carrierShipmentId,
    });
    if (typeof value !== 'string' || !value) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'mylerz.awb: no label in the response');
    }
    // UNVERIFIED: S1 types the value as base64 bytes and S3 says "convert to pdf"; check the magic.
    const head = Buffer.from(value.slice(0, 16), 'base64').toString('latin1');
    if (!head.startsWith('%PDF')) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'mylerz.awb: the label is not a PDF');
    }
    return { pdfBase64: value };
  }

  async quote(
    credentials: MylerzCredentials,
    data: CarrierQuoteRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierQuote> {
    const c = this.creds(credentials);
    const cod = data.codAmount ?? 0;
    const zone = await this.resolveZone(c, ctx, data.deliveryAddress);
    if (!zone.zoneCode) {
      throw new CarrierError(
        'NEEDS_MAPPING',
        'Mylerz needs a zone code to quote; add zoneCode to the zoneMap entry'
      );
    }
    const value = await this.post<Body | Body[]>(
      'mylerz.quote',
      c,
      ctx,
      '/api/packages/GetExpectedCharges',
      {
        CODValue: piastresToEgp(cod),
        WarehouseName: c.warehouseName,
        // UNVERIFIED: that CustomerZoneCode takes the neighborhood zone `Code`.
        CustomerZoneCode: zone.zoneCode,
        PackageWeight: data.weight ?? 1,
        IsFulfillment: false,
        PackageServiceTypeCode: 'DTD',
        PackageServiceCode:
          typeof ctx?.settings?.mylerzService === 'string' && ctx.settings.mylerzService
            ? ctx.settings.mylerzService
            : 'ND',
        PaymentTypeCode: cod > 0 ? 'COD' : 'PP',
        ServiceCategoryCode: 'DELIVERY',
      }
    );
    const v = (Array.isArray(value) ? value[0] : value) ?? {};
    // UNVERIFIED: which field is the shopper's delivery fee and its currency. ShippingFees is the
    // fee by name; TotalTransfer may fold the COD value in, so it is only trusted for a prepaid
    // quote. Nothing finite -> refuse.
    const num = (x: unknown) => (x === null || x === '' ? NaN : Number(x));
    let fee = num(v.ShippingFees);
    if (!Number.isFinite(fee) && cod === 0) fee = num(v.TotalTransfer);
    if (!Number.isFinite(fee) || fee < 0 || fee > 1e9) {
      throw new CarrierError(
        'CARRIER_UNAVAILABLE',
        'mylerz.quote: no usable price in the response'
      );
    }
    return { amountPiastres: Math.round(fee * 100), source: 'api' };
  }

  /**
   * Optional (NOT on the shared interface): a separate pickup order for already-booked barcodes.
   * AddOrders already returns a PickupOrderCode (an automatic pickup order), and whether
   * CreatePickupOrder is needed or allowed afterwards is UNVERIFIED, so nothing calls this by default.
   * Time-window / contact / vehicle ids come from the merchant's settings (mylerzPickup*).
   */
  async createPickup(
    credentials: MylerzCredentials,
    barcodes: string[],
    ctx?: CarrierCallContext
  ): Promise<{ pickupOrderCode?: string }> {
    const c = this.creds(credentials);
    const s = ctx?.settings ?? {};
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
    const value = await this.post<Body[]>(
      'mylerz.pickup',
      c,
      ctx,
      '/api/PickupOrder/CreatePickupOrder',
      {
        PickupLocationName: c.warehouseName,
        // The merchant's date when asked through schedulePickup, else tomorrow (no zone, as S3's sample).
        PickupDueDate:
          typeof s.mylerzPickupDueDate === 'string'
            ? s.mylerzPickupDueDate
            : new Date(Date.now() + 86_400_000).toISOString().slice(0, 19),
        ExpectedPackageCount: barcodes.length,
        Packages: barcodes.map(Barcode => ({ Barcode })),
        ...(num(s.mylerzPickupTimeWindowId) !== undefined
          ? { PickupTimeWindowId: s.mylerzPickupTimeWindowId }
          : {}),
        ...(num(s.mylerzPickupContactMemberId) !== undefined
          ? { ContactMemberId: s.mylerzPickupContactMemberId }
          : {}),
        ...(num(s.mylerzPickupVehicleClassId) !== undefined
          ? { VehicleClassId: s.mylerzPickupVehicleClassId }
          : {}),
      }
    );
    const code = Array.isArray(value) ? value[0]?.PickupOrderCode : undefined;
    return { pickupOrderCode: code ? String(code) : undefined };
  }

  /** Lookup/GetAllPickupTimeWindow: `{ Id, SlotTime, IsDefault }` (PickupTimeWindowDto). */
  async pickupWindows(
    credentials: MylerzCredentials,
    ctx?: CarrierCallContext
  ): Promise<CarrierPickupWindow[]> {
    const value = await this.api<Body[]>(
      'mylerz.pickupWindows',
      credentials,
      ctx,
      '/api/Lookup/GetAllPickupTimeWindow',
      { method: 'GET' }
    );
    return (Array.isArray(value) ? value : [])
      .filter(w => w && (typeof w.Id === 'number' || typeof w.Id === 'string'))
      .map(w => ({
        id: String(w.Id),
        label: typeof w.SlotTime === 'string' && w.SlotTime ? w.SlotTime : `#${w.Id}`,
        isDefault: w.IsDefault === true,
      }));
  }

  /**
   * Shared pickup action (PROVIDERS-18): CreatePickupOrder for the shipment's barcode on the
   * chosen date and Mylerz slot. UNVERIFIED (as on `createPickup`): whether AddOrders' own
   * automatic pickup order makes this one redundant for a just-booked parcel.
   */
  async schedulePickup(
    credentials: MylerzCredentials,
    req: CarrierPickupRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierPickupResult> {
    const windowId = req.windowId !== undefined ? Number(req.windowId) : undefined;
    if (windowId !== undefined && !Number.isSafeInteger(windowId)) {
      throw new CarrierError('CARRIER_REJECTED', 'Mylerz pickup slot must be one of its slot ids');
    }
    const out = await this.createPickup(credentials, req.trackingNumbers, {
      ...ctx,
      settings: {
        ...(ctx?.settings ?? {}),
        ...(windowId !== undefined ? { mylerzPickupTimeWindowId: windowId } : {}),
        mylerzPickupDueDate: `${req.date}T09:00:00`,
      },
    });
    if (!out.pickupOrderCode) {
      throw new CarrierError(
        'CARRIER_UNAVAILABLE',
        'mylerz.pickup: no PickupOrderCode in the answer'
      );
    }
    return { carrierPickupId: out.pickupOrderCode };
  }

  async trackShipment(
    credentials: MylerzCredentials,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierTrackingResponse> {
    const value = await this.post<Body[]>(
      'mylerz.track',
      credentials,
      ctx,
      '/api/packages/TrackPackages',
      [{ Barcode: trackingNumber }]
    );
    const entry = Array.isArray(value)
      ? (value.find(p => String(p?.Barcode ?? p?.BarCode) === trackingNumber) ?? value[0])
      : undefined;
    if (!entry)
      throw new CarrierError('CARRIER_REJECTED', 'mylerz.track: Mylerz does not know this barcode');
    const log: Body[] = Array.isArray(entry.TrackLog) ? entry.TrackLog : [];
    const history: TrackingHistoryEntry[] = [];
    for (const e of log) {
      // Unknown statuses are NOT guessed: they stay out of the history (see MYLERZ_STATUS_MAP).
      const status = mapMylerzStatus(e.StatusEnName) ?? mapMylerzStatus(e.StatusCode);
      // UNVERIFIED: ChangedDate carries no offset; it is parsed as the runtime's zone.
      const when = new Date(e.ChangedDate);
      if (!status || Number.isNaN(when.getTime())) continue;
      history.push({
        status,
        timestamp: when,
        description: typeof e.StatusEnName === 'string' ? e.StatusEnName : undefined,
      });
    }
    history.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { status: history.at(-1)?.status ?? 'created', statusHistory: history };
  }

  async cancelShipment(
    credentials: MylerzCredentials,
    carrierShipmentId: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult> {
    let value: Body[];
    try {
      value = await this.post<Body[]>(
        'mylerz.cancel',
        credentials,
        ctx,
        '/api/packages/CancelPackage',
        [{ Barcode: carrierShipmentId }]
      );
    } catch (err) {
      if (err instanceof CarrierError && err.code === 'CARRIER_REJECTED') {
        return { status: 'failed', message: err.message };
      }
      throw err;
    }
    const r = Array.isArray(value)
      ? (value.find(x => String(x?.Barcode) === carrierShipmentId) ?? value[0])
      : undefined;
    if (!r) return { status: 'failed', message: 'Mylerz returned no result for this barcode' };
    // Only an explicit IsChanged === true is a cancellation. UNVERIFIED: the eligibility window.
    if (r.IsChanged === true) return { status: 'cancelled' };
    const m = r.ErrorMessage ?? r.ErrorCode;
    return { status: 'not_cancellable', message: typeof m === 'string' ? truncate(m) : undefined };
  }

  /**
   * UNVERIFIED: S1 exposes a webhook registration (POST /api/Merchant) but nothing documents the
   * payload, the status vocabulary or the auth scheme. Rather than parse a guessed shape, every
   * payload is ignored (capabilities.webhooks is false); tracking is polled via TrackPackages.
   */
  processWebhook(_body: unknown, _headers: Record<string, string>): CarrierWebhookResult | null {
    return null;
  }

  async testConnection(
    credentials: MylerzCredentials,
    ctx?: CarrierCallContext
  ): Promise<CarrierTestResult> {
    try {
      this.base(ctx); // no sandbox host: refuse without any network call
    } catch (err) {
      return {
        success: false,
        code: 'unknown',
        error: err instanceof Error ? err.message : MYLERZ_NO_SANDBOX_MESSAGE,
      };
    }
    try {
      const value = await this.api<Body[]>(
        'mylerz.test',
        credentials,
        ctx,
        '/api/Orders/GetWarehouses'
      );
      const names = (Array.isArray(value) ? value : [])
        .map(w => w?.Name)
        .filter((n): n is string => typeof n === 'string');
      const want = credentials.warehouseName.trim().toLowerCase();
      if (!names.some(n => n.trim().toLowerCase() === want)) {
        return {
          success: false,
          code: 'unknown',
          error: `Mylerz does not know a warehouse called "${truncate(credentials.warehouseName, 80)}". Known: ${names.slice(0, 5).join(', ') || 'none'}`,
        };
      }
      return { success: true };
    } catch (err) {
      if (err instanceof CarrierError) {
        const code =
          err.code === 'CARRIER_MISCONFIGURED'
            ? 'bad_credentials'
            : err.code === 'CARRIER_UNAVAILABLE'
              ? 'unreachable'
              : 'unknown';
        return { success: false, code, error: err.message };
      }
      return { success: false, code: 'unknown', error: 'connection failed' };
    }
  }
}

export const mylerzCarrier = new MylerzCarrier();
