// ==========================================
// Shipping Carrier Types
// Common interfaces for all shipping carrier integrations
// ==========================================

export type ShipmentStatus =
  | 'created'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'returned'
  | 'cancelled';

/**
 * A shipment ROW can also be in `creation_failed`: booking with the carrier failed and the row
 * records the error until a retry succeeds. It is not a carrier status, so it is not in
 * SHIPMENT_STATUSES (what a carrier can report).
 */
export const CREATION_FAILED = 'creation_failed';

export const SHIPMENT_STATUSES: ShipmentStatus[] = [
  'created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned',
  'cancelled',
];

export interface ShipmentAddress {
  name: string;
  phone: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  country: string;
  postalCode?: string;
  // Area / district level fields (Egypt: governorate in `state`, district in `area`)
  area?: string;
  block?: string;
  street?: string;
  building?: string;
  floor?: string;
  apartment?: string;
}

export interface ShipmentItem {
  name: string;
  quantity: number;
  weight?: number;
  value?: number; // item value in piastres
  sku?: string;
}

export interface ShipmentDimensions {
  length: number; // cm
  width: number; // cm
  height: number; // cm
}

export interface CarrierShipmentRequest {
  orderId: string;
  orderNumber: string;
  pickupAddress: ShipmentAddress;
  deliveryAddress: ShipmentAddress;
  weight?: number; // kg
  dimensions?: ShipmentDimensions;
  items: ShipmentItem[];
  /**
   * Cash on delivery the carrier must collect, in integer PIASTRES (EGP). Omitted or 0 means
   * prepaid. Each adapter converts at the edge (Bosta takes EGP as a decimal number).
   */
  codAmount?: number;
  /**
   * The merchant's own reference for this parcel (the order id). Carriers have no
   * idempotency header, so adapters key their own duplicate guard on it.
   */
  merchantReference?: string;
  /** Manual carrier: the name the merchant typed, and the tracking number they were given. */
  manual?: { carrierName: string; trackingNumber: string };
  notes?: string;
}

export interface CarrierShipmentResponse {
  carrierShipmentId: string;
  trackingNumber: string;
  /** The carrier's transaction id, when cancel / lookup use one other than the shipment id. */
  carrierTransactionId?: string;
  trackingUrl?: string;
  labelUrl?: string;
  estimatedDelivery?: Date;
  /**
   * The parcel IS booked but a follow-up the carrier needs failed (ShipBlu's pickup request).
   * Short, English, secret-free; the service shows it on the shipment next to the tracking number.
   */
  warning?: string;
}

export interface TrackingHistoryEntry {
  status: ShipmentStatus;
  timestamp: Date;
  location?: string;
  description?: string;
}

export interface CarrierTrackingResponse {
  status: ShipmentStatus;
  statusHistory: TrackingHistoryEntry[];
  estimatedDelivery?: Date;
}

/** What a carrier answers to "cancel this shipment". `not_cancellable` once it was picked up. */
export interface CarrierCancelResult {
  status: 'cancelled' | 'not_cancellable' | 'failed';
  message?: string;
}

/** A shipping label. `url` when the carrier hosts it, else the PDF bytes (base64). */
export interface CarrierLabel {
  url?: string;
  pdfBase64?: string;
}

export interface CarrierQuoteRequest {
  pickupAddress: ShipmentAddress;
  deliveryAddress: ShipmentAddress;
  weight?: number;
  codAmount?: number;
}

export interface CarrierQuote {
  /** Delivery fee in piastres. */
  amountPiastres: number;
  source: 'api';
}

/** Per-call context the service hands an adapter next to the decrypted credentials. */
export interface CarrierCallContext {
  /** The merchant's non-secret carrier settings (pickup, sandbox flag, COD currency switch...). */
  settings?: Record<string, unknown>;
  /**
   * Absolute URL the carrier should call back with tracking updates, secret path token
   * included. Only set for carriers with webhooks.
   */
  callbackUrl?: string;
}

/** What a carrier can do; the service and the UI only offer what is declared. */
export interface CarrierCapabilities {
  quote: boolean;
  label: boolean;
  /** The carrier pushes tracking updates. */
  webhooks: boolean;
  /** Tracking must be polled (no push). */
  polling: boolean;
  /** Can the carrier collect cash on delivery in EGP? `'unconfirmed'` = refused until verified. */
  cod: boolean | 'unconfirmed';
  /**
   * Courier pickups (PROVIDERS-18): `request` = the merchant asks for one (`schedulePickup`);
   * `automatic` = booking requests it (ShipBlu); `none` = no pickup API (manual).
   */
  pickup: 'request' | 'automatic' | 'none';
  /**
   * How a pickup time is chosen: `none` = the carrier assigns the slot (Bosta), `times` = the
   * merchant gives a from/to window (Aramex), `carrier_slots` = one of the carrier's own slots,
   * listed by `pickupWindows` (Mylerz).
   */
  pickupWindow: 'none' | 'times' | 'carrier_slots';
  /** A requested pickup can be cancelled through the API (`cancelPickup`). */
  pickupCancel: boolean;
}

