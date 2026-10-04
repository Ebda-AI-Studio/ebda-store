// ==========================================
// Manual Carrier (SP7, day-one fallback)
// ==========================================
//
// For a courier with no API (Sprint, Egypt Post, a local driver): the merchant types the
// carrier's name and the tracking number they were given. Nothing is sent anywhere; the
// shipment row, the label-less order page, the tracking timeline (the merchant moves it
// along) and COD reconciliation all work the same as for an API carrier.

import {
  CarrierCancelResult,
  CarrierCapabilities,
  CarrierError,
  CarrierShipmentRequest,
  CarrierShipmentResponse,
  CarrierTrackingResponse,
  CarrierWebhookResult,
  ShippingCarrierProvider,
} from './types';

export class ManualCarrier implements ShippingCarrierProvider {
  readonly name = 'Manual';
  readonly code = 'manual';
  readonly capabilities: CarrierCapabilities = {
    quote: false,
    label: false,
    webhooks: false,
    polling: false,
    cod: true,
  };

  async createShipment(
    _credentials: unknown,
    data: CarrierShipmentRequest
  ): Promise<CarrierShipmentResponse> {
    const cod = data.codAmount ?? 0;
    if (!Number.isSafeInteger(cod) || cod < 0) {
      throw new CarrierError('CARRIER_REJECTED', 'codAmount must be integer piastres');
    }
    const carrierName = data.manual?.carrierName?.trim();
    const trackingNumber = data.manual?.trackingNumber?.trim();
    if (!carrierName || !trackingNumber) {
      throw new CarrierError('CARRIER_REJECTED', 'Enter the carrier name and the tracking number');
    }
    // Idempotent by construction: the id is derived from the merchant reference, so booking the
    // same order twice yields the same shipment (the service also keeps one row per order).
    return {
      carrierShipmentId: `manual:${data.merchantReference ?? data.orderId}`,
      trackingNumber,
    };
  }

  async trackShipment(): Promise<CarrierTrackingResponse> {
    // Nothing to ask: the merchant moves a manual shipment along themselves.
    throw new CarrierError('CARRIER_REJECTED', 'Manual shipments have no carrier tracking');
  }

  async cancelShipment(): Promise<CarrierCancelResult> {
    // Nothing was booked anywhere, so there is nothing to refuse.
    return { status: 'cancelled' };
  }

  processWebhook(): CarrierWebhookResult | null {
    return null;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }
}

export const manualCarrier = new ManualCarrier();
