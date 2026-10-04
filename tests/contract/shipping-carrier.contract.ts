/**
 * SHARED CONTRACT SUITE for shipping-carrier adapters (SP7).
 *
 * Any adapter (Bosta, Aramex, manual; J&T, Mylerz, ShipBlu later) calls
 * `runShippingCarrierContract(label, makeTarget)` from its own test file and gets the same
 * assertions, so "works with the order page, the retry job and COD reconciliation" means the
 * same thing for every carrier:
 *
 *   - createShipment idempotent on the merchant reference (one parcel at the carrier, however
 *     often it is retried, including after a lost response); a different reference is a new parcel
 *   - COD amount fidelity to the piastre (1, 29, 12345, 999999), converted at the edge and read
 *     back from the carrier's own record; non-integer / negative refused with nothing booked;
 *     a carrier whose COD currency is unconfirmed REFUSES COD, asserted, not skipped
 *   - cancel: a fresh parcel cancels; one the courier already has is `not_cancellable` (never
 *     reported cancelled); an unknown id is never reported cancelled
 *   - status mapping to the shared ShipmentStatus, from the poll AND from the webhook, whatever
 *     order the carrier returns its history in; garbage payloads are ignored
 *   - webhook auth by URL secret: the right token passes, wrong / empty / prefix / longer ones
 *     fail; a replayed delivery is a no-op; a late old event cannot move a shipment backwards
 *   - label and quote where declared (quote never silently converts a non-EGP price)
 *   - outage: timeout / unreachable is a retryable CARRIER_UNAVAILABLE that books nothing and a
 *     retry books exactly one parcel; a refusal is not an outage; bad credentials are typed
 *
 * Sections run against the adapter's declared `capabilities`.
 */
import { describe, it, expect } from 'vitest';
import {
  CarrierError,
  normalizeCancel,
  type CarrierCallContext,
  type CarrierShipmentRequest,
  type ShipmentStatus,
  type ShippingCarrierProvider,
} from '@api/services/carriers/types';
import { mergeTracking, verifyWebhookToken } from '@api/lib/shipment-tracking';

export interface ShippingContractControl {
  /** The carrier moves the parcel to `status` (the next poll / the next webhook shows it). */
  advance(trackingNumber: string, status: ShipmentStatus): void;
  /** The delivery the carrier would POST to the callback URL (webhook carriers). */
  webhookBody?(trackingNumber: string, status: ShipmentStatus, timestamp: Date): unknown;
  /** The courier collects the parcel: cancel must now be refused. */
  pickUp(trackingNumber: string): void;
  /** The order the carrier lists tracking events in. */
  setHistoryOrder(order: 'asc' | 'desc'): void;
  injectNextCall(fault: 'timeout' | 'unavailable' | 'rejected'): void;
  /** Parcels the carrier side holds (the "no state change" probe). */
  parcelCount(): number;
  /** What the carrier recorded as COD for a parcel, as integer piastres. */
  recordedCodMinor(trackingNumber: string): number;
  /** The carrier rejects the merchant's credentials from now on. */
  rejectCredentials(): void;
  /** Make the rate endpoint answer in a currency other than EGP. */
  quoteInForeignCurrency?(): void;
}

export interface ShippingContractTarget {
  carrier: ShippingCarrierProvider;
  credentials: unknown;
  /** Per-call context for COD-capable calls (e.g. Aramex's "COD in EGP confirmed" switch). */
  ctx?: CarrierCallContext;
  /** Context when the merchant has NOT confirmed COD (carriers with `cod: 'unconfirmed'`). */
  ctxCodUnconfirmed?: CarrierCallContext;
  /** Absent for adapters with no network (manual). */
  control?: ShippingContractControl;
  /** Statuses this carrier can report (default: every ShipmentStatus but `created`). */
  reportable?: ShipmentStatus[];
  /** A request body the manual carrier needs. */
  manual?: { carrierName: string; trackingNumber: string };
}

