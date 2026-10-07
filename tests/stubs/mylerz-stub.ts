/**
 * A local stand-in for Mylerz's Integration API. No real credentials, no network: the adapter is
 * given `stub.fetch` as its transport. Envelope shapes follow the OFFICIAL Swagger (S1):
 * `{ Value, IsErrorState, ErrorDescription }` with HTTP 200 for business errors, and the
 * observed `/token` error `{ error: 'invalid_grant' }` (HTTP 400). The status NAMES are the
 * stub's own (Mylerz publishes no status table), so this proves the adapter, not Mylerz.
 *
 * Deliberately NOT idempotent on AddOrders: Mylerz documents no duplicate-Reference guard, so the
 * adapter's own look-up-by-reference is what must keep a retry from booking a second parcel.
 */
import crypto from 'node:crypto';
import type { ShipmentStatus } from '@api/services/carriers/types';
import { FaultGate, json, headerOf, type StubFault } from './stub-common';
import { egpToPiastres } from '@api/lib/carrier-http';

export const MYLERZ_STUB = {
  baseUrl: 'http://mylerz.stub',
  username: 'merchant@example.test',
  password: 'mylerz-test-password',
  warehouseName: 'Main Warehouse',
  credentials: {
    username: 'merchant@example.test',
    password: 'mylerz-test-password',
    warehouseName: 'Main Warehouse',
  },
};

const NAME_FOR: Record<ShipmentStatus, string> = {
  created: 'Not Picked Yet',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  out_for_delivery: 'Out For Delivery',
  delivered: 'Delivered',
  failed: 'Delivery Attempt Failed', // not in the documented map: the adapter must ignore it
  returned: 'Returned',
  cancelled: 'Cancelled',
};

export interface MylerzParcel {
  barcode: string;
  reference: string;
  /** What the adapter sent, verbatim (EGP). */
  codSent: number;
  codMinor: number;
  order: Record<string, any>;
  state: ShipmentStatus;
  events: Array<{ name: string; date: string }>;
}

export class MylerzStub {
  readonly faults = new FaultGate();
  readonly parcels = new Map<string, MylerzParcel>();
  readonly requests: Array<{ method: string; path: string; body?: string }> = [];
  historyOrder: 'asc' | 'desc' = 'desc';
  rejectAuth = false;
  /** Seconds the issued token claims to live. */
  expiresIn: number | undefined = 1209599;
  /** Every /token request, for assertions (form bodies). */
  readonly tokenBodies: string[] = [];
  private readonly valid = new Set<string>();
  private clock = Date.now() + 6 * 3_600_000;
  private seq = 0;

  warehouses = [{ Name: MYLERZ_STUB.warehouseName }, { Name: 'Alexandria Hub' }];
  cities = [
    {
      Code: 'CAI',
      EnName: 'Cairo',
      ArName: 'القاهرة',
      Zones: [
        { Code: 'CAI-MAA', EnName: 'Maadi', ArName: 'المعادي' },
        { Code: 'CAI-NSR', EnName: 'Nasr City', ArName: 'مدينة نصر' },
      ],
    },
    {
      Code: 'GIZ',
      EnName: 'Giza',
      ArName: 'الجيزة',
      Zones: [
        { Code: 'GIZ-DOK', EnName: 'Dokki', ArName: 'الدقي' },
        { Code: 'GIZ-MOH', EnName: 'Mohandessin', ArName: 'المهندسين' },
      ],
    },
  ];
  /** ShippingFees the rate endpoint answers (EGP). */
  fee = 45.5;

  /** Make every issued token unknown: the next /api call answers 401. */
  revokeTokens() {
    this.valid.clear();
  }

