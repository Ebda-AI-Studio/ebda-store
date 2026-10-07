// ==========================================
// Aramex Carrier Implementation
// ==========================================

import logger from '../../lib/logger';
import {
  carrierRequest,
  egpToPiastres,
  piastresToEgp,
  resolveCarrierBaseUrl,
  type CarrierHttpOptions,
} from '../../lib/carrier-http';
import { IdempotencyCache, credentialScope } from '../payment-providers/gateway-http';
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

export const ARAMEX_BASE_URLS = {
  live: 'https://ws.aramex.net/ShippingAPI.V2',
  // UNVERIFIED: the test host; Aramex hands out a test account with its developer docs.
  sandbox: 'https://ws.dev.aramex.net/ShippingAPI.V2',
};

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

export function mapAramexStatus(updateCode: string): ShipmentStatus {
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

type Body = Record<string, any>;

/** Aramex answers HTTP 200 with a `Notifications` list; a non-zero first code is the real error. */
function notificationError(json: Body): string | null {
  const notifications: Array<{ Code: string; Message: string }> = json.Notifications ?? [];
  if (notifications.length > 0 && notifications[0].Code !== '0') {
    // UNVERIFIED: codes 1 and 2 are the authentication failures (testConnection relies on them)
    if (['1', '2'].includes(notifications[0].Code)) {
      throw new CarrierError(
        'CARRIER_MISCONFIGURED',
        `Aramex refused the credentials: ${notifications[0].Message}`
      );
    }
    return notifications.map(n => `[${n.Code}] ${n.Message}`).join('; ');
  }
  return null;
}

export class AramexCarrier implements ShippingCarrierProvider {
  readonly name = 'Aramex';
  readonly code = 'aramex';
  readonly capabilities: CarrierCapabilities = {
    quote: true,
    label: true,
    // Aramex has no tracking push that we found (docs/ebda/research): tracking is POLLED.
    webhooks: false,
    polling: true,
    // UNVERIFIED: domestic COD in EGP. One integrator source says COD amounts are USD-only, so
    // COD is refused until the merchant records Aramex's written confirmation
    // (settings.codEgpConfirmed). Prepaid shipments are unaffected.
    cod: 'unconfirmed',
  };

  // Aramex has no idempotency header; this is the adapter-side half of "same reference, same
  // shipment" (the service also keeps one shipment row per order).
  private readonly created = new IdempotencyCache<CarrierShipmentResponse>();

  constructor(private readonly http: CarrierHttpOptions = {}) {}

  private async post(
    op: string,
    ctx: CarrierCallContext | undefined,
    path: string,
    body: unknown
  ): Promise<Body> {
    const sandbox = ctx?.settings?.sandbox === true || ctx?.settings?.sandbox === 'true';
    const base = resolveCarrierBaseUrl(
      'ARAMEX_BASE_URL',
      ARAMEX_BASE_URLS,
      sandbox,
      this.http.baseUrl
    );
    const res = await carrierRequest<Body>(
      op,
      base,
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      this.http
    );
    return res.body;
  }

  async createShipment(
    credentials: AramexCredentials,
    data: CarrierShipmentRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierShipmentResponse> {
    const cod = data.codAmount ?? 0;
    if (!Number.isSafeInteger(cod) || cod < 0) {
      throw new CarrierError('CARRIER_REJECTED', 'codAmount must be integer piastres');
    }
    if (cod > 0 && ctx?.settings?.codEgpConfirmed !== true) {
      // Refuse rather than book a COD parcel whose collected currency we cannot vouch for: the
      // old code sent `amount / 1000` in a 3-decimal currency, which would have mis-priced EGP orders.
      throw new CarrierError(
        'COD_NOT_SUPPORTED',
        'Aramex cash on delivery in EGP is not confirmed for this account. Ask Aramex to confirm in writing, then tick "COD in EGP confirmed" in the Aramex settings; until then ship COD orders with another carrier.'
      );
    }
    const reference = data.merchantReference ?? data.orderId;
    return this.created.once(
      credentialScope([credentials.accountNumber, credentials.accountEntity]),
      reference,
      () => this.book(credentials, data, ctx, cod)
    );
  }

  private async book(
    credentials: AramexCredentials,
    data: CarrierShipmentRequest,
    ctx: CarrierCallContext | undefined,
    cod: number
  ): Promise<CarrierShipmentResponse> {
    const domestic = data.pickupAddress.country === data.deliveryAddress.country;
    // UNVERIFIED: domestic Egypt products are ProductGroup DOM / ProductType OND; the old
    // Default product groups (EXP / PPX) stay for cross-border.
    const productGroup = domestic ? 'DOM' : 'EXP';
    const productType = domestic ? 'OND' : 'PPX';

    const payload = {
      ClientInfo: buildClientInfo(credentials),
      Transaction: {
        Reference1: data.orderNumber,
        Reference2: data.merchantReference ?? data.orderId,
      },
      Shipments: [
        {
          Reference1: data.merchantReference ?? data.orderId,
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
            ProductGroup: productGroup,
            ProductType: productType,
            PaymentType: cod ? 'C' : 'P', // C=Collect (COD), P=Prepaid
            PaymentOptions: cod ? 'CODS' : '',
            Services: cod ? 'CODS' : '',
            // UNVERIFIED: EGP is accepted for a domestic Egypt COD amount (guarded above).
            CashOnDeliveryAmount: cod ? { Value: piastresToEgp(cod), CurrencyCode: 'EGP' } : null,
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

    const json = await this.post(
      'aramex.createShipments',
      ctx,
      '/Shipping/V1.0/json/CreateShipments',
      payload
    );
    const err = notificationError(json);
    if (err) {
      logger.error({ carrier: 'aramex' }, 'Aramex createShipment notifications');
      throw new CarrierError('CARRIER_REJECTED', `Aramex error: ${err}`);
    }
    const shipment = json.Shipments?.[0];
    if (!shipment) {
      throw new CarrierError(
        'CARRIER_UNAVAILABLE',
        'Aramex createShipment: no shipment in response'
      );
    }
    const trackingNumber = shipment.WaybillNumber ?? shipment.ShipmentNumber ?? shipment.ID;
    return {
      carrierShipmentId: String(shipment.ID ?? shipment.ShipmentNumber ?? trackingNumber),
      trackingNumber: String(trackingNumber),
      trackingUrl: `https://www.aramex.com/express/track.aspx?mode=1&ShipmentNumber=${trackingNumber}`,
      labelUrl: shipment.ShipmentLabel?.LabelURL ?? undefined,
      estimatedDelivery: shipment.ScheduledDelivery
        ? new Date(shipment.ScheduledDelivery)
        : undefined,
    };
  }

  async getLabel(
    credentials: AramexCredentials,
    shipment: { carrierShipmentId: string; trackingNumber: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierLabel> {
    // UNVERIFIED: PrintLabel takes the shipment number and returns a hosted label URL.
    const json = await this.post('aramex.printLabel', ctx, '/Shipping/V1.0/json/PrintLabel', {
      ClientInfo: buildClientInfo(credentials),
      Transaction: { Reference1: `label-${shipment.trackingNumber}` },
      LabelInfo: { ReportID: 9201, ReportType: 'URL' },
      OriginEntity: credentials.accountEntity,
      ProductGroup: 'DOM',
      ShipmentNumber: shipment.trackingNumber,
    });
    const err = notificationError(json);
    if (err) throw new CarrierError('CARRIER_REJECTED', `Aramex error: ${err}`);
    const url = json.ShipmentLabel?.LabelURL;
    if (!url) throw new CarrierError('CARRIER_UNAVAILABLE', 'Aramex printLabel: no label URL');
    return { url };
  }

  async quote(
    credentials: AramexCredentials,
    data: CarrierQuoteRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierQuote> {
    // UNVERIFIED: Rate Calculator request/response shape.
    const json = await this.post('aramex.rate', ctx, '/RateCalculator/V1.0/json/CalculateRate', {
      ClientInfo: buildClientInfo(credentials),
      Transaction: { Reference1: 'quote' },
      OriginAddress: { City: data.pickupAddress.city, CountryCode: data.pickupAddress.country },
      DestinationAddress: {
        City: data.deliveryAddress.city,
        CountryCode: data.deliveryAddress.country,
      },
      ShipmentDetails: {
        PaymentType: 'P',
        ProductGroup: 'DOM',
        ProductType: 'OND',
        ActualWeight: { Value: data.weight ?? 0.5, Unit: 'KG' },
        ChargeableWeight: { Value: data.weight ?? 0.5, Unit: 'KG' },
        NumberOfPieces: 1,
      },
    });
    const err = notificationError(json);
    if (err) throw new CarrierError('CARRIER_REJECTED', `Aramex error: ${err}`);
    const total = json.TotalAmount;
    if (!total || total.CurrencyCode !== 'EGP') {
      // never convert silently: a USD quote is not a piastre amount
      throw new CarrierError(
        'CARRIER_REJECTED',
        `Aramex quoted in ${String(total?.CurrencyCode)}, not EGP`
      );
    }
    return { amountPiastres: egpToPiastres(String(total.Value)), source: 'api' };
  }

  async trackShipment(
    credentials: AramexCredentials,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierTrackingResponse> {
    const json = await this.post('aramex.track', ctx, '/Tracking/V1.0/json/TrackShipments', {
      ClientInfo: buildClientInfo(credentials),
      Transaction: { Reference1: `track-${trackingNumber}` },
      Shipments: [trackingNumber],
      GetLastTrackingUpdateOnly: false,
    });
    const err = notificationError(json);
    if (err) throw new CarrierError('CARRIER_REJECTED', `Aramex tracking error: ${err}`);

    const trackingResult = json.TrackingResults?.[0];
    if (!trackingResult) {
      throw new CarrierError(
        'CARRIER_REJECTED',
        'Aramex trackShipment: no tracking result in response'
      );
    }
    const updates: any[] = trackingResult.Value ?? [];

    // Oldest first, whatever order Aramex returns them in; the current status is the newest.
    const history: TrackingHistoryEntry[] = updates
      .map((u: any) => ({
        status: mapAramexStatus(u.UpdateCode),
        timestamp: u.UpdateDateTime ? new Date(u.UpdateDateTime) : new Date(),
        location: u.UpdateLocation ?? undefined,
        description: u.UpdateDescription ?? undefined,
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const current = history.length ? history[history.length - 1].status : 'created';
    return { status: current, statusHistory: history, estimatedDelivery: undefined };
  }

  async cancelShipment(
    credentials: AramexCredentials,
    carrierShipmentId: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult> {
    // UNVERIFIED: whether Shipping Services v1 has a shipment-cancel call at all (pickup cancel
    // is documented). A refusal is reported as `failed`, never silently as cancelled.
    let json: Body;
    try {
      json = await this.post('aramex.cancel', ctx, '/Shipping/V1.0/json/CancelShipments', {
        ClientInfo: buildClientInfo(credentials),
        Transaction: { Reference1: `cancel-${carrierShipmentId}` },
        Shipments: [carrierShipmentId],
      });
    } catch (e) {
      if (e instanceof CarrierError && e.code === 'CARRIER_REJECTED') {
        return { status: 'not_cancellable', message: e.message };
      }
      throw e;
    }
    const err = notificationError(json);
    if (err) {
      logger.error({ carrier: 'aramex', carrierShipmentId }, 'Aramex cancelShipment failed');
      return {
        status: /pick|transit|deliver/i.test(err) ? 'not_cancellable' : 'failed',
        message: err,
      };
    }
    return { status: 'cancelled' };
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
    credentials: AramexCredentials,
    ctx?: CarrierCallContext
  ): Promise<{ success: boolean; error?: string }> {
    // TrackShipments with a known non-existent waybill: Aramex answers with notifications, and
    // anything but an auth-related code means the credentials were accepted.
    try {
      const json = await this.post('aramex.test', ctx, '/Tracking/V1.0/json/TrackShipments', {
        ClientInfo: buildClientInfo(credentials),
        Transaction: { Reference1: 'connection-test' },
        Shipments: ['TEST000000000'],
        GetLastTrackingUpdateOnly: true,
      });
      const hasAuthError = (json.Notifications ?? []).some(
        (n: any) => n.Code === '1' || n.Code === '2' // auth-related error codes
      );
      if (hasAuthError) return { success: false, error: json.Notifications[0].Message };
      return { success: true };
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ carrier: 'aramex' }, 'Aramex testConnection error');
      return { success: false, error: message };
    }
  }
}

export const aramexCarrier = new AramexCarrier();
