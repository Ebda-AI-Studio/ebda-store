// ==========================================
// Bosta Carrier Implementation (SP7)
// ==========================================
//
// Bosta REST v2, API-key auth, per-merchant credentials. Sources: docs.bosta.co and the
// bostaapp SDKs as summarised in docs/ebda/research/egypt-shipping-carriers.md (the doc
// portal was unreachable from the research sandbox, so every field name below that is not
// confirmed against a live sandbox is marked `UNVERIFIED:`). Real sandbox keys are needed to
// close those; the adapter is contract-tested against a local stub (tests/stubs/bosta-stub.ts).
//
//  - COD: `cod` on the delivery, in EGP as a decimal number (converted from piastres here).
//  - Webhooks: Bosta signs nothing, so the callback URL handed to Bosta per delivery carries
//    a per-store secret path token (checked by the service, not here).
//  - Idempotency: Bosta has no idempotency header. The delivery carries our reference as
//    `businessReference`; before creating we look the reference up and reuse what exists, so
//    a retry after a lost response never books a second parcel.

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
  CarrierTrackingResponse,
  CarrierWebhookResult,
  ShipmentStatus,
  ShippingCarrierProvider,
  TrackingHistoryEntry,
} from './types';
import {
  carrierRequest,
  piastresToEgp,
  resolveCarrierBaseUrl,
  type CarrierHttpOptions,
} from '../../lib/carrier-http';

export const BOSTA_BASE_URLS = {
  // UNVERIFIED: base path `/api/v2` (search snippet + bosta-nodejs README).
  live: 'https://app.bosta.co/api/v2',
  sandbox: 'https://stg-app.bosta.co/api/v2',
};

export interface BostaCredentials {
  apiKey: string;
  /** The Bosta pickup location the parcel is collected from. UNVERIFIED: field `businessLocationId`. */
  businessLocationId?: string;
  /** Per-store secret that authenticates Bosta's webhook calls (path token, see the service). */
  webhookSecret?: string;
}

// UNVERIFIED: Bosta delivery state codes. Taken from docs.bosta.co as remembered; confirm
// against the sandbox before go-live. An unknown code is ignored (never guessed).
const BOSTA_STATE_MAP: Record<string, ShipmentStatus> = {
  '10': 'created', // pickup requested
  '11': 'created', // route assigned
  '20': 'picked_up', // picked up from the business
  '21': 'in_transit', // received at the warehouse
  '22': 'in_transit',
  '23': 'in_transit',
  '24': 'in_transit',
  '30': 'in_transit',
  '41': 'out_for_delivery',
  '45': 'delivered',
  '46': 'returned', // returned to the business
  '47': 'failed', // exception
  '48': 'cancelled', // terminated
  '49': 'cancelled',
  '100': 'failed', // lost
  '101': 'failed', // damaged
  '103': 'failed', // awaiting your action
  '105': 'in_transit', // on hold
};

const BOSTA_STATE_NAMES: Record<string, ShipmentStatus> = {
  'pickup requested': 'created',
  'route assigned': 'created',
  'picked up': 'picked_up',
  'in transit': 'in_transit',
  'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
  'returned to business': 'returned',
  exception: 'failed',
  terminated: 'cancelled',
  canceled: 'cancelled',
  cancelled: 'cancelled',
};

/** Normalize a Bosta state (number, string, or `{ code, value }`) to a ShipmentStatus, or null. */
export function mapBostaState(state: unknown): ShipmentStatus | null {
  if (state && typeof state === 'object') {
    const o = state as Record<string, unknown>;
    return mapBostaState(o.code ?? o.value);
  }
  if (typeof state === 'number') return BOSTA_STATE_MAP[String(state)] ?? null;
  if (typeof state === 'string') {
    const t = state.trim();
    return BOSTA_STATE_MAP[t] ?? BOSTA_STATE_NAMES[t.toLowerCase()] ?? null;
  }
  return null;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] || 'Customer', lastName: parts.slice(1).join(' ') || '-' };
}

