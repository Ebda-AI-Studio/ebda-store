/**
 * A local stand-in for Bosta's REST API (SP7). No real keys, no network: the adapter is given
 * `stub.fetch` as its transport. Shapes follow the adapter's own `UNVERIFIED:` guesses (the real
 * API could not be read), so this stub proves the adapter's behaviour, not Bosta's.
 *
 * Deliberately NOT idempotent on create: Bosta has no idempotency header, so the adapter's own
 * look-up-by-reference is what must keep a retry from booking a second parcel.
 */
import crypto from 'node:crypto';
import type { ShipmentStatus } from '@api/services/carriers/types';
import { FaultGate, json, headerOf, type StubFault } from './stub-common';
import { egpToPiastres } from '@api/lib/carrier-http';

export const BOSTA_STUB = { baseUrl: 'http://bosta.stub/api/v2', apiKey: 'bosta-test-key' };

const CODE_FOR: Record<ShipmentStatus, number> = {
  created: 10,
  picked_up: 20,
  in_transit: 30,
  out_for_delivery: 41,
  delivered: 45,
  failed: 47,
  returned: 46,
  cancelled: 48,
};

export interface BostaParcel {
  id: string;
  trackingNumber: string;
  businessReference: string;
  /** What the adapter sent, verbatim (EGP decimal). */
  codSent: number;
  /** The same, as the stub reads it: integer piastres. */
  codMinor: number;
  webhookUrl?: string;
  state: number;
  events: Array<{ code: number; date: string }>;
}

export class BostaStub {
  readonly faults = new FaultGate();
  readonly parcels = new Map<string, BostaParcel>();
  readonly requests: Array<{ method: string; path: string }> = [];
  /** The order the tracking timeline is returned in. */
  historyOrder: 'asc' | 'desc' = 'desc';
  /** The price the rate endpoint answers (EGP). */
  price = 45.5;
  rejectAuth = false;
  private clock = Date.parse('2026-10-05T08:00:00Z');

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = u.pathname.replace('/api/v2', '');
    this.requests.push({ method, path });
    const early = await this.faults.enter();
    if (early) return early;
    if (this.rejectAuth || headerOf(init, 'authorization') !== BOSTA_STUB.apiKey) {
      return json(401, { message: 'Unauthorized' });
    }

    if (method === 'POST' && path === '/deliveries') {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
      const trackingNumber = `BST${String(this.parcels.size + 1).padStart(8, '0')}`;
      const cod = Number(body.cod ?? 0);
      const parcel: BostaParcel = {
        id,
        trackingNumber,
        businessReference: String(body.businessReference ?? ''),
        codSent: cod,
        codMinor: egpToPiastres(String(cod)),
        webhookUrl: body.webhookUrl,
        state: 10,
        events: [{ code: 10, date: this.tick() }],
      };
      this.parcels.set(id, parcel);
      return json(201, { message: 'Delivery created', data: { _id: id, trackingNumber } });
    }
    if (method === 'GET' && path === '/deliveries/search') {
      const ref = u.searchParams.get('businessReference');
      const hits = [...this.parcels.values()].filter(p => p.businessReference === ref);
      return json(200, {
        deliveries: hits.map(p => ({
          _id: p.id,
          trackingNumber: p.trackingNumber,
          businessReference: p.businessReference,
        })),
      });
    }
    if (method === 'GET' && path === '/deliveries') return json(200, { deliveries: [] });
    if (method === 'GET' && path === '/pricing/calculator') {
      return json(200, { data: { priceAfterVat: this.price } });
    }
    let m = /^\/deliveries\/awb\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      if (!this.parcels.has(m[1])) return json(404, { message: 'not found' });
      return json(200, { data: Buffer.from('%PDF-1.4 stub awb').toString('base64') });
    }
    m = /^\/deliveries\/business\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      const p = [...this.parcels.values()].find(x => x.trackingNumber === m![1]);
      if (!p) return json(404, { message: 'not found' });
      const details = p.events.map(e => ({
        state: { code: e.code },
        date: e.date,
        hub: 'Cairo hub',
        description: `state ${e.code}`,
      }));
      if (this.historyOrder === 'desc') details.reverse();
      return json(200, { data: { state: { code: p.state }, trackingDetails: details } });
    }
    m = /^\/deliveries\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && m) {
      const p = this.parcels.get(m[1]);
      if (!p) return json(404, { message: 'not found' });
      if (p.state >= 20)
        return json(400, { message: 'Delivery already picked up, cannot terminate' });
      this.setState(p, 48);
      return json(200, { message: 'Delivery terminated' });
    }
    return json(404, { message: `stub: no route ${method} ${path}` });
  };

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private setState(p: BostaParcel, code: number, date?: string) {
    p.state = code;
    p.events.push({ code, date: date ?? this.tick() });
  }

  parcelByTracking(t: string): BostaParcel | undefined {
    return [...this.parcels.values()].find(p => p.trackingNumber === t);
  }

  advance(trackingNumber: string, status: ShipmentStatus) {
    const p = this.parcelByTracking(trackingNumber);
    if (!p) throw new Error(`stub: unknown parcel ${trackingNumber}`);
    this.setState(p, CODE_FOR[status]);
  }

  /** The body Bosta would POST to the callback URL. */
  webhookBody(trackingNumber: string, status: ShipmentStatus, timestamp: Date) {
    const p = this.parcelByTracking(trackingNumber);
    return {
      _id: p?.id,
      trackingNumber,
      state: { code: CODE_FOR[status] },
      businessReference: p?.businessReference,
      timestamp: timestamp.toISOString(),
    };
  }

  injectNextCall(fault: StubFault) {
    this.faults.injectNextCall(fault);
  }
}
