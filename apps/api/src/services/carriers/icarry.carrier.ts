// ==========================================
// iCarry Carrier Implementation
// ==========================================

import logger from '../../lib/logger';
import {
  CarrierShipmentRequest,
  CarrierShipmentResponse,
  CarrierTrackingResponse,
  CarrierWebhookResult,
  ShipmentStatus,
  ShippingCarrierProvider,
  TrackingHistoryEntry,
} from './types';

// Placeholder base URL — real API URL will be configured per environment
const ICARRY_BASE_URL = 'https://api.icarry.com/v1';

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

function resolveBaseUrl(credentials: ICarryCredentials): string {
  return credentials.baseUrl?.replace(/\/$/, '') || ICARRY_BASE_URL;
}

export class ICarryCarrier implements ShippingCarrierProvider {
  readonly name = 'iCarry';
  readonly code = 'icarry';

  async createShipment(
    credentials: ICarryCredentials,
    data: CarrierShipmentRequest
  ): Promise<CarrierShipmentResponse> {
    const base = resolveBaseUrl(credentials);
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
      res = await fetch(url, {
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
    const base = resolveBaseUrl(credentials);
    const url = `${base}/orders/${encodeURIComponent(trackingNumber)}/tracking`;

    let res: Response;
    try {
      res = await fetch(url, {
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
    const base = resolveBaseUrl(credentials);
    const url = `${base}/orders/${encodeURIComponent(carrierShipmentId)}/cancel`;

    let res: Response;
    try {
      res = await fetch(url, {
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
    const base = resolveBaseUrl(credentials);
    const url = `${base}/merchants/me`;

    try {
      const res = await fetch(url, {
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
      return { success: false, error: message };
    }
  }
}

export const iCarryCarrier = new ICarryCarrier();
