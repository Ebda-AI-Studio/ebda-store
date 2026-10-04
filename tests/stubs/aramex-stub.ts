/**
 * A local stand-in for Aramex's Shipping / Tracking / Rate Calculator JSON services (SP7).
 * The adapter is given `stub.fetch` as its transport. Not idempotent on create (Aramex has no
 * idempotency header), so the adapter's own reference cache is what is under test.
 * Shapes follow the adapter's `UNVERIFIED:` guesses.
 */
import type { ShipmentStatus } from '@api/services/carriers/types';
import { FaultGate, json, type StubFault } from './stub-common';
import { egpToPiastres } from '@api/lib/carrier-http';

export const ARAMEX_STUB = {
  baseUrl: 'http://aramex.stub/ShippingAPI.V2',
  credentials: {
    accountNumber: '1234567',
    accountPin: '654321',
    accountEntity: 'CAI',
    accountCountryCode: 'EG',
    username: 'tester@example.com',
    password: 'pw',
  },
};

const CODE_FOR: Record<ShipmentStatus, string> = {
  created: 'SH005',
  picked_up: 'SH010',
  in_transit: 'SH020',
  out_for_delivery: 'SH040',
  delivered: 'SH050',
  failed: 'SH060',
  returned: 'SH070',
  cancelled: 'SH080',
};

export interface AramexParcel {
  waybill: string;
  reference: string;
  /** The COD the adapter sent, verbatim. */
  codValue: number | null;
  codCurrency: string | null;
  codMinor: number;
  updates: Array<{ UpdateCode: string; UpdateDateTime: string }>;
  pickedUp: boolean;
}

export class AramexStub {
  readonly faults = new FaultGate();
  readonly parcels = new Map<string, AramexParcel>();
  readonly requests: Array<{ path: string }> = [];
  historyOrder: 'asc' | 'desc' = 'desc';
  /** Currency the rate calculator quotes in. */
  quoteCurrency = 'EGP';
  quoteValue = '62.50';
  rejectAuth = false;
  private clock = Date.parse('2026-10-05T08:00:00Z');

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname.replace('/ShippingAPI.V2', '');
    this.requests.push({ path });
    const early = await this.faults.enter();
    if (early) return early;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    const ci = body.ClientInfo ?? {};
    if (
      this.rejectAuth ||
      ci.UserName !== ARAMEX_STUB.credentials.username ||
      ci.Password !== ARAMEX_STUB.credentials.password
    ) {
      return json(200, { Notifications: [{ Code: '1', Message: 'Invalid credentials' }] });
    }

    if (path === '/Shipping/V1.0/json/CreateShipments') {
      const sh = body.Shipments[0];
      const cod = sh.Details?.CashOnDeliveryAmount ?? null;
      const waybill = `ARX${String(this.parcels.size + 1).padStart(9, '0')}`;
      this.parcels.set(waybill, {
        waybill,
        reference: String(sh.Reference1 ?? ''),
        codValue: cod ? Number(cod.Value) : null,
        codCurrency: cod ? String(cod.CurrencyCode) : null,
        codMinor: cod ? egpToPiastres(String(cod.Value)) : 0,
        updates: [{ UpdateCode: 'SH005', UpdateDateTime: this.tick() }],
        pickedUp: false,
      });
      return json(200, {
        Notifications: [],
        Shipments: [
          {
            ID: waybill, // Aramex's shipment id IS the waybill number
            WaybillNumber: waybill,
            ShipmentLabel: { LabelURL: `http://aramex.stub/labels/${waybill}.pdf` },
          },
        ],
      });
    }
    if (path === '/Shipping/V1.0/json/PrintLabel') {
      const w = body.ShipmentNumber;
      if (!this.parcels.has(w)) {
        return json(200, { Notifications: [{ Code: 'ERR10', Message: 'unknown shipment' }] });
      }
      return json(200, {
        Notifications: [],
        ShipmentLabel: { LabelURL: `http://aramex.stub/labels/${w}.pdf` },
      });
    }
    if (path === '/Shipping/V1.0/json/CancelShipments') {
      const p = this.parcels.get(body.Shipments[0]);
      if (!p) return json(200, { Notifications: [{ Code: 'ERR10', Message: 'unknown shipment' }] });
      if (p.pickedUp) {
        return json(200, {
          Notifications: [{ Code: 'ERR61', Message: 'Shipment already picked up' }],
        });
      }
      p.updates.push({ UpdateCode: 'SH080', UpdateDateTime: this.tick() });
      return json(200, { Notifications: [] });
    }
    if (path === '/Tracking/V1.0/json/TrackShipments') {
      const w = body.Shipments[0];
      const p = this.parcels.get(w);
      if (!p) return json(200, { Notifications: [], TrackingResults: [] });
      const value = p.updates.map(u => ({
        ...u,
        UpdateLocation: 'Cairo',
        UpdateDescription: u.UpdateCode,
      }));
      if (this.historyOrder === 'desc') value.reverse();
      return json(200, { Notifications: [], TrackingResults: [{ Key: w, Value: value }] });
    }
    if (path === '/RateCalculator/V1.0/json/CalculateRate') {
      return json(200, {
        Notifications: [],
        TotalAmount: { Value: this.quoteValue, CurrencyCode: this.quoteCurrency },
      });
    }
    return json(404, { message: `stub: no route ${path}` });
  };

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  advance(waybill: string, status: ShipmentStatus) {
    const p = this.parcels.get(waybill);
    if (!p) throw new Error(`stub: unknown parcel ${waybill}`);
    if (status !== 'created') p.pickedUp = true;
    p.updates.push({ UpdateCode: CODE_FOR[status], UpdateDateTime: this.tick() });
  }

  injectNextCall(fault: StubFault) {
    this.faults.injectNextCall(fault);
  }
}
