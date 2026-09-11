// ==========================================
// Aramex Carrier Implementation
// ==========================================

import { safeFetch } from '../../lib/safe-fetch';
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

const ARAMEX_BASE_URL = 'https://ws.aramex.net/ShippingAPI.V2';

export interface AramexCredentials {
  accountNumber: string;
  accountPin: string;
  accountEntity: string;
  accountCountryCode: string;
  username: string;
  password: string;
  version?: string; // API version, defaults to 'v1'
}

// Aramex UpdateCode → normalized ShipmentStatus
// Reference: Aramex Tracking UpdateCode table
const ARAMEX_STATUS_MAP: Record<string, ShipmentStatus> = {
  // Created / booked
  SH005: 'created',
  SH006: 'created',
  // Picked up
  SH010: 'picked_up',
  SH011: 'picked_up',
  SH012: 'picked_up',
  // In transit
  SH020: 'in_transit',
  SH021: 'in_transit',
  SH022: 'in_transit',
  SH023: 'in_transit',
  SH024: 'in_transit',
  SH025: 'in_transit',
  SH030: 'in_transit',
  // Out for delivery
  SH040: 'out_for_delivery',
  SH041: 'out_for_delivery',
  // Delivered
  SH050: 'delivered',
  SH051: 'delivered',
  // Failed / exception
  SH060: 'failed',
  SH061: 'failed',
  SH062: 'failed',
  SH063: 'failed',
  SH064: 'failed',
  // Returned
  SH070: 'returned',
  SH071: 'returned',
  SH072: 'returned',
  // Cancelled
  SH080: 'cancelled',
  SH081: 'cancelled',
};

function mapAramexStatus(updateCode: string): ShipmentStatus {
  return ARAMEX_STATUS_MAP[updateCode] ?? 'in_transit';
}

function buildClientInfo(credentials: AramexCredentials) {
  return {
    AccountNumber: credentials.accountNumber,
    AccountPin: credentials.accountPin,
    AccountEntity: credentials.accountEntity,
    AccountCountryCode: credentials.accountCountryCode,
    UserName: credentials.username,
    Password: credentials.password,
    Version: credentials.version ?? 'v1',
  };
}

function apiUrl(path: string): string {
  return `${ARAMEX_BASE_URL}${path}`;
}

