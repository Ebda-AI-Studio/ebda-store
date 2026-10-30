/** Source events -> commerce_outcomes inputs: the events in the CI-1 list, the WhatsApp carve-out, privacy. */
import { describe, expect, it, vi } from 'vitest';
import {
  planOrderCreated,
  planOrderStatusChanged,
  planShipmentBooked,
  planShipmentUpdated,
} from '../../apps/api/src/lib/ci/planner';
import { buildEnvelope } from '../../apps/api/src/lib/ci/port';
import type { CiOrderFacts, CiShipmentFacts, CiSource } from '../../apps/api/src/lib/ci/source';
import { buyerKeyFor } from '@ebda/shared';

const SECRET = 'p'.repeat(40); // built at runtime: a literal looks like a key to gitleaks
const STORE = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const ORDER = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6aa';
const SHIP = '9b2f4c1e-0c2e-4c3a-8a4e-0a9c6d7e1f20';
const PHONE = '+201001234567';
const at = (s: string) => new Date(`2026-11-03T${s}Z`);

function order(over: Partial<CiOrderFacts> = {}): CiOrderFacts {
  return {
    id: ORDER,
    storeId: STORE,
    totalMinor: 150000,
    shippingMinor: 6000,
    currency: 'EGP',
    channel: 'web',
    status: 'pending',
    paymentStatus: 'unpaid',
    createdAt: at('10:00:00'),
    itemCount: 2,
    phoneE164: PHONE,
    area: { areaKey: 'EG-C-nasr-city', level: 'district' },
    payments: [
      {
        id: 'p1',
        provider: 'cod',
        method: null,
        status: 'cod_pending',
        paidAt: null,
        failureReason: null,
      },
    ],
    transitions: [],
    shipment: null,
    ciSharing: false,
    ...over,
  };
}
function shipment(over: Partial<CiShipmentFacts> = {}): CiShipmentFacts {
  return {
    id: SHIP,
    orderId: ORDER,
    carrier: 'bosta',
    codMinor: 150000,
    createdAt: at('11:00:00'),
    pickedUpAt: at('13:00:00'),
    deliveredAt: null,
    returnedAt: null,
    deliveryAttempts: 0,
    createAttempts: 1,
    weightGrams: 500,
    areaKey: 'EG-C-nasr-city',
    returnReasonCode: null,
    returnReasonRaw: null,
    ...over,
  };
}
function src(
  o: CiOrderFacts | null,
  s: CiShipmentFacts | null = null,
  wa = false
): CiSource & Record<string, ReturnType<typeof vi.fn>> {
  return {
    order: vi.fn(async () => o),
    shipment: vi.fn(async () => s),
    hasWhatsAppCodOutcome: vi.fn(async () => wa),
    priorOrdersByBuyer: vi.fn(async () => 0),
    stampOrder: vi.fn(async () => undefined),
    storeCiSharing: vi.fn(async () => false),
    abandonedCart: vi.fn(async () => null),
    storeSetup: vi.fn(async () => null),
  } as never;
}
const ctx = (s: CiSource) => ({ source: s, secret: SECRET });
const types = (xs: Array<{ type: string }>) => xs.map(x => x.type);

