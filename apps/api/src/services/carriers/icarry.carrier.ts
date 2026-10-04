// ==========================================
// iCarry Carrier Implementation
// ==========================================

import { assertPublicHttpUrl, safeFetch } from '../../lib/safe-fetch';
import logger from '../../lib/logger';
import {
  CarrierShipmentRequest,
  CarrierShipmentResponse,
  CarrierTrackingResponse,
  CarrierCapabilities,
  CarrierWebhookResult,
  ShipmentStatus,
  ShippingCarrierProvider,
  TrackingHistoryEntry,
} from './types';

// Placeholder base URL — real API URL will be configured per environment
export const ICARRY_BASE_URL = 'https://api.icarry.com/v1';

export interface ICarryCredentials {
  apiKey: string;
  baseUrl?: string; // allow override
}

// iCarry status codes → normalized ShipmentStatus
const STATUS_MAP: Record<string, ShipmentStatus> = {
  pending: 'created',
  created: 'created',
  picked_up: 'picked_up',
  on_the_way: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  arrived: 'out_for_delivery',
  delivered: 'delivered',
  failed: 'failed',
  failed_delivery: 'failed',
  cancelled: 'cancelled',
  returned: 'returned',
  return_in_transit: 'returned',
};

function mapStatus(raw: string): ShipmentStatus {
  const normalized = (raw || '').toLowerCase().replace(/\s+/g, '_');
  return STATUS_MAP[normalized] ?? 'in_transit';
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Resolve the API base URL for a carrier config.
 *
 * `credentials` comes from `shipping-carrier.routes.ts`, whose schema is
 * `z.record(z.string(), z.string())` — so `baseUrl` is merchant-supplied free
 * text that ends up inside a server-side `fetch()`. Returned verbatim, that is
 * an SSRF primitive against the API host's own network and the cloud metadata
 * endpoint at 169.254.169.254, with `testConnection` echoing the status and
 * `body.message` back to the merchant as an oracle.
 *
 * Every merchant-supplied override therefore goes through
 * `assertPublicHttpUrl`, which requires http(s) and blocks a URL whose host —
 * or ANY address that host resolves to — is loopback, private, CGNAT,
 * link-local or unspecified. It throws `SSRF_BLOCKED: <reason>`; callers
 * surface that the same way they already surface a carrier network error.
 *
 * This assert is the fail-fast half only, and on its own it is bypassable: a
 * `baseUrl` on a host that resolves publicly passes here and then answers
 * `302 Location: http://169.254.169.254/…`, which a bare `fetch()` follows
 * (it defaults to `redirect: 'follow'`). So every request below goes out
 * through `safeFetch`, which re-validates each redirect hop — validating here
 * and fetching there is what actually closes the oracle. Never call bare
 * `fetch()` on this base URL; `tests/unit/carrier-ssrf.test.ts` enforces that
 * for every carrier declaring a merchant-supplied `baseUrl`.
 *
 * The no-override path returns our own compile-time constant without a DNS
 * round-trip: validating a value we control would add latency to every
 * shipment call and make the carrier depend on DNS to use its default.
 */
export async function resolveBaseUrl(credentials: ICarryCredentials): Promise<string> {
  const override = credentials.baseUrl?.trim();
  if (!override) return ICARRY_BASE_URL;

  const trimmed = override.replace(/\/$/, '');
  await assertPublicHttpUrl(trimmed);
  return trimmed;
}

export class ICarryCarrier implements ShippingCarrierProvider {
  readonly name = 'iCarry';
  readonly code = 'icarry';
  readonly capabilities: CarrierCapabilities = {
    quote: false,
    label: false,
    webhooks: true,
    polling: true,
    cod: false,
  };

  async createShipment(
    credentials: ICarryCredentials,
    data: CarrierShipmentRequest
  ): Promise<CarrierShipmentResponse> {
    const base = await resolveBaseUrl(credentials);
    const url = `${base}/orders`;

    const payload = {
      reference_number: data.orderNumber,
      order_id: data.orderId,
      pickup: {
        name: data.pickupAddress.name,
        phone: data.pickupAddress.phone,
        email: data.pickupAddress.email,
        address: data.pickupAddress.line1,
        address2: data.pickupAddress.line2,
        city: data.pickupAddress.city,
        state: data.pickupAddress.state,
        country: data.pickupAddress.country,
        postal_code: data.pickupAddress.postalCode,
      },
      delivery: {
        name: data.deliveryAddress.name,
        phone: data.deliveryAddress.phone,
        email: data.deliveryAddress.email,
        address: data.deliveryAddress.line1,
        address2: data.deliveryAddress.line2,
        city: data.deliveryAddress.city,
        state: data.deliveryAddress.state,
        country: data.deliveryAddress.country,
        postal_code: data.deliveryAddress.postalCode,
        area: data.deliveryAddress.area,
        block: data.deliveryAddress.block,
        street: data.deliveryAddress.street,
        building: data.deliveryAddress.building,
        floor: data.deliveryAddress.floor,
        apartment: data.deliveryAddress.apartment,
      },
      weight: data.weight,
      dimensions: data.dimensions
        ? {
            length: data.dimensions.length,
            width: data.dimensions.width,
            height: data.dimensions.height,
          }
        : undefined,
      items: data.items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        weight: item.weight,
        value: item.value,
        sku: item.sku,
      })),
      cod_amount: data.codAmount,
      notes: data.notes,
    };

    let res: Response;
    try {
      res = await safeFetch(url, {
        method: 'POST',
        headers: buildHeaders(credentials.apiKey),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, carrier: 'icarry' }, 'iCarry createShipment network error');
      throw new Error(`iCarry network error: ${(err as Error).message}`);
    }

    const json: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      logger.error(
        { status: res.status, body: json, carrier: 'icarry' },
        'iCarry createShipment failed'
      );
      throw new Error(
        `iCarry createShipment error ${res.status}: ${json?.message ?? res.statusText}`
      );
    }

    return {
      carrierShipmentId: json.id ?? json.order_id,
      trackingNumber: json.tracking_number,
      trackingUrl: json.tracking_url,
      labelUrl: json.label_url,
      estimatedDelivery: json.estimated_delivery ? new Date(json.estimated_delivery) : undefined,
    };
  }

  async trackShipment(
    credentials: ICarryCredentials,
    trackingNumber: string
  ): Promise<CarrierTrackingResponse> {
    const base = await resolveBaseUrl(credentials);
    const url = `${base}/orders/${encodeURIComponent(trackingNumber)}/tracking`;

    let res: Response;
    try {
      res = await safeFetch(url, {
        method: 'GET',
        headers: buildHeaders(credentials.apiKey),
      });
    } catch (err) {
      logger.error(
        { err, carrier: 'icarry', trackingNumber },
        'iCarry trackShipment network error'
      );
      throw new Error(`iCarry network error: ${(err as Error).message}`);
    }

    const json: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      logger.error(
        { status: res.status, body: json, carrier: 'icarry', trackingNumber },
        'iCarry trackShipment failed'
      );
      throw new Error(
        `iCarry trackShipment error ${res.status}: ${json?.message ?? res.statusText}`
      );
    }

    const history: TrackingHistoryEntry[] = (json.history ?? []).map((entry: any) => ({
      status: mapStatus(entry.status),
      timestamp: new Date(entry.timestamp ?? entry.created_at),
      location: entry.location,
      description: entry.description,
    }));

    return {
      status: mapStatus(json.status),
      statusHistory: history,
      estimatedDelivery: json.estimated_delivery ? new Date(json.estimated_delivery) : undefined,
    };
  }

  async cancelShipment(
    credentials: ICarryCredentials,
    carrierShipmentId: string
  ): Promise<boolean> {
    const base = await resolveBaseUrl(credentials);
    const url = `${base}/orders/${encodeURIComponent(carrierShipmentId)}/cancel`;

    let res: Response;
    try {
      res = await safeFetch(url, {
        method: 'PUT',
        headers: buildHeaders(credentials.apiKey),
      });
    } catch (err) {
      logger.error(
        { err, carrier: 'icarry', carrierShipmentId },
        'iCarry cancelShipment network error'
      );
      return false;
    }

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      logger.error(
        { status: res.status, body: json, carrier: 'icarry', carrierShipmentId },
        'iCarry cancelShipment failed'
      );
      return false;
    }

    return true;
  }

  processWebhook(body: unknown, _headers: Record<string, string>): CarrierWebhookResult | null {
    if (!body || typeof body !== 'object') return null;

    const payload = body as Record<string, any>;

    // iCarry webhook payload shape: { tracking_number, status, timestamp, location, description }
    const trackingNumber = payload.tracking_number ?? payload.trackingNumber;
    const rawStatus = payload.status;

    if (!trackingNumber || !rawStatus) {
      logger.warn({ payload }, 'iCarry webhook missing tracking_number or status');
      return null;
    }

    return {
      trackingNumber: String(trackingNumber),
      status: mapStatus(String(rawStatus)),
      timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      location: payload.location ?? undefined,
      description: payload.description ?? undefined,
    };
  }

  async testConnection(
    credentials: ICarryCredentials
  ): Promise<{ success: boolean; error?: string }> {
    // Resolved INSIDE the try: testConnection's contract is
    // `{ success: false, error }`, never a throw — an SSRF_BLOCKED base URL
    // is a connection test that failed, and the merchant should be told why.
    // This is the reachable oracle (status + body.message go back to the
    // merchant), so it is the call site that most needs `safeFetch`: without
    // per-hop re-validation a 302 turns the "why" into a metadata readout.
    try {
      const base = await resolveBaseUrl(credentials);
      const url = `${base}/merchants/me`;

      const res = await safeFetch(url, {
        method: 'GET',
        headers: buildHeaders(credentials.apiKey),
      });

      if (!res.ok) {
        const json: any = await res.json().catch(() => ({}));
        return { success: false, error: `HTTP ${res.status}: ${json?.message ?? res.statusText}` };
      }

      return { success: true };
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err, carrier: 'icarry' }, 'iCarry testConnection error');
      // The merchant needs the VERDICT, not the reason. `assertPublicHttpUrl`
      // distinguishes "does not resolve" from "resolves to a private address",
      // which turns this endpoint into a boolean oracle over the API host's
      // resolver — a store_admin could map which internal names exist. Far
      // weaker than the pre-guard oracle, but free to close: the detailed
      // reason stays in the log line above, where operators can read it.
      if (message.startsWith('SSRF_BLOCKED')) {
        return { success: false, error: 'Base URL must be a public http(s) address.' };
      }
      return { success: false, error: message };
    }
  }
}

export const iCarryCarrier = new ICarryCarrier();