async function postJson(url: string, body: unknown): Promise<any> {
  // `safeFetch`, not bare `fetch`, even though `url` is built from the
  // module-level `ARAMEX_BASE_URL` and is not merchant-controlled today.
  // Two reasons: the registry gate in tests/unit/carrier-ssrf.test.ts asserts
  // NO bare fetch anywhere under services/carriers/ (an exception is a hole
  // the next author inherits), and the day this base becomes config- or
  // credential-driven — as iCarry's already is — the guard is already in
  // place rather than being the thing someone forgot.
  const res = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Aramex HTTP ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

export class AramexCarrier implements ShippingCarrierProvider {
  readonly name = 'Aramex';
  readonly code = 'aramex';

  async createShipment(
    credentials: AramexCredentials,
    data: CarrierShipmentRequest
  ): Promise<CarrierShipmentResponse> {
    const url = apiUrl('/Shipping/V1.0/json/CreateShipments');

    const payload = {
      ClientInfo: buildClientInfo(credentials),
      Transaction: {
        Reference1: data.orderNumber,
        Reference2: data.orderId,
      },
      Shipments: [
        {
          Shipper: {
            Reference1: data.orderNumber,
            AccountNumber: credentials.accountNumber,
            PartyAddress: {
              Line1: data.pickupAddress.line1,
              Line2: data.pickupAddress.line2 ?? '',
              Line3: '',
              City: data.pickupAddress.city,
              StateOrProvinceCode: data.pickupAddress.state ?? '',
              PostCode: data.pickupAddress.postalCode ?? '',
              CountryCode: data.pickupAddress.country,
            },
            Contact: {
              PersonName: data.pickupAddress.name,
              CompanyName: data.pickupAddress.name,
              PhoneNumber1: data.pickupAddress.phone,
              EmailAddress: data.pickupAddress.email ?? '',
            },
          },
          Consignee: {
            Reference1: data.orderNumber,
            PartyAddress: {
              Line1: data.deliveryAddress.line1,
              Line2: data.deliveryAddress.line2 ?? '',
              Line3: [
                data.deliveryAddress.area,
                data.deliveryAddress.block,
                data.deliveryAddress.street,
              ]
                .filter(Boolean)
                .join(', '),
              City: data.deliveryAddress.city,
              StateOrProvinceCode: data.deliveryAddress.state ?? '',
              PostCode: data.deliveryAddress.postalCode ?? '',
              CountryCode: data.deliveryAddress.country,
            },
            Contact: {
              PersonName: data.deliveryAddress.name,
              CompanyName: data.deliveryAddress.name,
              PhoneNumber1: data.deliveryAddress.phone,
              EmailAddress: data.deliveryAddress.email ?? '',
            },
          },
          ShippingDateTime: new Date().toISOString(),
          DueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          Comments: data.notes ?? '',
          PickupLocation: '',
          OperationsInstructions: '',
          AccountingInstrcutions: '',
          ServiceType: 'PDX', // Priority Document Express — adjust per need
          ProductType: 'PPX',
          PaymentType: data.codAmount ? 'C' : 'P', // C=Collect (COD), P=Prepaid
          PaymentOptions: data.codAmount ? 'CODS' : '',
          Details: {
            Dimensions: data.dimensions
              ? {
                  Length: data.dimensions.length,
                  Width: data.dimensions.width,
                  Height: data.dimensions.height,
                  Unit: 'CM',
                }
              : null,
            ActualWeight: {
              Value: data.weight ?? 0.5,
              Unit: 'KG',
            },
            ChargeableWeight: null,
            DescriptionOfGoods: data.items.map(i => i.name).join(', '),
            GoodsOriginCountry: data.pickupAddress.country,
            NumberOfPieces: data.items.reduce((acc, i) => acc + i.quantity, 0),
            ProductGroup: 'EXP',
            ProductType: 'PPX',
            PaymentType: data.codAmount ? 'C' : 'P',
            PaymentOptions: data.codAmount ? 'CODS' : '',
            Services: '',
            CashOnDeliveryAmount: data.codAmount
              ? { Value: data.codAmount / 1000, CurrencyCode: 'KWD' }
              : null,
            InsuranceAmount: null,
            CollectAmount: null,
            Items: data.items.map(item => ({
              PackageType: 'Box',
              Quantity: item.quantity,
              Weight: { Value: item.weight ?? 0.1, Unit: 'KG' },
              Comments: item.name,
              Reference: item.sku ?? '',
            })),
          },
        },
      ],
      LabelInfo: {
        ReportID: 9201,
        ReportType: 'URL',
      },
    };

    let json: any;
    try {
      json = await postJson(url, payload);
    } catch (err) {
      logger.error({ err, carrier: 'aramex' }, 'Aramex createShipment error');
      throw new Error(`Aramex createShipment failed: ${(err as Error).message}`);
    }

    const notifications = json.Notifications ?? [];
    if (notifications.length > 0 && notifications[0].Code !== '0') {
      const msg = notifications.map((n: any) => `[${n.Code}] ${n.Message}`).join('; ');
      logger.error({ notifications, carrier: 'aramex' }, 'Aramex createShipment notifications');
      throw new Error(`Aramex error: ${msg}`);
    }

    const shipment = json.Shipments?.[0];
    if (!shipment) {
      throw new Error('Aramex createShipment: no shipment in response');
    }

    return {
      carrierShipmentId: shipment.ID ?? shipment.ShipmentNumber,
      trackingNumber: shipment.WaybillNumber ?? shipment.ShipmentNumber,
      trackingUrl: `https://www.aramex.com/express/track.aspx?mode=1&ShipmentNumber=${shipment.WaybillNumber}`,
      labelUrl: json.Shipments?.[0]?.ShipmentLabel?.LabelURL ?? undefined,
      estimatedDelivery: shipment.ScheduledDelivery
        ? new Date(shipment.ScheduledDelivery)
        : undefined,
    };
  }

  async trackShipment(
    credentials: AramexCredentials,
    trackingNumber: string
  ): Promise<CarrierTrackingResponse> {
    const url = apiUrl('/Tracking/V1.0/json/TrackShipments');

    const payload = {
      ClientInfo: buildClientInfo(credentials),
      Transaction: { Reference1: `track-${trackingNumber}` },
      Shipments: [trackingNumber],
      GetLastTrackingUpdateOnly: false,
    };

    let json: any;
    try {
      json = await postJson(url, payload);
    } catch (err) {
      logger.error({ err, carrier: 'aramex', trackingNumber }, 'Aramex trackShipment error');
      throw new Error(`Aramex trackShipment failed: ${(err as Error).message}`);
    }

    const notifications = json.Notifications ?? [];
    if (notifications.length > 0 && notifications[0].Code !== '0') {
      const msg = notifications.map((n: any) => `[${n.Code}] ${n.Message}`).join('; ');
      throw new Error(`Aramex tracking error: ${msg}`);
    }

    const trackingResult = json.TrackingResults?.[0];
    if (!trackingResult) {
      throw new Error('Aramex trackShipment: no tracking result in response');
    }

    const updates: any[] = trackingResult.Value ?? [];

    const history: TrackingHistoryEntry[] = updates.map((u: any) => ({
      status: mapAramexStatus(u.UpdateCode),
      timestamp: u.UpdateDateTime ? new Date(u.UpdateDateTime) : new Date(),
      location: u.UpdateLocation ?? undefined,
      description: u.UpdateDescription ?? undefined,
    }));

    const latestUpdate = updates[0];
    const currentStatus = latestUpdate ? mapAramexStatus(latestUpdate.UpdateCode) : 'created';

    return {
      status: currentStatus,
      statusHistory: history,
      estimatedDelivery: undefined,
    };
  }

  async cancelShipment(
    credentials: AramexCredentials,
    carrierShipmentId: string
  ): Promise<boolean> {
    const url = apiUrl('/Shipping/V1.0/json/CancelShipments');

    const payload = {
      ClientInfo: buildClientInfo(credentials),
      Transaction: { Reference1: `cancel-${carrierShipmentId}` },
      Shipments: [carrierShipmentId],
    };

    try {
      const json = await postJson(url, payload);
      const notifications = json.Notifications ?? [];
      if (notifications.length > 0 && notifications[0].Code !== '0') {
        logger.error(
          { notifications, carrier: 'aramex', carrierShipmentId },
          'Aramex cancelShipment failed'
        );
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err, carrier: 'aramex', carrierShipmentId }, 'Aramex cancelShipment error');
      return false;
    }
  }

  processWebhook(body: unknown, _headers: Record<string, string>): CarrierWebhookResult | null {
    if (!body || typeof body !== 'object') return null;

    const payload = body as Record<string, any>;

    // Aramex push notification payload shape:
    // { ShipmentNumber, WaybillNumber, UpdateCode, UpdateDescription, UpdateDateTime, UpdateLocation }
    const trackingNumber =
      payload.WaybillNumber ?? payload.ShipmentNumber ?? payload.waybill_number;
    const updateCode = payload.UpdateCode ?? payload.update_code;

    if (!trackingNumber || !updateCode) {
      logger.warn({ payload }, 'Aramex webhook missing WaybillNumber or UpdateCode');
      return null;
    }

    return {
      trackingNumber: String(trackingNumber),
      status: mapAramexStatus(String(updateCode)),
      timestamp: payload.UpdateDateTime ? new Date(payload.UpdateDateTime) : new Date(),
      location: payload.UpdateLocation ?? undefined,
      description: payload.UpdateDescription ?? undefined,
    };
  }

  async testConnection(
    credentials: AramexCredentials
  ): Promise<{ success: boolean; error?: string }> {
    // Use TrackShipments with a known non-existent waybill number.
    // Aramex returns a notifications array; a code of '0' or a "not found" message
    // both indicate the credentials were accepted.
    const url = apiUrl('/Tracking/V1.0/json/TrackShipments');

    const payload = {
      ClientInfo: buildClientInfo(credentials),
      Transaction: { Reference1: 'connection-test' },
      Shipments: ['TEST000000000'],
      GetLastTrackingUpdateOnly: true,
    };

    try {
      const json = await postJson(url, payload);
      // If we get a valid JSON response (even with "not found" notifications),
      // credentials were accepted.
      const hasAuthError = (json.Notifications ?? []).some(
        (n: any) => n.Code === '1' || n.Code === '2' // auth-related error codes
      );
      if (hasAuthError) {
        const msg = json.Notifications[0].Message;
        return { success: false, error: msg };
      }
      return { success: true };
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err, carrier: 'aramex' }, 'Aramex testConnection error');
      return { success: false, error: message };
    }
  }
}

export const aramexCarrier = new AramexCarrier();