describe('order.placed', () => {
  it('emits placed with the buyerKey (never the phone), stamps the order, flags the first order', async () => {
    const s = src(order());
    const out = await planOrderCreated(ctx(s), { storeId: STORE, orderId: ORDER });
    expect(types(out)).toEqual(['order.placed']);
    const key = await buyerKeyFor(SECRET, PHONE);
    expect(out[0]!.buyerKey).toBe(key);
    expect(out[0]!.data).toMatchObject({
      totalMinor: 150000,
      paymentMethod: 'cod',
      areaKey: 'EG-C-nasr-city',
      isFirstOrderForBuyerInStore: true,
    });
    expect(s.stampOrder).toHaveBeenCalledWith(STORE, ORDER, {
      areaKey: 'EG-C-nasr-city',
      buyerKey: key,
    });
    const wire = JSON.stringify(await Promise.all(out.map(i => buildEnvelope(i))));
    expect(wire).not.toContain('01001234567');
    expect(wire).not.toContain('1001234567');
  });

  it('a repeat buyer is not "first"; no phone = null key and null first-flag (never invented)', async () => {
    const s = src(order());
    (s.priorOrdersByBuyer as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    const again = await planOrderCreated(ctx(s), { storeId: STORE, orderId: ORDER });
    expect(
      (again[0]!.data as { isFirstOrderForBuyerInStore: boolean }).isFirstOrderForBuyerInStore
    ).toBe(false);
    const noPhone = await planOrderCreated(ctx(src(order({ phoneE164: null }))), {
      storeId: STORE,
      orderId: ORDER,
    });
    expect(noPhone[0]!.buyerKey).toBeNull();
    expect(
      (noPhone[0]!.data as { isFirstOrderForBuyerInStore: unknown }).isFirstOrderForBuyerInStore
    ).toBeNull();
  });

  it('an online-paid order also emits payment.captured; the xstore flag follows the store opt-in', async () => {
    const paid = order({
      paymentStatus: 'paid',
      ciSharing: true,
      payments: [
        {
          provider: 'paymob',
          method: 'card',
          status: 'completed',
          paidAt: at('10:01:00'),
          failureReason: null,
        },
      ],
    });
    const out = await planOrderCreated(ctx(src(paid)), { storeId: STORE, orderId: ORDER });
    expect(types(out)).toEqual(['order.placed', 'payment.captured']);
    expect(out.every(o => o.xstore)).toBe(true);
    expect(out[1]!.data).toMatchObject({
      provider: 'paymob',
      methodKind: 'card',
      totalMinor: 150000,
    });
  });

  it('retries (throws) while the order is not visible yet; ids are stable across re-sends', async () => {
    await expect(
      planOrderCreated(ctx(src(null)), { storeId: STORE, orderId: ORDER })
    ).rejects.toThrow(/not visible/);
    const a = await planOrderCreated(ctx(src(order())), { storeId: STORE, orderId: ORDER });
    const b = await planOrderCreated(ctx(src(order())), { storeId: STORE, orderId: ORDER });
    expect(a.map(x => x.seed)).toEqual(b.map(x => x.seed));
  });

  it('ignores an event without ids', async () => {
    expect(await planOrderCreated(ctx(src(order())), {})).toEqual([]);
  });
});

describe('order status changes', () => {
  it('manual COD confirmation -> cod_confirmed (via call) with minutes to confirm', async () => {
    const o = order({
      status: 'confirmed',
      transitions: [{ from: 'pending', to: 'confirmed', at: at('10:45:00'), actorId: 'u1' }],
    });
    const out = await planOrderStatusChanged(ctx(src(o)), {
      storeId: STORE,
      orderId: ORDER,
      status: 'confirmed',
    });
    expect(types(out)).toEqual(['order.cod_confirmed']);
    expect(out[0]!.data).toEqual({
      confirmedVia: 'call',
      minutesToConfirm: 45,
      areaKey: 'EG-C-nasr-city',
    });
  });

  it('a COD outcome that arrived from WhatsApp is NOT re-emitted (WhatsApp already did)', async () => {
    const confirmed = order({
      status: 'confirmed',
      transitions: [{ from: 'pending', to: 'confirmed', at: at('10:05:00'), actorId: null }],
    });
    expect(
      await planOrderStatusChanged(ctx(src(confirmed, null, true)), {
        storeId: STORE,
        orderId: ORDER,
        status: 'confirmed',
      })
    ).toEqual([]);
    const cancelled = order({
      status: 'cancelled',
      transitions: [{ from: 'pending', to: 'cancelled', at: at('10:05:00'), actorId: null }],
    });
    const out = await planOrderStatusChanged(ctx(src(cancelled, null, true)), {
      storeId: STORE,
      orderId: ORDER,
      status: 'cancelled',
    });
    // the cancellation itself is still the Store's outcome (attributed to the customer), the COD answer is not
    expect(types(out)).toEqual(['order.cancelled']);
    expect(out[0]!.data).toMatchObject({ reason: 'cod_refused', byActor: 'customer' });
  });

  it('a COD order cancelled before it was ever confirmed or picked up = cod_unconfirmed', async () => {
    const o = order({
      status: 'cancelled',
      transitions: [{ from: 'pending', to: 'cancelled', at: at('12:00:00'), actorId: 'u1' }],
    });
    const out = await planOrderStatusChanged(ctx(src(o)), {
      storeId: STORE,
      orderId: ORDER,
      status: 'cancelled',
    });
    expect(types(out)).toEqual(['order.cancelled', 'order.cod_unconfirmed']);
    expect(out[0]!.data).toMatchObject({ byActor: 'merchant' });
    expect(out[1]!.data).toEqual({
      confirmedVia: 'none',
      minutesToConfirm: null,
      areaKey: 'EG-C-nasr-city',
    });
  });

  it('confirmed-then-cancelled, and a returned parcel, are NOT "unconfirmed"', async () => {
    const wasConfirmed = order({
      status: 'cancelled',
      transitions: [
        { from: 'pending', to: 'confirmed', at: at('10:30:00'), actorId: 'u1' },
        { from: 'confirmed', to: 'cancelled', at: at('12:00:00'), actorId: 'u1' },
      ],
    });
    expect(
      types(
        await planOrderStatusChanged(ctx(src(wasConfirmed)), {
          storeId: STORE,
          orderId: ORDER,
          status: 'cancelled',
        })
      )
    ).toEqual(['order.cancelled']);
    const rts = order({
      status: 'cancelled',
      shipment: { pickedUpAt: at('13:00:00'), returnedAt: at('09:00:00') },
      transitions: [{ from: 'shipped', to: 'cancelled', at: at('14:00:00'), actorId: null }],
    });
    const out = await planOrderStatusChanged(ctx(src(rts)), {
      storeId: STORE,
      orderId: ORDER,
      status: 'cancelled',
    });
    expect(types(out)).toEqual(['order.cancelled']);
    expect(out[0]!.data).toMatchObject({ reason: 'returned_to_sender', byActor: 'system' });
  });

  it('refund emits order.refunded; a prepaid order does no COD events; paid status emits the capture once', async () => {
    const o = order({
      status: 'refunded',
      paymentStatus: 'paid',
      payments: [
        {
          provider: 'kashier',
          method: 'card',
          status: 'completed',
          paidAt: at('10:02:00'),
          failureReason: null,
        },
      ],
      transitions: [{ from: 'delivered', to: 'refunded', at: at('15:00:00'), actorId: 'u1' }],
    });
    const out = await planOrderStatusChanged(ctx(src(o)), {
      storeId: STORE,
      orderId: ORDER,
      status: 'refunded',
    });
    expect(types(out)).toEqual(['payment.captured', 'order.refunded']);
  });
});

describe('shipments', () => {
  it('shipment.created from the booking', async () => {
    const out = await planShipmentBooked(ctx(src(order(), shipment())), {
      storeId: STORE,
      shipmentId: SHIP,
    });
    expect(out[0]).toMatchObject({ type: 'shipment.created', seed: `shipment:${SHIP}` });
    expect(out[0]!.data).toEqual({
      carrier: 'bosta',
      codMinor: 150000,
      areaKey: 'EG-C-nasr-city',
      weightGrams: 500,
      attemptsToBook: 1,
    });
  });

  it('first-time marks become picked_up / attempted / delivered with hours and attempts', async () => {
    const s = shipment({ deliveredAt: at('20:00:00'), deliveryAttempts: 1 });
    const out = await planShipmentUpdated(ctx(src(order(), s)), {
      storeId: STORE,
      shipmentId: SHIP,
      ci: [
        { kind: 'picked_up', at: '2026-11-03T13:00:00Z' },
        {
          kind: 'attempted',
          at: '2026-11-03T16:00:00Z',
          attemptNo: 1,
          reasonRaw: 'Consignee not available',
        },
        { kind: 'delivered', at: '2026-11-03T20:00:00Z' },
      ],
    });
    expect(types(out)).toEqual(['shipment.picked_up', 'shipment.attempted', 'shipment.delivered']);
    expect(out[0]!.data).toEqual({ carrier: 'bosta', hoursSinceCreated: 2 });
    expect(out[1]!.data).toEqual({
      carrier: 'bosta',
      attemptNo: 1,
      reasonCode: 'customer_unreachable',
      areaKey: 'EG-C-nasr-city',
    });
    expect(out[2]!.data).toEqual({
      carrier: 'bosta',
      codMinor: 150000,
      hoursSincePickup: 7,
      attempts: 1,
      areaKey: 'EG-C-nasr-city',
      shippingFeeMinor: 6000, // the order's real shipping fee, not the COD amount (CI-13)
    });
    expect(new Set(out.map(o => o.seed)).size).toBe(3);
  });

  it('returned carries the closed reason code and the scrubbed raw text', async () => {
    const s = shipment({
      returnedAt: at('22:00:00'),
      deliveryAttempts: 2,
      returnReasonCode: 'customer_refused',
      returnReasonRaw: 'Consignee refused',
    });
    const out = await planShipmentUpdated(ctx(src(order(), s)), {
      storeId: STORE,
      shipmentId: SHIP,
      ci: [{ kind: 'returned', at: '2026-11-03T22:00:00Z', reasonRaw: 'Consignee refused' }],
    });
    expect(out[0]!.data).toEqual({
      carrier: 'bosta',
      codMinor: 150000,
      returnReasonCode: 'customer_refused',
      returnReasonRaw: 'Consignee refused',
      attempts: 2,
      hoursSincePickup: 9,
      areaKey: 'EG-C-nasr-city',
      shippingFeeMinor: 6000,
    });
  });

  it('no marks = nothing (a repeated poll with no new fact emits nothing)', async () => {
    expect(
      await planShipmentUpdated(ctx(src(order(), shipment())), {
        storeId: STORE,
        shipmentId: SHIP,
        ci: [],
      })
    ).toEqual([]);
  });
});
