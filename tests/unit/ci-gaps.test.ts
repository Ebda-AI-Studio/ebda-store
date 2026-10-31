/**
 * CI-13: the outcome events CI-9 said the stream lacked (payment failure, cart recovery, onboarding), the
 * real shipping fee, the metrics for them, and per-store auto-gating. Privacy: no phone, no provider text.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  planCartRecovered,
  planCartReminder,
  planOnboardingStep,
  planPaymentFailed,
} from '../../apps/api/src/lib/ci/planner';
import { buildEnvelope } from '../../apps/api/src/lib/ci/port';
import { parseEnvelope } from '../../apps/api/src/lib/ci/envelope';
import {
  ANY,
  emptyCells,
  feeBucket,
  feeBucketLowerMinor,
  foldStoreDay,
  mergeCells,
} from '../../apps/api/src/lib/ci/aggregate/cells';
import {
  evaluateStoreGates,
  type CalibrationRow,
} from '../../apps/api/src/lib/ci/hints/calibration';
import type { CiSource } from '../../apps/api/src/lib/ci/source';

const SECRET = 'p'.repeat(40);
const STORE = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const OTHER = '9b2f4c1e-0c2e-4c3a-8a4e-0a9c6d7e1f20';
const ORDER = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6aa';
const CART = '5c1d3a22-7b41-4d0e-9b53-1f6a2d9c8e11';
const at = (s: string) => new Date(`2026-11-03T${s}Z`);
// buildEnvelope stamps `recordedAt` from the wall clock (a 13-digit number that can contain any short digit run, e.g. the
// card fragment '4111'), so every privacy scan below pins the clock AND drops the id/time fields before serialising: only
// fields that could carry buyer or provider text are searched.
const NOW = new Date('2026-11-03T10:00:01Z');
const scanable = (e: Awaited<ReturnType<typeof buildEnvelope>>) => {
  const { eventId: _id, recordedAt: _r, occurredAt: _o, ...rest } = e;
  return JSON.stringify(rest);
};

const orderFacts = (over: Record<string, unknown> = {}) => ({
  id: ORDER,
  storeId: STORE,
  totalMinor: 90000,
  shippingMinor: 6000,
  currency: 'EGP',
  channel: 'web',
  status: 'pending',
  paymentStatus: 'failed',
  createdAt: at('10:00:00'),
  itemCount: 1,
  phoneE164: '+201001234567',
  area: { areaKey: 'EG-C-nasr-city', level: 'district' },
  payments: [
    {
      id: 'pay-1',
      provider: 'kashier',
      method: 'card',
      status: 'failed',
      paidAt: null,
      failureReason: 'Card 4111 1111 1111 1111 declined for Ahmed Ali',
    },
  ],
  transitions: [],
  shipment: null,
  ciSharing: true,
  ...over,
});
function src(over: Partial<Record<keyof CiSource, unknown>> = {}) {
  return {
    order: vi.fn(async () => orderFacts()),
    shipment: vi.fn(async () => null),
    hasWhatsAppCodOutcome: vi.fn(async () => false),
    priorOrdersByBuyer: vi.fn(async () => 0),
    stampOrder: vi.fn(async () => undefined),
    storeCiSharing: vi.fn(async () => true),
    abandonedCart: vi.fn(async () => null),
    storeSetup: vi.fn(async () => null),
    ...over,
  } as unknown as CiSource;
}
const ctx = (source: CiSource) => ({ source, secret: SECRET });

describe('payment.failed', () => {
  it('carries a closed failure code, never the provider text, and the buyer key not the phone', async () => {
    const out = await planPaymentFailed(ctx(src()), {
      storeId: STORE,
      orderId: ORDER,
      paymentId: 'pay-1',
      kind: 'failed',
      at: '2026-11-03T10:05:00Z',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'payment.failed',
      seed: 'payment-failed:pay-1',
      xstore: true,
      data: { provider: 'kashier', methodKind: 'card', totalMinor: 90000, failureCode: 'declined' },
    });
    const wire = scanable(await buildEnvelope(out[0]!, 'store', NOW));
    expect(wire).not.toContain('4111');
    expect(wire).not.toContain('Ahmed');
    expect(wire).not.toContain('1001234567');
  });

  it('maps expired / cancelled, and anything unknown to declined', async () => {
    const code = async (kind: string) =>
      (
        await planPaymentFailed(ctx(src()), {
          storeId: STORE,
          orderId: ORDER,
          paymentId: 'pay-1',
          kind,
        })
      )[0]!.data as { failureCode: string };
    expect((await code('expired')).failureCode).toBe('expired');
    expect((await code('cancelled')).failureCode).toBe('cancelled');
    expect((await code('weird')).failureCode).toBe('declined');
  });

  it('the same payment always yields the same event id (a webhook replay is harmless)', async () => {
    const e = { storeId: STORE, orderId: ORDER, paymentId: 'pay-1', kind: 'failed' };
    const a = await buildEnvelope((await planPaymentFailed(ctx(src()), e))[0]!);
    const b = await buildEnvelope((await planPaymentFailed(ctx(src()), e))[0]!);
    expect(a.eventId).toBe(b.eventId);
  });

  it('retries (throws) while the order is not visible, ignores an event without ids', async () => {
    await expect(
      planPaymentFailed(ctx(src({ order: vi.fn(async () => null) })), {
        storeId: STORE,
        orderId: ORDER,
        paymentId: 'pay-1',
      })
    ).rejects.toThrow(/not visible/);
    expect(await planPaymentFailed(ctx(src()), { storeId: STORE })).toEqual([]);
  });
});

describe('cart events', () => {
  it('a reminder is order-less, has NO buyer key, and follows the store opt-in', async () => {
    const out = await planCartReminder(ctx(src()), {
      storeId: STORE,
      abandonedCartId: CART,
      channel: 'email',
      step: 1,
    });
    expect(out[0]).toMatchObject({
      type: 'cart.abandoned',
      orderId: null,
      buyerKey: null,
      xstore: true,
      data: { channel: 'email', step: 1 },
    });
    const env = await buildEnvelope(out[0]!, 'store', NOW);
    expect(env.orderId).toBeNull();
    expect(scanable(env)).not.toMatch(/email@|\+20/);
  });

  it('every step and channel is its own event; an unknown channel is "notification"', async () => {
    const seeds = new Set<string>();
    for (const [channel, step] of [
      ['email', 1],
      ['notification', 1],
      ['notification', 2],
      ['notification', 3],
      ['sms', 3],
    ] as const) {
      const o = await planCartReminder(ctx(src()), {
        storeId: STORE,
        abandonedCartId: CART,
        channel,
        step,
      });
      seeds.add(o[0]!.seed);
    }
    expect(seeds.size).toBe(4); // sms collapses into notification step 3
  });

  it('recovered needs a reminder first, measures hours from the FIRST one, uses the order buyer key', async () => {
    const reminded = {
      id: CART,
      firstReminderAt: at('08:00:00'),
      firstChannel: 'email',
      recoveredAt: at('14:30:00'),
    };
    const out = await planCartRecovered(ctx(src({ abandonedCart: vi.fn(async () => reminded) })), {
      storeId: STORE,
      abandonedCartId: CART,
      orderId: ORDER,
    });
    expect(out[0]).toMatchObject({
      type: 'cart.recovered',
      seed: `cart:${CART}:recovered`,
      data: { channel: 'email', hoursToRecover: 6.5 },
    });
    expect(out[0]!.buyerKey).toMatch(/^[0-9a-f]{64}$/);

    const never = { ...reminded, firstReminderAt: null, firstChannel: null };
    expect(
      await planCartRecovered(ctx(src({ abandonedCart: vi.fn(async () => never) })), {
        storeId: STORE,
        abandonedCartId: CART,
        orderId: ORDER,
      })
    ).toEqual([]);
  });
});

describe('merchant.onboarding_step', () => {
  const setup = { ownerSignupAt: at('09:00:00'), template: 'qamar', ciSharing: false };
  it('is order-less and key-less, with seconds since signup and the template', async () => {
    const out = await planOnboardingStep(ctx(src({ storeSetup: vi.fn(async () => setup) })), {
      storeId: STORE,
      step: 'went_live',
      at: '2026-11-03T09:10:00Z',
    });
    expect(out[0]).toMatchObject({
      type: 'merchant.onboarding_step',
      orderId: null,
      buyerKey: null,
      xstore: false,
      seed: `onboarding:${STORE}:went_live`,
      data: { step: 'went_live', secondsSinceSignup: 600, template: 'qamar' },
    });
  });
  it('refuses an unknown step; throws while the store is not visible', async () => {
    expect(
      await planOnboardingStep(ctx(src({ storeSetup: vi.fn(async () => setup) })), {
        storeId: STORE,
        step: 'whatever',
      })
    ).toEqual([]);
    await expect(
      planOnboardingStep(ctx(src()), { storeId: STORE, step: 'went_live' })
    ).rejects.toThrow(/not visible/);
  });
});

describe('envelope: orderId is null ONLY for order-less types', () => {
  const base = {
    v: 1,
    eventId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    occurredAt: 1,
    recordedAt: 2,
    product: 'store',
    storeId: STORE,
    xstore: false,
    buyerKey: null,
    keyVersion: 1,
  };
  it('accepts null for cart.abandoned and onboarding, rejects it for the rest', () => {
    expect(() =>
      parseEnvelope({
        ...base,
        type: 'cart.abandoned',
        orderId: null,
        data: { channel: 'email', step: 1 },
      })
    ).not.toThrow();
    expect(() =>
      parseEnvelope({
        ...base,
        type: 'payment.failed',
        orderId: null,
        data: { provider: 'k', methodKind: 'card', totalMinor: 1, failureCode: 'declined' },
      })
    ).toThrow(/needs an orderId/);
  });
  it('rejects an order id on an order-less type, a free-text failure code, and extra keys', () => {
    expect(() =>
      parseEnvelope({
        ...base,
        type: 'cart.abandoned',
        orderId: ORDER,
        data: { channel: 'email', step: 1 },
      })
    ).toThrow(/carries no orderId/);
    expect(() =>
      parseEnvelope({
        ...base,
        type: 'payment.failed',
        orderId: ORDER,
        data: { provider: 'k', methodKind: 'card', totalMinor: 1, failureCode: 'Card declined' },
      })
    ).toThrow();
    expect(() =>
      parseEnvelope({
        ...base,
        type: 'merchant.onboarding_step',
        orderId: null,
        data: { step: 'went_live', secondsSinceSignup: 1, template: null, email: 'a@b.co' },
      })
    ).toThrow();
  });
});

describe('metrics', () => {
  const env = (type: string, data: unknown, over: Record<string, unknown> = {}, n = 0) =>
    ({
      v: 1,
      eventId: `${n}`.padStart(26, '0'),
      occurredAt: Date.parse('2026-11-03T10:00:00Z'),
      recordedAt: Date.parse('2026-11-03T10:00:00Z'),
      product: 'store',
      storeId: STORE,
      xstore: true,
      orderId: ORDER,
      buyerKey: null,
      keyVersion: 1,
      type,
      data,
      ...over,
    }) as never;
  const fold = (events: unknown[]) => foldStoreDay(STORE, '2026-11-03', events as never[]).own;

  it('feeBucket edges', () => {
    expect([0, 1, 4_999, 5_000, 7_499, 7_500, 9_999, 10_000].map(feeBucket)).toEqual([
      'f0',
      'f1',
      'f1',
      'f2',
      'f2',
      'f3',
      'f3',
      'f4',
    ]);
    expect(feeBucketLowerMinor('f0')).toBe(0);
    expect(feeBucketLowerMinor('f3')).toBe(7_500);
  });

  it('shipping-fee cells count only COD shipments that carry the fee; older events are skipped, not "free"', () => {
    const d = (fee: number | null | undefined, returned: boolean, n: number) =>
      env(
        returned ? 'shipment.returned' : 'shipment.delivered',
        {
          carrier: 'bosta',
          codMinor: 50_000,
          hoursSincePickup: 5,
          attempts: 1,
          ...(returned ? { returnReasonCode: 'other', returnReasonRaw: null } : {}),
          ...(fee === undefined ? {} : { shippingFeeMinor: fee }),
        },
        {},
        n
      );
    const cells = fold([
      d(9_000, true, 1),
      d(9_000, false, 2),
      d(null, true, 3),
      d(undefined, true, 4),
    ]);
    expect(cells.return_by_shipping_fee['f3']).toMatchObject({ n: 2, hit: 1 });
    expect(cells.return_by_shipping_fee[ANY]).toMatchObject({ n: 2, hit: 1 });
    expect(cells.return_by_shipping_fee['f0']).toBeUndefined();
  });

  it('payment_failure: failed vs captured per provider; COD never counts', () => {
    const cap = (provider: string, n: number) =>
      env(
        'payment.captured',
        { provider, methodKind: 'card', totalMinor: 1, failureCode: null },
        {},
        n
      );
    const bad = (provider: string, n: number) =>
      env(
        'payment.failed',
        { provider, methodKind: 'card', totalMinor: 1, failureCode: 'declined' },
        {},
        n
      );
    const cells = fold([
      cap('kashier', 1),
      cap('kashier', 2),
      bad('kashier', 3),
      bad('cod', 4),
      cap('cod', 5),
    ]);
    expect(cells.payment_failure['kashier']).toMatchObject({ n: 3, hit: 1 });
    expect(cells.payment_failure[ANY]).toMatchObject({ n: 3, hit: 1 });
    expect(cells.payment_failure['cod']).toBeUndefined();
  });

  it('onboarding_step: one count per step, sum = seconds since signup', () => {
    const o = (step: string, secs: number | null, n: number) =>
      env(
        'merchant.onboarding_step',
        { step, secondsSinceSignup: secs, template: 'qamar' },
        { orderId: null },
        n
      );
    const cells = fold([
      o('store_created', 60, 1),
      o('store_created', 120, 2),
      o('went_live', 3600, 3),
    ]);
    expect(cells.onboarding_step['store_created']).toMatchObject({ n: 2, hit: 2, sum: 180 });
    expect(cells.onboarding_step['went_live']).toMatchObject({ n: 1, sum: 3600 });
  });

  it('cart_recovery: step 1 opens the denominator, recovered adds the hit and hours without a second count', () => {
    const a = (channel: string, step: number, n: number) =>
      env('cart.abandoned', { channel, step }, { orderId: null }, n);
    const r = (channel: string, hours: number, n: number) =>
      env('cart.recovered', { channel, hoursToRecover: hours }, {}, n);
    const cells = fold([
      a('email', 1, 1),
      a('email', 1, 2),
      a('notification', 1, 3),
      a('notification', 2, 4),
      r('email', 5, 5),
    ]);
    expect(cells.cart_recovery['email']).toMatchObject({ n: 2, hit: 1, sum: 5 });
    expect(cells.cart_recovery['notification']).toMatchObject({ n: 1, hit: 0 });
    expect(cells.cart_recovery[ANY]).toMatchObject({ n: 3, hit: 1 });
  });

  it('a day file written before the new metrics merges cleanly (replay of old data)', () => {
    const old = emptyCells();
    delete (old as Record<string, unknown>)['payment_failure'];
    delete (old as Record<string, unknown>)['cart_recovery'];
    const into = emptyCells();
    expect(() => mergeCells(into, old)).not.toThrow();
    expect(into.payment_failure).toEqual({});
  });
});

describe('evaluateStoreGates (per-store auto-gating)', () => {
  const row = (over: Partial<CalibrationRow> = {}): CalibrationRow => ({
    storeId: STORE,
    feature: 'cod_risk',
    band: 'elevated',
    resolved: 40,
    returned: 8, // actual 20%
    predictedSum: 40 * 0.4, // predicted 40%
    ...over,
  });
  it('closes the feature when ITS OWN band is more than 10 points off with >= 30 resolved', () => {
    const [v] = evaluateStoreGates([row()]);
    expect(v).toMatchObject({ feature: 'cod_risk', off: true, band: 'elevated', resolved: 40 });
    expect(v!.predicted).toBeCloseTo(0.4);
    expect(v!.actual).toBeCloseTo(0.2);
  });
  it('does not close on exactly 10 points, under 30 resolved, or an insufficient band', () => {
    expect(evaluateStoreGates([row({ returned: 12, predictedSum: 40 * 0.4 })])[0]!.off).toBe(false);
    expect(
      evaluateStoreGates([row({ resolved: 29, returned: 1, predictedSum: 29 * 0.9 })])[0]!.off
    ).toBe(false);
    expect(evaluateStoreGates([row({ band: 'insufficient' })])[0]!.off).toBe(false);
  });
  it('needs NO cohort (a single store is enough), and keeps the worst band as the reason', () => {
    const v = evaluateStoreGates([
      row({ band: 'typical', returned: 14, predictedSum: 40 * 0.1 }), // 35% vs 10% -> 25 pts
      row({ band: 'elevated' }), // 20 pts
    ])[0]!;
    expect(v).toMatchObject({ off: true, band: 'typical' });
  });
  it("refuses rows from two stores: one store's data can never close another's gate", () => {
    expect(() => evaluateStoreGates([row(), row({ storeId: OTHER })])).toThrow(
      /more than one store/
    );
  });
});
