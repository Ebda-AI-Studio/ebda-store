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
  // Kuwait-specific
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
  value?: number; // item value in fils
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
  codAmount?: number; // Cash on delivery amount in fils
  notes?: string;
}

export interface CarrierShipmentResponse {
  carrierShipmentId: string;
  trackingNumber: string;
  trackingUrl?: string;
  labelUrl?: string;
  estimatedDelivery?: Date;
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

  /**
   * Create a new shipment with the carrier
   */
  createShipment(credentials: any, data: CarrierShipmentRequest): Promise<CarrierShipmentResponse>;

  /**
   * Track a shipment by tracking number
   */
  trackShipment(credentials: any, trackingNumber: string): Promise<CarrierTrackingResponse>;

  /**
   * Cancel a shipment by carrier shipment ID
   */
  cancelShipment(credentials: any, carrierShipmentId: string): Promise<boolean>;

  /**
   * Parse an incoming carrier webhook payload into a normalized result.
   * Returns null if the payload is unrecognized or not relevant.
   */
  processWebhook(body: unknown, headers: Record<string, string>): CarrierWebhookResult | null;

  /**
   * Test carrier credentials by making a lightweight API call
   */
  testConnection(credentials: any): Promise<{ success: boolean; error?: string }>;
}

export const CARRIER_CODES = ['icarry', 'aramex'] as const;
export type CarrierCode = (typeof CARRIER_CODES)[number];