type Body = Record<string, any>;

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

  constructor(private readonly http: CarrierHttpOptions = {}) {}

  private base(ctx?: CarrierCallContext) {
    const sandbox = ctx?.settings?.sandbox === true || ctx?.settings?.sandbox === 'true';
    return resolveCarrierBaseUrl('BOSTA_BASE_URL', BOSTA_BASE_URLS, sandbox, this.http.baseUrl);
  }

  // UNVERIFIED: Bosta sends the API key as the raw `Authorization` header value.
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

  /** The delivery we already booked for this reference, if any. UNVERIFIED: search endpoint and its shape. */
  private async findByReference(
    c: BostaCredentials,
    ctx: CarrierCallContext | undefined,
    reference: string
  ): Promise<{ id: string; trackingNumber: string } | null> {
    const res = await this.call<Body>(
      'bosta.search',
      c,
      ctx,
      `/deliveries/search?businessReference=${encodeURIComponent(reference)}`
    );
    const list: Body[] = res.body.deliveries ?? res.body.data?.deliveries ?? res.body.data ?? [];
    const hit = Array.isArray(list) ? list.find(d => d.businessReference === reference) : null;
    return hit
      ? { id: String(hit._id ?? hit.id), trackingNumber: String(hit.trackingNumber) }
      : null;
  }

  async createShipment(
    credentials: BostaCredentials,
    data: CarrierShipmentRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierShipmentResponse> {
    const reference = data.merchantReference ?? data.orderId;
    const cod = data.codAmount ?? 0;
    if (!Number.isSafeInteger(cod) || cod < 0) {
      throw new CarrierError('CARRIER_REJECTED', 'codAmount must be integer piastres');
    }
    const dest = data.deliveryAddress;
    const city =
      (ctx?.settings?.cityMap as Record<string, string> | undefined)?.[dest.state ?? ''] ??
      dest.state ??
      dest.city;
    if (!city) {
      // no governorate / city to map: ask the merchant instead of guessing a Bosta location id
      throw new CarrierError('NEEDS_MAPPING', 'The delivery address has no governorate or city');
    }

    const existing = await this.findByReference(credentials, ctx, reference);
    if (existing) {
      return {
        carrierShipmentId: existing.id,
        trackingNumber: existing.trackingNumber,
        trackingUrl: `https://bosta.co/tracking-shipment/?lang=en&shipment_number=${existing.trackingNumber}`,
      };
    }

    const { firstName, lastName } = splitName(dest.name);
    // UNVERIFIED: field names of POST /deliveries (type 10 = send/forward delivery).
    const payload: Body = {
      type: 10,
      specs: {
        packageType: 'Parcel',
        packageDetails: {
          itemsCount: data.items.reduce((n, i) => n + i.quantity, 0) || 1,
          description: data.items
            .map(i => i.name)
            .join(', ')
            .slice(0, 200),
        },
      },
      cod: piastresToEgp(cod),
      notes: data.notes ?? '',
      businessReference: reference,
      dropOffAddress: {
        city,
        districtName: dest.area ?? '',
        firstLine: dest.line1,
        secondLine: dest.line2 ?? '',
        buildingNumber: dest.building ?? '',
        floor: dest.floor ?? '',
        apartment: dest.apartment ?? '',
      },
      receiver: { firstName, lastName, phone: dest.phone, email: dest.email ?? '' },
      ...(credentials.businessLocationId
        ? { businessLocationId: credentials.businessLocationId }
        : {}),
      ...(ctx?.callbackUrl ? { webhookUrl: ctx.callbackUrl } : {}),
    };

    const res = await this.call<Body>('bosta.create', credentials, ctx, '/deliveries', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // UNVERIFIED: the create response carries `_id` and `trackingNumber` (top level or under `data`).
    const d: Body = res.body.data ?? res.body;
    const id = d._id ?? d.id;
    const trackingNumber = d.trackingNumber;
    if (!id || !trackingNumber) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'bosta.create: no delivery id in the response');
    }
    return {
      carrierShipmentId: String(id),
      trackingNumber: String(trackingNumber),
      trackingUrl: `https://bosta.co/tracking-shipment/?lang=en&shipment_number=${trackingNumber}`,
    };
  }

  async getLabel(
    credentials: BostaCredentials,
    shipment: { carrierShipmentId: string; trackingNumber: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierLabel> {
    // UNVERIFIED: AWB print endpoint `GET /deliveries/awb/{id}` answering base64 PDF data.
    const res = await this.call<Body>(
      'bosta.awb',
      credentials,
      ctx,
      `/deliveries/awb/${encodeURIComponent(shipment.carrierShipmentId)}`
    );
    const pdf = res.body.data ?? res.body.awb ?? res.body.pdf;
    if (typeof pdf !== 'string' || !pdf) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'bosta.awb: no label in the response');
    }
    return { pdfBase64: pdf };
  }

  async quote(
    credentials: BostaCredentials,
    data: CarrierQuoteRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierQuote> {
    // UNVERIFIED: a rate-quote endpoint exists; path and fields are a guess from the pricing page.
    const qs = new URLSearchParams({
      cod: String(piastresToEgp(data.codAmount ?? 0)),
      dropOffCity: data.deliveryAddress.state ?? data.deliveryAddress.city,
      pickupCity: data.pickupAddress.state ?? data.pickupAddress.city,
      size: 'Normal',
      type: 'SEND',
    });
    const res = await this.call<Body>(
      'bosta.quote',
      credentials,
      ctx,
      `/pricing/calculator?${qs.toString()}`
    );
    const fee = res.body.data?.priceAfterVat ?? res.body.priceAfterVat ?? res.body.data?.price;
    if (fee === undefined) throw new CarrierError('CARRIER_UNAVAILABLE', 'bosta.quote: no price');
    return { amountPiastres: Math.round(Number(fee) * 100), source: 'api' };
  }

  async trackShipment(
    credentials: BostaCredentials,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierTrackingResponse> {
    // UNVERIFIED: GET /deliveries/business/{trackingNumber} answering `state` and `trackingDetails`.
    const res = await this.call<Body>(
      'bosta.track',
      credentials,
      ctx,
      `/deliveries/business/${encodeURIComponent(trackingNumber)}`
    );
    const d: Body = res.body.data ?? res.body;
    const current = mapBostaState(d.state) ?? 'created';
    const events: Body[] = d.trackingDetails ?? d.timeline ?? [];
    const history: TrackingHistoryEntry[] = events
      .map(e => ({
        status: mapBostaState(e.state ?? e.code) ?? current,
        timestamp: new Date(e.date ?? e.timestamp ?? Date.now()),
        location: e.hub ?? e.location ?? undefined,
        description: e.description ?? e.state?.value ?? undefined,
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { status: current, statusHistory: history };
  }

  async cancelShipment(
    credentials: BostaCredentials,
    carrierShipmentId: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult> {
    // UNVERIFIED: DELETE /deliveries/{id} ("terminate"); a 4xx means it is already with the courier.
    const res = await this.call<Body>(
      'bosta.terminate',
      credentials,
      ctx,
      `/deliveries/${encodeURIComponent(carrierShipmentId)}`,
      { method: 'DELETE' },
      [400, 404, 409, 422]
    );
    if (res.status >= 200 && res.status < 300) return { status: 'cancelled' };
    if (res.status === 404) return { status: 'failed', message: 'not found at Bosta' };
    const message = (res.body as Body).message;
    return {
      status: 'not_cancellable',
      message: typeof message === 'string' ? message : undefined,
    };
  }

  /**
   * UNVERIFIED payload shape: `{ _id, trackingNumber, state, businessReference, timestamp,
   * exceptionReason }`. An unknown state is ignored rather than guessed.
   */
  processWebhook(body: unknown, _headers: Record<string, string>): CarrierWebhookResult | null {
    if (!body || typeof body !== 'object') return null;
    const p = body as Body;
    const trackingNumber = p.trackingNumber ?? p.tracking_number;
    const status = mapBostaState(p.state ?? p.status);
    if (!trackingNumber || !status) return null;
    const ts = p.timestamp ?? p.updatedAt ?? p.date;
    const when = ts ? new Date(ts) : new Date();
    return {
      trackingNumber: String(trackingNumber),
      status,
      timestamp: Number.isNaN(when.getTime()) ? new Date() : when,
      location: p.hub ?? p.location ?? undefined,
      description: p.exceptionReason ?? p.description ?? undefined,
    };
  }

  async testConnection(
    credentials: BostaCredentials,
    ctx?: CarrierCallContext
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // UNVERIFIED: a one-row delivery list is the cheapest authenticated read.
      await this.call('bosta.test', credentials, ctx, '/deliveries?pageId=1&pageLimit=1');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'connection failed' };
    }
  }
}

export const bostaCarrier = new BostaCarrier();
