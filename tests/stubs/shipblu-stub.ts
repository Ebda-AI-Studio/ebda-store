/**
 * A local stand-in for ShipBlu's REST API. No real keys, no network: the adapter is given
 * `stub.fetch` as its transport. Response shapes follow the OFFICIAL OpenAPI and docs.shipblu.com
 * (bare arrays for governorates/cities/zones with bilingual "Arabic - English" names, a
 * `{count,next,previous,results}` order list, `tracking_events`, a binary PDF label, and
 * HTTP 403 `{"detail":...}` for a bad key). So it proves the adapter against the DOCUMENTED
 * shapes, not against ShipBlu itself.
 *
 * Deliberately NOT idempotent on create, and (like the OpenAPI's create schema) the 201 omits
 * `tracking_number` unless `createReturnsTracking` is set.
 */
import type { ShipmentStatus } from '@api/services/carriers/types';
import { FaultGate, json, headerOf, type StubFault } from './stub-common';
import { egpToPiastres } from '@api/lib/carrier-http';

export const SHIPBLU_STUB = { baseUrl: 'http://shipblu.stub/api', apiKey: 'shipblu-test-key' };

const STATUS_FOR: Record<ShipmentStatus, string> = {
  created: 'created',
  picked_up: 'picked_up',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  failed: 'lost',
  returned: 'returned',
  cancelled: 'cancelled',
};

export const SHIPBLU_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const GOVERNORATES = [
  { id: 1, name: 'القاهرة - Cairo', code: 'EGC' },
  { id: 2, name: 'الاسكندرية - Alexandria', code: 'EGALX' },
  { id: 3, name: 'الساحل الشمالي - North Coast', code: 'EGSHL' },
  { id: 4, name: 'الجيزة - Giza', code: 'EGGZ' },
];
const CITIES: Record<number, Array<{ id: number; name: string }>> = {
  1: [
    { id: 1, name: 'القاهرة الجديدة - New Cairo' },
    { id: 2, name: 'وسط البلد - Downtown Cairo' },
  ],
  2: [{ id: 3, name: 'سموحة - Smouha' }],
  3: [],
  4: [
    { id: 4, name: 'الدقي - Dokki' },
    { id: 5, name: 'السادس من أكتوبر - 6th of October' },
  ],
};
const ZONES: Record<number, Array<{ id: number; name: string }>> = {
  1: [
    { id: 11, name: 'التجمع الثالث - 3rd Settlement' },
    { id: 12, name: 'التجمع الخامس - 5th Settlement' },
  ],
  2: [{ id: 13, name: 'وسط البلد - Downtown Cairo' }],
  3: [{ id: 14, name: 'سموحة - Smouha' }],
  4: [
    { id: 41, name: 'الدقي - Dokki' },
    { id: 42, name: 'العجوزة - Agouza' },
  ],
  5: [{ id: 51, name: 'الحي الأول - 1st District' }],
};

export interface ShipbluOrder {
  id: number;
  tracking_number: string;
  merchant_order_reference: string;
  /** What the adapter sent, verbatim. */
  cash_amount: number | undefined;
  codMinor: number;
  status: string;
  body: Record<string, any>;
  events: Array<{ status: string; created: string }>;
}

export class ShipbluStub {
  readonly faults = new FaultGate();
  readonly orders = new Map<number, ShipbluOrder>();
  readonly requests: Array<{ method: string; path: string; authorization?: string; body?: any }> =
    [];
  readonly validKeys = new Set<string>([SHIPBLU_STUB.apiKey]);
  historyOrder: 'asc' | 'desc' = 'desc';
  /** The `total` the pricing endpoint answers. */
  price = 45.5;
  rejectAuth = false;
  /** When false (the OpenAPI's create schema), the 201 omits `tracking_number`. */
  createReturnsTracking = false;
  /** When set, the list filter is a CONTAINS match (the real filter semantics are unverified). */
  containsFilter = false;
  private clock = Date.now() + 6 * 3_600_000;
  private nextId = 9000;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = u.pathname.replace(/^\/api/, '');
    let body: any;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    this.requests.push({
      method,
      path: path + u.search,
      authorization: headerOf(init, 'authorization'),
      body,
    });
    const early = await this.faults.enter();
    if (early) return early;
    const auth = headerOf(init, 'authorization') ?? '';
    const key = auth.startsWith('Api-Key ') ? auth.slice('Api-Key '.length) : '';
    if (this.rejectAuth || !this.validKeys.has(key)) {
      return json(403, { detail: 'You do not have permission to perform this action.' });
    }