let seq = 0;
export function shipmentRequest(
  overrides: Partial<CarrierShipmentRequest> = {}
): CarrierShipmentRequest {
  const n = ++seq;
  const ref = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    orderId: ref,
    orderNumber: `ORD-${1000 + n}`,
    merchantReference: ref,
    pickupAddress: {
      name: 'Amelia Store',
      phone: '+201000000001',
      line1: '12 Tahrir St',
      city: 'Cairo',
      state: 'Cairo',
      country: 'EG',
    },
    deliveryAddress: {
      name: 'Mona Adel',
      phone: '+201012345678',
      email: 'mona@example.com',
      line1: '5 Nile Corniche',
      city: 'Giza',
      state: 'Giza',
      area: 'Dokki',
      country: 'EG',
    },
    items: [{ name: 'Linen shirt', quantity: 2, sku: 'LS-1', value: 25000 }],
    weight: 0.8,
    ...overrides,
  };
}

const ALL: ShipmentStatus[] = [
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned',
  'cancelled',
];

export function runShippingCarrierContract(
  label: string,
  makeTarget: () => ShippingContractTarget
) {
  describe(`shipping carrier contract: ${label}`, () => {
    const make = () => {
      const t = makeTarget();
      const book = (o: Partial<CarrierShipmentRequest> = {}, ctx = t.ctx) =>
        t.carrier.createShipment(
          t.credentials,
          shipmentRequest({
            manual: t.manual ? { ...t.manual, trackingNumber: `MAN${++seq}` } : undefined,
            ...o,
          }),
          ctx
        );
      return { t, book };
    };

    it('declares its capabilities', () => {
      const { t } = make();
      const c = t.carrier.capabilities;
      expect(typeof c.quote).toBe('boolean');
      expect(typeof c.label).toBe('boolean');
      expect(typeof c.webhooks).toBe('boolean');
      expect(typeof c.polling).toBe('boolean');
      expect([true, false, 'unconfirmed']).toContain(c.cod);
      expect(!!t.carrier.quote).toBe(c.quote);
      expect(!!t.carrier.getLabel).toBe(c.label);
    });

    describe('createShipment', () => {
      it('returns a carrier id and a tracking number', async () => {
        const { book } = make();
        const r = await book();
        expect(r.carrierShipmentId).toBeTruthy();
        expect(r.trackingNumber).toBeTruthy();
      });

      it('is idempotent on the merchant reference: one parcel however often it is retried', async () => {
        const { t, book } = make();
        const req = shipmentRequest();
        const manual = t.manual ? { ...t.manual, trackingNumber: 'MAN-IDEM' } : undefined;
        const a = await t.carrier.createShipment(t.credentials, { ...req, manual }, t.ctx);
        const b = await t.carrier.createShipment(t.credentials, { ...req, manual }, t.ctx);
        expect(b.carrierShipmentId).toBe(a.carrierShipmentId);
        expect(b.trackingNumber).toBe(a.trackingNumber);
        if (t.control) expect(t.control.parcelCount()).toBe(1);
        // a DIFFERENT reference is a new parcel
        const c = await book();
        expect(c.carrierShipmentId).not.toBe(a.carrierShipmentId);
        if (t.control) expect(t.control.parcelCount()).toBe(2);
      });

      it('a retry after a lost response books no second parcel', async () => {
        const { t } = make();
        if (!t.control) return; // nothing at a carrier to duplicate
        const req = shipmentRequest();
        t.control.injectNextCall('unavailable');
        await expect(t.carrier.createShipment(t.credentials, req, t.ctx)).rejects.toMatchObject({
          code: 'CARRIER_UNAVAILABLE',
        });
        expect(t.control.parcelCount()).toBe(0);
        const r = await t.carrier.createShipment(t.credentials, req, t.ctx);
        expect(r.trackingNumber).toBeTruthy();
        expect(t.control.parcelCount()).toBe(1);
      });
    });

    describe('COD amount fidelity (piastres)', () => {
      const amounts = [1, 29, 100, 12345, 999999];

      it.each(amounts)('%i piastres reaches the carrier as exactly %i piastres', async piastres => {
        const { t, book } = make();
        if (t.carrier.capabilities.cod === false) return;
        const r = await book({ codAmount: piastres });
        if (t.control) expect(t.control.recordedCodMinor(r.trackingNumber)).toBe(piastres);
        expect(r.trackingNumber).toBeTruthy();
      });

      it('no COD is recorded as zero', async () => {
        const { t, book } = make();
        const r = await book();
        if (t.control) expect(t.control.recordedCodMinor(r.trackingNumber)).toBe(0);
      });

      it.each([12.5, -100, Number.NaN, 1e21])(
        'refuses %s as a COD amount and books nothing',
        async bad => {
          const { t, book } = make();
          if (t.carrier.capabilities.cod === false) return;
          await expect(book({ codAmount: bad })).rejects.toBeInstanceOf(CarrierError);
          if (t.control) expect(t.control.parcelCount()).toBe(0);
        }
      );

      it('a carrier that cannot confirm COD in EGP refuses COD, books nothing, and still ships prepaid', async () => {
        const { t, book } = make();
        if (t.carrier.capabilities.cod !== 'unconfirmed') return;
        await expect(book({ codAmount: 12345 }, t.ctxCodUnconfirmed)).rejects.toMatchObject({
          code: 'COD_NOT_SUPPORTED',
        });
        if (t.control) expect(t.control.parcelCount()).toBe(0);
        const prepaid = await book({}, t.ctxCodUnconfirmed);
        expect(prepaid.trackingNumber).toBeTruthy();
        if (t.control) expect(t.control.recordedCodMinor(prepaid.trackingNumber)).toBe(0);
      });

      it('a carrier with no COD at all refuses it', async () => {
        const { t, book } = make();
        if (t.carrier.capabilities.cod !== false) return;
        await expect(book({ codAmount: 5000 })).rejects.toMatchObject({
          code: 'COD_NOT_SUPPORTED',
        });
      });
    });

    describe('cancel', () => {
      it('cancels a fresh parcel', async () => {
        const { t, book } = make();
        const r = await book();
        const out = normalizeCancel(
          await t.carrier.cancelShipment(t.credentials, r.carrierShipmentId, t.ctx)
        );
        expect(out.status).toBe('cancelled');
      });

      it('refuses (not_cancellable) once the courier has it, and never reports it cancelled', async () => {
        const { t, book } = make();
        if (!t.control) return;
        const r = await book();
        t.control.pickUp(r.trackingNumber);
        const out = normalizeCancel(
          await t.carrier.cancelShipment(t.credentials, r.carrierShipmentId, t.ctx)
        );
        expect(out.status).not.toBe('cancelled');
        expect(['not_cancellable', 'failed']).toContain(out.status);
      });

      it('never reports an unknown id as cancelled', async () => {
        const { t } = make();
        if (!t.control) return;
        const out = normalizeCancel(
          await t.carrier.cancelShipment(t.credentials, 'does-not-exist', t.ctx)
        );
        expect(out.status).not.toBe('cancelled');
      });
    });

    describe('tracking: status mapping', () => {
      it.each(ALL)('maps the carrier state for %s', async status => {
        const { t, book } = make();
        if (!t.control || !t.carrier.capabilities.polling) return;
        if (t.reportable && !t.reportable.includes(status)) return;
        const r = await book();
        t.control.advance(r.trackingNumber, status);
        const tracking = await t.carrier.trackShipment(t.credentials, r.trackingNumber, t.ctx);
        expect(tracking.status).toBe(status);
      });

      it.each(['asc', 'desc'] as const)(
        'the newest event is the status and history is oldest-first, however the carrier orders it (%s)',
        async order => {
          const { t, book } = make();
          if (!t.control || !t.carrier.capabilities.polling) return;
          t.control.setHistoryOrder(order);
          const r = await book();
          t.control.advance(r.trackingNumber, 'picked_up');
          t.control.advance(r.trackingNumber, 'in_transit');
          t.control.advance(r.trackingNumber, 'out_for_delivery');
          const tracking = await t.carrier.trackShipment(t.credentials, r.trackingNumber, t.ctx);
          expect(tracking.status).toBe('out_for_delivery');
          const times = tracking.statusHistory.map(h => h.timestamp.getTime());
          expect([...times].sort((a, b) => a - b)).toEqual(times);
          expect(tracking.statusHistory.at(-1)?.status).toBe('out_for_delivery');
        }
      );

      it('a manual carrier has nothing to poll', async () => {
        const { t } = make();
        if (t.carrier.capabilities.polling) return;
        await expect(t.carrier.trackShipment(t.credentials, 'X', t.ctx)).rejects.toBeInstanceOf(
          CarrierError
        );
      });
    });

    describe('webhook', () => {
      it.each(ALL)('parses a delivery for %s into the shared status', async status => {
        const { t, book } = make();
        if (!t.carrier.capabilities.webhooks || !t.control?.webhookBody) return;
        if (t.reportable && !t.reportable.includes(status)) return;
        const r = await book();
        const ts = new Date('2026-10-06T10:00:00Z');
        const parsed = t.carrier.processWebhook(
          t.control.webhookBody(r.trackingNumber, status, ts),
          {}
        );
        expect(parsed).toMatchObject({ trackingNumber: r.trackingNumber, status });
        expect(parsed?.timestamp.toISOString()).toBe(ts.toISOString());
      });

      it('ignores garbage and unrelated payloads', () => {
        const { t } = make();
        for (const junk of [
          null,
          undefined,
          'x',
          42,
          [],
          {},
          { hello: 'world' },
          { trackingNumber: 'T' },
        ]) {
          expect(t.carrier.processWebhook(junk as unknown, {})).toBeNull();
        }
      });

      it('authenticates by the secret in the URL: only the exact token passes', () => {
        const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
        expect(verifyWebhookToken(secret, secret)).toBe(true);
        for (const bad of ['', 'wrong', secret.slice(0, -1), `${secret}x`, secret.toUpperCase()]) {
          expect(verifyWebhookToken(secret, bad)).toBe(false);
        }
        // a store with no secret configured accepts nothing, not even an empty token
        expect(verifyWebhookToken(undefined, '')).toBe(false);
        expect(verifyWebhookToken('', '')).toBe(false);
      });

      it('a replayed delivery is a no-op, and a late old event cannot move the shipment back', async () => {
        const { t, book } = make();
        if (!t.carrier.capabilities.webhooks || !t.control?.webhookBody) return;
        const r = await book();
        const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, s));
        const parse = (status: ShipmentStatus, ts: Date) => {
          const p = t.carrier.processWebhook(
            t.control!.webhookBody!(r.trackingNumber, status, ts),
            {}
          );
          if (!p) throw new Error('webhook not parsed');
          return { status: p.status, timestamp: p.timestamp };
        };
        let state = { history: [] as any[], status: 'created' };
        const apply = (e: { status: ShipmentStatus; timestamp: Date }) => {
          const m = mergeTracking({
            history: state.history,
            currentStatus: state.status,
            events: [e],
          });
          state = { history: m.history, status: m.status };
          return m.added;
        };
        expect(apply(parse('out_for_delivery', at(30)))).toBe(1);
        // the same delivery again (Bosta retried, or a proxy replayed it): nothing changes
        const before = JSON.stringify(state);
        expect(apply(parse('out_for_delivery', at(30)))).toBe(0);
        expect(JSON.stringify(state)).toBe(before);
        // an OLDER event arriving late is recorded in order but does not change the status
        expect(apply(parse('picked_up', at(10)))).toBe(1);
        expect(state.status).toBe('out_for_delivery');
        expect(state.history.map(h => h.status)).toEqual(['picked_up', 'out_for_delivery']);
        // delivered closes it, and a stray in-flight event after that does not reopen it
        expect(apply(parse('delivered', at(60)))).toBe(1);
        expect(apply(parse('in_transit', at(90)))).toBe(1);
        expect(state.status).toBe('delivered');
      });
    });

    describe('label', () => {
      it('returns a hosted URL or PDF bytes', async () => {
        const { t, book } = make();
        if (!t.carrier.capabilities.label || !t.carrier.getLabel) return;
        const r = await book();
        const label = await t.carrier.getLabel(t.credentials, r, t.ctx);
        expect(Boolean(label.url) || Boolean(label.pdfBase64)).toBe(true);
      });
    });

    describe('quote', () => {
      it('returns integer piastres from the carrier', async () => {
        const { t } = make();
        if (!t.carrier.capabilities.quote || !t.carrier.quote) return;
        const q = await t.carrier.quote(
          t.credentials,
          {
            pickupAddress: shipmentRequest().pickupAddress,
            deliveryAddress: shipmentRequest().deliveryAddress,
            weight: 1,
          },
          t.ctx
        );
        expect(Number.isSafeInteger(q.amountPiastres)).toBe(true);
        expect(q.amountPiastres).toBeGreaterThan(0);
        expect(q.source).toBe('api');
      });

      it('never converts a quote in another currency into piastres', async () => {
        const { t } = make();
        if (!t.carrier.capabilities.quote || !t.carrier.quote || !t.control?.quoteInForeignCurrency)
          return;
        t.control.quoteInForeignCurrency();
        await expect(
          t.carrier.quote(
            t.credentials,
            {
              pickupAddress: shipmentRequest().pickupAddress,
              deliveryAddress: shipmentRequest().deliveryAddress,
            },
            t.ctx
          )
        ).rejects.toBeInstanceOf(CarrierError);
      });
    });

    describe('outage and refusals', () => {
      it.each(['timeout', 'unavailable'] as const)(
        'a %s is a retryable CARRIER_UNAVAILABLE that books nothing',
        async fault => {
          const { t, book } = make();
          if (!t.control) return;
          t.control.injectNextCall(fault);
          const err = await book().catch(e => e);
          expect(err).toBeInstanceOf(CarrierError);
          expect(err.code).toBe('CARRIER_UNAVAILABLE');
          expect(err.retryable).toBe(true);
          expect(t.control.parcelCount()).toBe(0);
        }
      );

      it('a refusal is not an outage', async () => {
        const { t, book } = make();
        if (!t.control) return;
        t.control.injectNextCall('rejected');
        const err = await book().catch(e => e);
        expect(err).toBeInstanceOf(CarrierError);
        expect(err.code).toBe('CARRIER_REJECTED');
        expect(err.retryable).toBe(false);
        expect(t.control.parcelCount()).toBe(0);
      });

      it('bad credentials are CARRIER_MISCONFIGURED, not an outage', async () => {
        const { t, book } = make();
        if (!t.control) return;
        t.control.rejectCredentials();
        const err = await book().catch(e => e);
        expect(err).toBeInstanceOf(CarrierError);
        expect(err.code).toBe('CARRIER_MISCONFIGURED');
        expect(err.retryable).toBe(false);
      });

      it('testConnection reports bad credentials as a failed test, never a throw', async () => {
        const { t } = make();
        if (!t.control) return;
        t.control.rejectCredentials();
        const out = await t.carrier.testConnection(t.credentials, t.ctx);
        expect(out.success).toBe(false);
        expect(out.error).toBeTruthy();
      });
    });
  });
}