/** A pickup the merchant asks for. Dates and times are Africa/Cairo wall-clock. */
export interface CarrierPickupRequest {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, HH:MM (pickupWindow `times`). */
  window?: { from: string; to: string };
  /** A carrier slot id (pickupWindow `carrier_slots`). */
  windowId?: string;
  /** The store's pickup location (the carrier settings' pickup address). */
  address: ShipmentAddress;
  /** Parcels to collect: the shipment's tracking numbers / barcodes. */
  trackingNumbers: string[];
  /** Our pickup row id: a carrier that takes a reference gets it. */
  reference: string;
  weightKg?: number;
}

export interface CarrierPickupResult {
  /** What cancel / lookup take. */
  carrierPickupId: string;
  /** The number a human quotes to the carrier, when it differs. */
  carrierReference?: string;
  /** A slot the carrier assigned ("10:00 to 13:00"). */
  timeSlot?: string;
}

export interface CarrierPickupWindow {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface CarrierWebhookResult {
  trackingNumber: string;
  status: ShipmentStatus;
  timestamp: Date;
  location?: string;
  description?: string;
}

export interface ShippingCarrierProvider {
  name: string;
  code: string;
  capabilities: CarrierCapabilities;

  /**
   * Carriers whose callbacks echo a header we chose (Bosta: `webhookCustomHeaders`): the service
   * requires that header IN ADDITION to the secret URL token, so a leaked URL alone is not enough.
   * `valueFor(secret)` derives the header value from the store's webhook secret (never the secret
   * itself, so the URL token and the header value cannot be swapped for each other).
   */
  webhookHeader?: { name: string; valueFor(secret: string): string };

  /**
   * Create a new shipment with the carrier. MUST be idempotent on `data.merchantReference`:
   * a repeat call for the same reference returns the same shipment, never a second parcel.
   */
  createShipment(
    credentials: any,
    data: CarrierShipmentRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierShipmentResponse>;

  /**
   * Track a shipment by tracking number (the poll path; also the admin "refresh" button).
   */
  trackShipment(
    credentials: any,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierTrackingResponse>;

  /**
   * Cancel a shipment by carrier shipment ID. `not_cancellable` once the carrier has it.
   */
  cancelShipment(
    credentials: any,
    carrierShipmentId: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult | boolean>;

  /**
   * The label for a booked shipment (PDF bytes or a hosted URL). Optional capability.
   */
  getLabel?(
    credentials: any,
    shipment: { carrierShipmentId: string; trackingNumber: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierLabel>;

  /**
   * A delivery fee quote. Optional capability (many carriers publish none).
   */
  quote?(
    credentials: any,
    data: CarrierQuoteRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierQuote>;

  /** Ask the carrier to collect parcels (capabilities.pickup === 'request'). */
  schedulePickup?(
    credentials: any,
    req: CarrierPickupRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierPickupResult>;

  /** Cancel a requested pickup (capabilities.pickupCancel). */
  cancelPickup?(
    credentials: any,
    pickup: { carrierPickupId: string; carrierReference?: string | null },
    ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult>;

  /** The carrier's own pickup slots (capabilities.pickupWindow === 'carrier_slots'). */
  pickupWindows?(credentials: any, ctx?: CarrierCallContext): Promise<CarrierPickupWindow[]>;

  /**
   * Parse an incoming carrier webhook payload into a normalized result.
   * Returns null if the payload is unrecognized or not relevant. Authentication is NOT the
   * adapter's job: carriers that sign nothing are authenticated by a per-store secret in the
   * callback URL, checked by the service before this is called.
   */
  processWebhook(body: unknown, headers: Record<string, string>): CarrierWebhookResult | null;

  /**
   * Test carrier credentials by making a lightweight API call
   */
  testConnection(credentials: any, ctx?: CarrierCallContext): Promise<CarrierTestResult>;
}

/**
 * What Test connection answers. `error` is a short English reason, never a secret or a raw
 * carrier body; `code` lets the admin say "wrong key" apart from "carrier unreachable".
 */
export interface CarrierTestResult {
  success: boolean;
  error?: string;
  code?: 'bad_credentials' | 'unreachable' | 'unknown';
}

export function normalizeCancel(r: CarrierCancelResult | boolean): CarrierCancelResult {
  if (typeof r === 'boolean') return { status: r ? 'cancelled' : 'failed' };
  return r;
}

/** Typed adapter failure so the service can tell an outage (retry) from a refusal (do not). */
export type CarrierErrorCode =
  | 'CARRIER_UNAVAILABLE' // timeout / unreachable / 5xx: retry later, the order is fine
  | 'CARRIER_REJECTED' // the carrier refused this request: fix the data, retrying will not help
  | 'CARRIER_MISCONFIGURED' // bad credentials
  | 'COD_NOT_SUPPORTED' // this carrier may not collect COD for this merchant (yet)
  | 'NEEDS_MAPPING'; // the address could not be mapped to the carrier's location ids

export class CarrierError extends Error {
  constructor(
    readonly code: CarrierErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CarrierError';
  }

  /** Worth retrying: the carrier or the network, not the request. */
  get retryable(): boolean {
    return this.code === 'CARRIER_UNAVAILABLE';
  }
}

export const CARRIER_CODES = ['bosta', 'shipblu', 'mylerz', 'aramex', 'manual'] as const;
export type CarrierCode = (typeof CARRIER_CODES)[number];
