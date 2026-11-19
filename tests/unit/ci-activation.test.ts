/**
 * Merchant activation milestones (Ruling ACT-1): first_order, first_fulfilled_order, the onboarding-help signal, the per-store
 * activation file and the funnel medians. Planner tests run on the real activation rules with a stubbed CiSource.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  planActivationMilestones,
  planOnboardingHelp,
  planOrderStatusChanged,
  planShipmentUpdated,
} from '../../apps/api/src/lib/ci/planner';
import { activationOf, openStep } from '../../apps/api/src/lib/ci/activation';
import { buildEnvelope } from '../../apps/api/src/lib/ci/port';
import { parseEnvelope, type CiEnvelope } from '../../apps/api/src/lib/ci/envelope';
import {
  foldActivation,
  funnelOf,
  median,
  viewOf,
} from '../../apps/api/src/lib/ci/aggregate/activation-file';
import type { CiSource } from '../../apps/api/src/lib/ci/source';

const SECRET = 'p'.repeat(40);
const STORE = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const OWNER = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const O1 = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f601';
const O2 = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f602';
const SHIP = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6aa';
const at = (s: string) => new Date(`2026-11-03T${s}Z`);

interface OrderOver {
  id?: string;
  source?: string;
  status?: string;
  paymentStatus?: string;
  cod?: boolean;
  paidAt?: Date | null;
  createdAt?: Date;
  transitions?: Array<{ from: string | null; to: string; at: Date; actorId: string | null }>;
  deliveredAt?: Date | null;
}
function inputs(o: OrderOver = {}) {
  return {
    id: o.id ?? O1,
    source: o.source ?? 'web',
    status: o.status ?? 'confirmed',
    paymentStatus: o.paymentStatus ?? 'paid',
    createdAt: o.createdAt ?? at('10:00:00'),
    payments: [
      {
        provider: o.cod ? 'cod' : 'kashier',
        status: isPaid(o) ? 'completed' : 'pending',
        paidAt: o.paidAt === undefined ? (isPaid(o) ? at('10:01:00') : null) : o.paidAt,
      },
    ],
    transitions: o.transitions ?? [],
    shipmentDeliveredAt: o.deliveredAt ?? null,
  };
}
const act = (o: OrderOver = {}) => activationOf(inputs(o));
const isPaid = (o: OrderOver) => (o.paymentStatus ?? 'paid') === 'paid';
const facts = (o: OrderOver = {}) => ({
  id: o.id ?? O1,
  storeId: STORE,
  totalMinor: 90000,
  shippingMinor: 0,
  currency: 'EGP',
  channel: o.source ?? 'web',
  status: o.status ?? 'confirmed',
  paymentStatus: o.paymentStatus ?? 'paid',
  createdAt: o.createdAt ?? at('10:00:00'),
  itemCount: 1,
  phoneE164: null,
  area: { areaKey: null, level: 'none' },
  payments: inputs(o).payments.map((p, i) => ({
    ...p,
    id: `p${i}`,
    method: null,
    failureReason: null,
  })),
  transitions: o.transitions ?? [],
  shipment: o.deliveredAt
    ? { pickedUpAt: null, returnedAt: null, deliveredAt: o.deliveredAt }
    : null,
  activation: act(o),
  ciSharing: false,
});
const setup = (over: Record<string, unknown> = {}) => ({
  ownerSignupAt: at('09:00:00'),
  template: 'qamar',
  ciSharing: false,
  ownerId: OWNER,
  isDemo: false,
  ...over,
});
function src(over: Partial<Record<keyof CiSource, unknown>> = {}) {
  return {
    order: vi.fn(async () => facts()),
    shipment: vi.fn(async () => ({
      id: SHIP,
      orderId: O1,
      carrier: 'bosta',
      codMinor: 0,
      createdAt: at('10:05:00'),
      pickedUpAt: at('11:00:00'),
      deliveredAt: at('12:00:00'),
      returnedAt: null,
      deliveryAttempts: 1,
      createAttempts: 1,
      weightGrams: null,
      areaKey: null,
      returnReasonCode: null,
      returnReasonRaw: null,
    })),
    hasWhatsAppCodOutcome: vi.fn(async () => false),
    priorOrdersByBuyer: vi.fn(async () => 0),
    stampOrder: vi.fn(async () => undefined),
    storeCiSharing: vi.fn(async () => false),
    abandonedCart: vi.fn(async () => null),
    storeSetup: vi.fn(async () => setup()),
    activationPeers: vi.fn(async () => []),
    onboardingProgress: vi.fn(async () => null),
    ...over,
  } as unknown as CiSource;
}
const ctx = (source: CiSource) => ({ source, secret: SECRET });
const steps = (out: Array<{ data: unknown }>) => out.map(o => (o.data as { step: string }).step);

describe('first_order', () => {
  it('is recorded for the first paid order, with channel and the order id, once per store (seed has no order id)', async () => {
    const out = await planActivationMilestones(ctx(src()), facts() as never, ['first_order']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'merchant.onboarding_step',
      seed: `onboarding:${STORE}:first_order`,
      orderId: null,
      buyerKey: null,
      occurredAt: at('10:01:00'),
      data: { step: 'first_order', channel: 'storefront', orderId: O1, secondsSinceSignup: 3660 },
    });
  });

  it('a second order does not re-emit: an earlier real order is among its peers', async () => {
    const first = act({ id: O1, paidAt: at('10:01:00') });
    const out = await planActivationMilestones(
      ctx(src({ activationPeers: vi.fn(async () => [first]) })),
      facts({ id: O2, createdAt: at('11:00:00'), paidAt: at('11:01:00') }) as never,
      ['first_order']
    );
    expect(out).toEqual([]);
  });

  it('an earlier-created order that only qualifies later does not block a sooner-paid one', async () => {
    const codLater = act({
      id: O1,
      cod: true,
      paymentStatus: 'unpaid',
      status: 'confirmed',
      transitions: [{ from: 'pending', to: 'confirmed', at: at('15:00:00'), actorId: null }],
    });
    const out = await planActivationMilestones(
      ctx(src({ activationPeers: vi.fn(async () => [codLater]) })),
      facts({ id: O2, createdAt: at('11:00:00'), paidAt: at('11:01:00') }) as never,
      ['first_order']
    );
    expect(steps(out)).toEqual(['first_order']);
  });

  it('is not emitted for an unpaid order, or a COD order nobody confirmed', async () => {
    const unpaid = facts({ paymentStatus: 'unpaid', status: 'pending', paidAt: null });
    const cod = facts({ paymentStatus: 'unpaid', status: 'pending', cod: true, paidAt: null });
    expect(await planActivationMilestones(ctx(src()), unpaid as never, ['first_order'])).toEqual(
      []
    );
    expect(await planActivationMilestones(ctx(src()), cod as never, ['first_order'])).toEqual([]);
  });

  it('a COD order counts from the moment it was confirmed', async () => {
    const cod = facts({
      cod: true,
      paymentStatus: 'unpaid',
      status: 'confirmed',
      transitions: [{ from: 'pending', to: 'confirmed', at: at('12:30:00'), actorId: STAFF }],
    });
    const out = await planActivationMilestones(ctx(src()), cod as never, ['first_order']);
    expect(out[0]).toMatchObject({ occurredAt: at('12:30:00') });
  });

  it('excludes orders placed from the admin by staff or a super admin, and a demo store', async () => {
    const staffOrder = facts({
      transitions: [{ from: null, to: 'stock_not_taken', at: at('10:00:00'), actorId: STAFF }],
    });
    expect(
      await planActivationMilestones(ctx(src()), staffOrder as never, ['first_order'])
    ).toEqual([]);
    expect(
      await planActivationMilestones(
        ctx(src({ storeSetup: vi.fn(async () => setup({ isDemo: true })) })),
        facts() as never,
        ['first_order']
      )
    ).toEqual([]);
  });

  it('sets the channel: whatsapp, and admin for the OWNER keying an order in', async () => {
    const wa = await planActivationMilestones(ctx(src()), facts({ source: 'whatsapp' }) as never, [
      'first_order',
    ]);
    expect((wa[0]!.data as { channel: string }).channel).toBe('whatsapp');
    const own = facts({
      transitions: [{ from: null, to: 'stock_not_taken', at: at('10:00:00'), actorId: OWNER }],
    });
    const admin = await planActivationMilestones(ctx(src()), own as never, ['first_order']);
    expect((admin[0]!.data as { channel: string }).channel).toBe('admin');
  });

  it('rides the existing paths: order/status-changed to confirmed emits it next to the COD outcome', async () => {
    const cod = facts({
      cod: true,
      paymentStatus: 'unpaid',
      status: 'confirmed',
      transitions: [{ from: 'pending', to: 'confirmed', at: at('12:30:00'), actorId: STAFF }],
    });
    const out = await planOrderStatusChanged(ctx(src({ order: vi.fn(async () => cod) })), {
      storeId: STORE,
      orderId: O1,
      status: 'confirmed',
    });
    expect(out.map(o => o.type).sort()).toEqual([
      'merchant.onboarding_step',
      'order.cod_confirmed',
    ]);
  });
});

describe('first_fulfilled_order', () => {
  const delivered = { deliveredAt: at('12:00:00'), status: 'delivered' };

  it('is recorded when the first real order is delivered, once (an earlier delivered peer blocks it)', async () => {
    const out = await planActivationMilestones(ctx(src()), facts(delivered) as never, [
      'first_fulfilled_order',
    ]);
    expect(out[0]).toMatchObject({
      seed: `onboarding:${STORE}:first_fulfilled_order`,
      occurredAt: at('12:00:00'),
      data: { step: 'first_fulfilled_order', orderId: O1, channel: null },
    });
    const earlier = act({
      id: O2,
      ...delivered,
      deliveredAt: at('09:30:00'),
      createdAt: at('08:00:00'),
    });
    expect(
      await planActivationMilestones(
        ctx(src({ activationPeers: vi.fn(async () => [earlier]) })),
        facts(delivered) as never,
        ['first_fulfilled_order']
      )
    ).toEqual([]);
  });

  it('a delivered order with no shipment (pickup, digital) counts through its status transition', async () => {
    const pickup = facts({
      status: 'delivered',
      transitions: [{ from: 'shipped', to: 'delivered', at: at('13:00:00'), actorId: OWNER }],
    });
    const out = await planActivationMilestones(ctx(src()), pickup as never, [
      'first_fulfilled_order',
    ]);
    expect(out[0]).toMatchObject({ occurredAt: at('13:00:00') });
  });

  it('a staff-placed delivered order never counts', async () => {
    const staff = facts({
      ...delivered,
      transitions: [{ from: null, to: 'stock_not_taken', at: at('10:00:00'), actorId: STAFF }],
    });
    expect(
      await planActivationMilestones(ctx(src()), staff as never, ['first_fulfilled_order'])
    ).toEqual([]);
  });

  it('the shipment-delivered path emits it next to shipment.delivered', async () => {
    const out = await planShipmentUpdated(
      ctx(src({ order: vi.fn(async () => facts(delivered)) })),
      { storeId: STORE, shipmentId: SHIP, ci: [{ kind: 'delivered', at: '2026-11-03T12:00:00Z' }] }
    );
    expect(out.map(o => o.type)).toContain('shipment.delivered');
    expect(steps(out.filter(o => o.type === 'merchant.onboarding_step'))).toEqual([
      'first_order',
      'first_fulfilled_order',
    ]);
  });
});

describe('onboarding help', () => {
  const progress = (over: Record<string, unknown> = {}) => ({
    ownerId: OWNER,
    isDemo: false,
    createdAt: at('09:00:00'),
    live: false,
    paymentConfirmed: false,
    hasFirstOrder: false,
    hasFirstFulfilled: false,
    ...over,
  });
  const plan = (p: unknown, kind = 'assistant_used', atIso = '2026-11-03T09:30:00Z') =>
    planOnboardingHelp(ctx(src({ onboardingProgress: vi.fn(async () => p) })), {
      storeId: STORE,
      kind,
      at: atIso,
    });

  it('names the FIRST milestone not yet reached at that moment', () => {
    const base = {
      storeAgeDays: 1,
      paymentConfirmed: true,
      live: true,
      hasFirstOrder: true,
      hasFirstFulfilled: true,
    };
    expect(
      openStep({
        ...base,
        paymentConfirmed: false,
        live: false,
        hasFirstOrder: false,
        hasFirstFulfilled: false,
      })
    ).toBe('payment_methods');
    expect(openStep({ ...base, live: false, hasFirstOrder: false, hasFirstFulfilled: false })).toBe(
      'went_live'
    );
    expect(openStep({ ...base, hasFirstOrder: false, hasFirstFulfilled: false })).toBe(
      'first_order'
    );
    expect(openStep({ ...base, hasFirstFulfilled: false })).toBe('first_fulfilled_order');
    expect(openStep(base)).toBeNull();
    expect(openStep({ ...base, storeAgeDays: 45, hasFirstOrder: false })).toBeNull();
  });

  it('attributes an assistant use to the step that was open, one row per (store, step, kind)', async () => {
    const a = await plan(progress());
    expect(a[0]).toMatchObject({
      type: 'merchant.onboarding_help',
      orderId: null,
      buyerKey: null,
      seed: `onboarding-help:${STORE}:payment_methods:assistant_used`,
      data: { step: 'payment_methods', kind: 'assistant_used' },
    });
    const b = await plan(progress({ paymentConfirmed: true, live: true }));
    expect((b[0]!.data as { step: string }).step).toBe('first_order');
  });

  it('a super admin write counts only before the store is live; an established or demo store gives nothing', async () => {
    expect(await plan(progress({ paymentConfirmed: true }), 'super_admin_action')).toHaveLength(1);
    expect(
      await plan(progress({ paymentConfirmed: true, live: true }), 'super_admin_action')
    ).toEqual([]);
    expect(await plan(progress(), 'assistant_used', '2026-12-30T00:00:00Z')).toEqual([]);
    expect(await plan(progress({ isDemo: true }))).toEqual([]);
    // support_contact (the in-product Contact Ebda Store request) is a real kind with a write path
    expect(await plan(progress(), 'support_contact')).toHaveLength(1);
  });

  it('the wire envelopes are strict and carry only ids, closed codes and numbers', async () => {
    const step = await planActivationMilestones(ctx(src()), facts() as never, ['first_order']);
    const help = await plan(progress());
    for (const input of [...step, ...help]) {
      const env = await buildEnvelope(input, 'store', new Date('2026-11-03T10:00:01Z'));
      expect(parseEnvelope(JSON.parse(JSON.stringify(env)))).toEqual(env);
    }
    const good = await buildEnvelope(help[0]!, 'store', new Date('2026-11-03T10:00:01Z'));
    // an unknown kind is refused, and so is an extra key (strict).
    expect(() =>
      parseEnvelope({ ...good, data: { step: 'went_live', kind: 'phone_call' } })
    ).toThrow();
    expect(() =>
      parseEnvelope({ ...good, data: { ...good.data, phone: '01001234567' } })
    ).toThrow();
  });
});

// ---------------------------------------------------------------- activation file + funnel

const T0 = Date.parse('2026-11-03T09:00:00Z');
let n = 0;
function ev(
  type: string,
  atMs: number,
  data: Record<string, unknown>,
  orderId: string | null = null
): CiEnvelope {
  n += 1;
  return {
    v: 1,
    eventId: `01H${String(n).padStart(23, '0')}`.slice(0, 26),
    type,
    occurredAt: atMs,
    recordedAt: atMs,
    product: 'store',
    storeId: STORE,
    xstore: false,
    orderId,
    buyerKey: null,
    keyVersion: 1,
    data,
  } as unknown as CiEnvelope;
}
const step = (s: string, atMs: number, extra: Record<string, unknown> = {}) =>
  ev('merchant.onboarding_step', atMs, {
    step: s,
    secondsSinceSignup: Math.round((atMs - T0) / 1000),
    template: null,
    ...extra,
  });

describe('activation file', () => {
  const events = [
    step('store_created', T0 + 60_000),
    step('payment_methods', T0 + 600_000),
    ev('merchant.onboarding_help', T0 + 300_000, {
      step: 'payment_methods',
      kind: 'assistant_used',
    }),
    step('went_live', T0 + 3_600_000),
    step('first_order', T0 + 7_200_000, { channel: 'whatsapp', orderId: O1 }),
    ev(
      'order.placed',
      T0 + 7_100_000,
      {
        totalMinor: 1,
        currency: 'EGP',
        paymentMethod: 'cod',
        channel: 'whatsapp',
        itemCount: 1,
        areaKey: null,
        isFirstOrderForBuyerInStore: null,
      },
      O1
    ),
    ev(
      'shipment.created',
      T0 + 7_500_000,
      { carrier: 'bosta', codMinor: 0, areaKey: null, weightGrams: null, attemptsToBook: 1 },
      O1
    ),
  ];

  it('folds milestones, help and the first order trail; replaying the same events changes nothing', () => {
    const once = foldActivation(null, STORE, events);
    expect(foldActivation(once, STORE, events)).toEqual(once);
    expect(foldActivation(null, STORE, [...events].reverse())).toEqual(once);
    const v = viewOf(once, STORE);
    expect(v.signupAt).toBe(T0);
    expect(v.steps.map(s => [s.step, s.secondsFromSignup, s.helpNeeded])).toEqual([
      ['store_created', 60, false],
      ['payment_methods', 600, true],
      ['went_live', 3600, false],
      ['first_order', 7200, false],
      ['first_fulfilled_order', null, false],
    ]);
    expect(v.firstOrderChannel).toBe('whatsapp');
    expect(v.lastFact).toEqual({ fact: 'booked', at: T0 + 7_500_000 });
  });

  it('a delivered store has no stopped-order fact; a payment failure with no order yet is the last fact', () => {
    const done = foldActivation(null, STORE, [
      ...events,
      step('first_fulfilled_order', T0 + 9_000_000, { orderId: O1 }),
    ]);
    expect(viewOf(done, STORE).lastFact).toBeNull();
    const failed = foldActivation(null, STORE, [
      step('store_created', T0 + 60_000),
      ev(
        'payment.failed',
        T0 + 1_000_000,
        { provider: 'kashier', methodKind: 'card', totalMinor: 1, failureCode: 'declined' },
        O2
      ),
    ]);
    expect(viewOf(failed, STORE).lastFact).toEqual({ fact: 'payment_failed', at: T0 + 1_000_000 });
  });

  it('keeps at most 10 order trails', () => {
    const many = Array.from({ length: 10 + 5 }, (_, i) =>
      ev(
        'order.placed',
        T0 + i * 1000,
        {
          totalMinor: 1,
          currency: 'EGP',
          paymentMethod: 'cod',
          channel: 'web',
          itemCount: 1,
          areaKey: null,
          isFirstOrderForBuyerInStore: null,
        },
        `0d8ea0f4-5a47-4c7d-9a49-${String(i).padStart(12, '0')}`
      )
    );
    expect(Object.keys(foldActivation(null, STORE, many).trail)).toHaveLength(10);
  });
});

describe('funnel', () => {
  it('median is exact for odd and even counts', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('counts and medians per step over the signup range, on fixtures', () => {
    const mk = (
      id: string,
      signup: number,
      secs: Partial<Record<string, number>>,
      help = false
    ) => {
      const evs: CiEnvelope[] = Object.entries(secs).map(([s, sec]) => {
        const e = step(s, signup + sec! * 1000);
        return {
          ...e,
          storeId: id,
          data: { ...(e.data as object), secondsSinceSignup: sec },
        } as CiEnvelope;
      });
      if (help)
        evs.push({
          ...ev('merchant.onboarding_help', signup + 1000, {
            step: 'went_live',
            kind: 'super_admin_action',
          }),
          storeId: id,
        } as CiEnvelope);
      return viewOf(foldActivation(null, id, evs), id);
    };
    const views = [
      mk('a', T0, { store_created: 60, payment_methods: 600, went_live: 1200, first_order: 4000 }),
      mk('b', T0 + 1000, { store_created: 60, payment_methods: 1800, went_live: 3000 }, true),
      mk('c', T0 + 2000, { store_created: 120 }),
      mk('late', T0 + 40 * 86_400_000, { store_created: 60, first_order: 100 }),
    ];
    const rows = funnelOf(views, T0 - 1, T0 + 86_400_000);
    const by = Object.fromEntries(rows.map(r => [r.step, r]));
    expect(by.store_created).toMatchObject({ count: 3, medianSecondsFromSignup: 60 });
    expect(by.payment_methods).toMatchObject({ count: 2, medianSecondsFromSignup: 1200 });
    expect(by.went_live).toMatchObject({ count: 2, medianSecondsFromSignup: 2100, helpStores: 1 });
    expect(by.first_order).toMatchObject({ count: 1, medianSecondsFromSignup: 4000 });
    expect(by.first_fulfilled_order).toMatchObject({ count: 0, medianSecondsFromSignup: null });
  });
});