  tokensIssued(): number {
    return this.tokenBodies.length;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = u.pathname;
    this.requests.push({
      method,
      path,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const early = await this.faults.enter();
    if (early) return early;

    if (method === 'POST' && path === '/token') {
      const form = new URLSearchParams(String(init?.body));
      this.tokenBodies.push(String(init?.body));
      if (
        this.rejectAuth ||
        form.get('grant_type') !== 'password' ||
        form.get('username') !== MYLERZ_STUB.username ||
        form.get('password') !== MYLERZ_STUB.password
      ) {
        return json(400, {
          error: 'invalid_grant',
          error_description: 'Login failed. Please try again.',
        });
      }
      const token = crypto.randomBytes(24).toString('hex');
      this.valid.add(token);
      return json(200, {
        access_token: token,
        token_type: 'bearer',
        ...(this.expiresIn !== undefined ? { expires_in: this.expiresIn } : {}),
        userName: MYLERZ_STUB.username,
      });
    }

    const auth = headerOf(init, 'authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (this.rejectAuth || !this.valid.has(token)) {
      return json(401, { Message: 'Authorization has been denied for this request.' });
    }
    const body = (): any => {
      try {
        return JSON.parse(String(init?.body));
      } catch {
        return null;
      }
    };
    const ok = (Value: unknown) => json(200, { Value, IsErrorState: false });
    const fail = (ErrorDescription: string) =>
      json(200, { Value: null, IsErrorState: true, ErrorDescription });

    if (method === 'GET' && path === '/api/Orders/GetWarehouses') return ok(this.warehouses);
    if (method === 'GET' && path === '/api/packages/GetCityZoneList') return ok(this.cities);

    if (method === 'POST' && path === '/api/Orders/AddOrders') {
      const orders = body();
      if (!Array.isArray(orders) || !orders.length) return fail('Missing required field: orders');
      const code = `6374${String(++this.seq).padStart(7, '0')}`;
      const packages = orders.map((o: Record<string, any>, i: number) => {
        for (const k of [
          'Description',
          'Service_Type',
          'Service',
          'Service_Category',
          'Customer_Name',
          'Mobile_No',
          'Street',
          'Neighborhood',
        ]) {
          if (!o[k])
            return {
              packageNo: i + 1,
              ErrorCode: '300',
              ErrorMessage: `Missing required field: ${k}`,
            };
        }
        const barcode = `${code}${String(i + 1).padStart(3, '0')}`;
        const cod = Number(o.COD_Value ?? 0);
        this.parcels.set(barcode, {
          barcode,
          reference: String(o.Reference ?? ''),
          codSent: cod,
          codMinor: egpToPiastres(String(cod)),
          order: o,
          state: 'created',
          events: [{ name: NAME_FOR.created, date: this.tick() }],
        });
        return {
          packageNo: i + 1,
          Reference: o.Reference,
          BarCode: barcode,
          Status: 'Not Picked Yet',
          Pieces: [{ Barcode: `${barcode}-1` }],
          ErrorCode: null,
          ErrorMessage: null,
        };
      });
      return ok({
        PickupOrderCode: code,
        PickupDateTime: new Date().toISOString(),
        Packages: packages,
      });
    }

    if (method === 'POST' && path === '/api/packages/TrackPackages') {
      const reqs = body();
      if (!Array.isArray(reqs)) return fail('Invalid request');
      const out: unknown[] = [];
      for (const r of reqs) {
        const p = r.Barcode
          ? this.parcels.get(r.Barcode)
          : [...this.parcels.values()].find(x => x.reference === r.ReferenceNumber);
        if (!p) continue;
        const log = p.events.map((e, i) => ({
          StatusCode: String(i + 1),
          StatusArName: e.name,
          StatusEnName: e.name,
          ChangedDate: e.date,
          TimeZone: 'Egypt Standard Time',
        }));
        if (this.historyOrder === 'desc') log.reverse();
        out.push({ Barcode: p.barcode, RefNumber: p.reference, TrackLog: log });
      }
      if (!out.length) return fail('Package not found');
      return ok(out);
    }

    if (method === 'POST' && path === '/api/packages/CancelPackage') {
      const reqs = body();
      if (!Array.isArray(reqs)) return fail('Invalid request');
      return ok(
        reqs.map((r: Record<string, any>) => {
          const p = this.parcels.get(r.Barcode);
          if (!p)
            return {
              Barcode: r.Barcode,
              IsChanged: false,
              ErrorCode: '404',
              ErrorMessage: 'Package not found',
            };
          if (p.state !== 'created') {
            return {
              Barcode: p.barcode,
              IsChanged: false,
              ErrorCode: '409',
              ErrorMessage: 'Package already picked up',
            };
          }
          this.setState(p, 'cancelled');
          return { Barcode: p.barcode, IsChanged: true, ErrorCode: null, ErrorMessage: null };
        })
      );
    }

    if (method === 'POST' && path === '/api/packages/GetAWB') {
      const r = body();
      if (!r || !this.parcels.has(r.Barcode)) return fail('Package not found');
      return ok(Buffer.from('%PDF-1.4 stub awb').toString('base64'));
    }

    if (method === 'POST' && path === '/api/packages/GetExpectedCharges') {
      return ok({ CODValue: 0, ShippingFees: this.fee, VAT: 0, TotalTransfer: this.fee });
    }

    if (method === 'POST' && path === '/api/PickupOrder/CreatePickupOrder') {
      return ok([
        { PickupOrderCode: 'PU1', WarehouseName: MYLERZ_STUB.warehouseName, PickupPackages: [] },
      ]);
    }
    return json(404, { Message: `stub: no route ${method} ${path}` });
  };

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private setState(p: MylerzParcel, s: ShipmentStatus) {
    p.state = s;
    p.events.push({ name: NAME_FOR[s], date: this.tick() });
  }

  parcelByTracking(t: string): MylerzParcel | undefined {
    return this.parcels.get(t);
  }

  advance(trackingNumber: string, status: ShipmentStatus) {
    const p = this.parcelByTracking(trackingNumber);
    if (!p) throw new Error(`stub: unknown parcel ${trackingNumber}`);
    this.setState(p, status);
  }

  /** Add a TrackLog row with an arbitrary status name (e.g. one the adapter must ignore). */
  addRawEvent(trackingNumber: string, name: string) {
    const p = this.parcelByTracking(trackingNumber);
    if (!p) throw new Error(`stub: unknown parcel ${trackingNumber}`);
    p.events.push({ name, date: this.tick() });
  }

  injectNextCall(fault: StubFault) {
    this.faults.injectNextCall(fault);
  }
}