    if (method === 'GET' && path === '/v1/merchants/') {
      return json(200, {
        count: 1,
        next: null,
        previous: null,
        results: [{ id: 7, name: 'Shop' }],
      });
    }
    if (method === 'GET' && path === '/v1/governorates/') return json(200, GOVERNORATES);
    let m = /^\/v1\/governorates\/(\d+)\/cities\/$/.exec(path);
    if (method === 'GET' && m) return json(200, CITIES[Number(m[1])] ?? []);
    m = /^\/v1\/cities\/(\d+)\/zones\/$/.exec(path);
    if (method === 'GET' && m) return json(200, ZONES[Number(m[1])] ?? []);

    if (method === 'POST' && path === '/v1/delivery-orders/') {
      const id = this.nextId++;
      const cash = body.cash_amount as number | undefined;
      const order: ShipbluOrder = {
        id,
        tracking_number: `SB${String(id).padStart(9, '0')}`,
        merchant_order_reference: String(body.merchant_order_reference ?? ''),
        cash_amount: cash,
        codMinor: cash === undefined ? 0 : egpToPiastres(String(cash)),
        status: 'created',
        body,
        events: [{ status: 'created', created: this.tick() }],
      };
      this.orders.set(id, order);
      return json(201, {
        id,
        customer: body.customer,
        packages: body.packages,
        cash_amount: cash,
        merchant_order_reference: order.merchant_order_reference,
        status: 'created',
        ...(this.createReturnsTracking ? { tracking_number: order.tracking_number } : {}),
      });
    }
    if (method === 'GET' && path === '/v1/delivery-orders/') {
      const ref = u.searchParams.get('merchant_order_reference');
      const tn = u.searchParams.get('tracking_number');
      const hits = [...this.orders.values()].filter(o => {
        if (ref !== null) {
          return this.containsFilter
            ? o.merchant_order_reference.includes(ref)
            : o.merchant_order_reference === ref;
        }
        if (tn !== null) return o.tracking_number === tn;
        return true;
      });
      return json(200, {
        count: hits.length,
        next: null,
        previous: null,
        results: hits.map(o => this.view(o)),
      });
    }
    if (method === 'POST' && path === '/v1/delivery-orders/request-pickup/') {
      const nums = (u.searchParams.get('tracking_numbers') ?? '').split(',').filter(Boolean);
      const hit = nums
        .map(n => [...this.orders.values()].find(o => o.tracking_number === n))
        .filter((o): o is ShipbluOrder => !!o);
      for (const o of hit) this.setStatus(o, 'pickup_requested');
      return json(
        201,
        hit.map(o => ({ id: o.id * 10, status: 'pickup_requested', order: o.id }))
      );
    }
    m = /^\/v1\/delivery-orders\/(\d+)\/shipping-label\/$/.exec(path);
    if (method === 'GET' && m) {
      if (!this.orders.has(Number(m[1]))) return json(404, { detail: 'Not found.' });
      return new Response(SHIPBLU_PDF, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }
    m = /^\/v1\/delivery-orders\/(\d+)\/$/.exec(path);
    if (method === 'GET' && m) {
      const o = this.orders.get(Number(m[1]));
      return o ? json(200, this.view(o)) : json(404, { detail: 'Not found.' });
    }
    m = /^\/v1\/pricing\/orders\/(delivery)\/$/.exec(path);
    if (method === 'POST' && m) {
      if (!Number.isInteger(body?.to_governorate) || !Array.isArray(body?.packages)) {
        return json(400, { to_governorate: ['This field is required.'] });
      }
      return json(200, {
        subtotal: this.price,
        insurance_fees: 0,
        vat: 0,
        postal_tax: 0,
        total: this.price,
      });
    }
    return json(404, { detail: `stub: no route ${method} ${path}` });
  };

  private view(o: ShipbluOrder) {
    const events = o.events.map((e, i) => ({
      id: i + 1,
      status: e.status,
      created: e.created,
      comment: null,
      current_warehouse: { id: 1, code: 'CAI', name: 'Cairo hub' },
    }));
    if (this.historyOrder === 'desc') events.reverse();
    return {
      id: o.id,
      tracking_number: o.tracking_number,
      merchant_order_reference: o.merchant_order_reference,
      status: o.status,
      cash_amount: o.cash_amount ?? 0,
      tracking_events: events,
    };
  }

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private setStatus(o: ShipbluOrder, status: string) {
    o.status = status;
    o.events.push({ status, created: this.tick() });
  }

  orderByTracking(t: string): ShipbluOrder | undefined {
    return [...this.orders.values()].find(o => o.tracking_number === t);
  }

  advance(trackingNumber: string, status: ShipmentStatus) {
    this.advanceRaw(trackingNumber, STATUS_FOR[status]);
  }

  /** Move an order to a raw ShipBlu status string (any of the 32). */
  advanceRaw(trackingNumber: string, shipbluStatus: string) {
    const o = this.orderByTracking(trackingNumber);
    if (!o) throw new Error(`stub: unknown order ${trackingNumber}`);
    this.setStatus(o, shipbluStatus);
  }

  injectNextCall(fault: StubFault) {
    this.faults.injectNextCall(fault);
  }
}
