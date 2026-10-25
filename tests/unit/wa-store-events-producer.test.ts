/**
 * Store -> Ebda WhatsApp producer (contract 2026-10-24 section 4): the events, their envelope, the
 * buyer key, idempotent ids, and the "not linked / no phone: send nothing" rules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: vi.fn(),
  linked: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: { order: { findUnique: h.order } },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/wa/link', () => ({ isWhatsAppLinked: h.linked }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { storeEventSchema } from '@api/contracts/ebda-wa-v1';
import {
  contractPaymentMethod,
  emitStoreEventsFor,
} from '@api/lib/inngest/functions/wa-store-events';
import { assertWhatsAppLinkConfig, suiteBuyerKeySecret } from '@api/lib/wa/config';
import { deterministicEventId } from '@api/lib/wa/events';

const SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
const STORE = '11111111-1111-4111-8111-111111111111';
const ORDER = {
  orderNumber: '1001',
  total: 75_050,
  currency: 'EGP',
  shippingAddress: { phone: '01001234567' },
  locale: 'ar',
  source: 'web',
  createdAt: new Date('2026-10-25T10:00:00Z'),
};

beforeEach(() => {
  process.env.SUITE_BUYER_KEY_SECRET = SECRET;
  h.order.mockReset().mockResolvedValue(ORDER);
  h.linked.mockReset().mockResolvedValue(true);
  h.send.mockReset().mockResolvedValue(undefined);
  clearCfBindings();
  setCfBindings({ HYPERDRIVE: { connectionString: 'x' }, WA_EVENTS_QUEUE: { send: h.send } });
});

const sent = () =>
  h.send.mock.calls.map(c => c[0] as { type: string; id: string; data: Record<string, unknown> });

describe('order/created', () => {
  const ev = (paymentMethod: string) => ({
    id: 'src-1',
    name: 'order/created',
    data: { orderId: 'o1', storeId: STORE, paymentMethod, locale: 'ar' },
  });

  it('a COD order emits order.created AND the COD confirmation request, both valid envelopes', async () => {
    expect(await emitStoreEventsFor(ev('cod'))).toBe(2);
    const [created, cod] = sent();
    for (const e of sent()) expect(storeEventSchema.safeParse(e).success).toBe(true);
    expect(created).toMatchObject({
      type: 'order.created',
      v: 1,
      storeId: STORE,
      data: {
        orderId: 'o1',
        orderNumber: '1001',
        phoneE164: '+201001234567',
        totalMinor: 75_050,
        currency: 'EGP',
        paymentMethod: 'cod',
        channel: 'web',
      },
    });
    expect(created!.data.buyerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(cod).toMatchObject({
      type: 'order.cod_confirmation_requested',
      data: { orderId: 'o1', orderNumber: '1001', totalMinor: 75_050, currency: 'EGP' },
    });
    // 24 h after the order was placed
    expect(cod!.data.deadlineAt).toBe('2026-10-26T10:00:00.000Z');
    expect(cod!.data.buyerKey).toBe(created!.data.buyerKey);
  });

  it('a prepaid order emits only order.created, with the gateway mapped to the contract enum', async () => {
    expect(await emitStoreEventsFor(ev('paymob'))).toBe(1);
    expect(sent()[0]).toMatchObject({ type: 'order.created', data: { paymentMethod: 'card' } });
  });

  it('a retry of the same source event sends the SAME envelope ids (consumers dedupe on id)', async () => {
    await emitStoreEventsFor(ev('cod'));
    const first = sent().map(e => e.id);
    h.send.mockClear();
    await emitStoreEventsFor(ev('cod'));
    expect(sent().map(e => e.id)).toEqual(first);
    expect(new Set(first).size).toBe(2); // ...and the two event types differ
  });

  it('a store that has not linked WhatsApp sends nothing and reads no order', async () => {
    h.linked.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev('cod'))).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.order).not.toHaveBeenCalled();
  });

  it.each([
    ['no phone', { phone: '' }],
    ['a junk phone', { phone: 'call me' }],
  ])('%s: nothing is sent (never invent a number or a key)', async (_n, addr) => {
    h.order.mockResolvedValue({ ...ORDER, shippingAddress: addr });
    expect(await emitStoreEventsFor(ev('cod'))).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('an enqueue failure throws so the job retries (fail fast, never a silent drop)', async () => {
    h.send.mockRejectedValue(new Error('queue down'));
    await expect(emitStoreEventsFor(ev('cod'))).rejects.toThrow('queue down');
  });

  it('refuses to run without the suite secret', async () => {
    delete process.env.SUITE_BUYER_KEY_SECRET;
    await expect(emitStoreEventsFor(ev('cod'))).rejects.toThrow(/SUITE_BUYER_KEY_SECRET/);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('order/status-changed and shipment/status-updated', () => {
  it('emits order.status_changed', async () => {
    await emitStoreEventsFor({
      id: 's2',
      name: 'order/status-changed',
      data: { orderId: 'o1', storeId: STORE, status: 'cancelled' },
    });
    expect(sent()[0]).toMatchObject({
      type: 'order.status_changed',
      data: { orderId: 'o1', status: 'cancelled' },
    });
  });

  it('emits shipment.updated with the phone and tracking link when known, and drops a non-http link', async () => {
    const base = { orderId: 'o1', storeId: STORE, shipmentId: 'sh1', status: 'out_for_delivery' };
    await emitStoreEventsFor({
      id: 's3',
      name: 'shipment/status-updated',
      data: { ...base, trackingUrl: 'https://track.test/1' },
    });
    expect(sent()[0]).toMatchObject({
      type: 'shipment.updated',
      data: {
        shipmentId: 'sh1',
        status: 'out_for_delivery',
        trackingUrl: 'https://track.test/1',
        phoneE164: '+201001234567',
        orderNumber: '1001',
        locale: 'ar',
      },
    });
    h.send.mockClear();
    await emitStoreEventsFor({
      id: 's4',
      name: 'shipment/status-updated',
      data: { ...base, trackingUrl: 'javascript:alert(1)' },
    });
    expect(sent()[0]!.data).not.toHaveProperty('trackingUrl');
    expect(storeEventSchema.safeParse(sent()[0]).success).toBe(true);
  });
});

describe('helpers', () => {
  it.each([
    ['cod', 'cod'],
    ['COD', 'cod'],
    ['wallet', 'wallet'],
    ['instapay', 'instapay'],
    ['paymob', 'card'],
    [undefined, 'card'],
  ])('payment method %s -> %s', (raw, out) => {
    expect(contractPaymentMethod(raw)).toBe(out);
  });

  it('deterministicEventId is a stable v4-shaped uuid', async () => {
    const a = await deterministicEventId('x');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await deterministicEventId('x')).toBe(a);
    expect(await deterministicEventId('y')).not.toBe(a);
  });

  it('boot guard: the WhatsApp queue bound without the secret throws; unbound is fine', () => {
    delete process.env.SUITE_BUYER_KEY_SECRET;
    expect(() => assertWhatsAppLinkConfig({ HYPERDRIVE: { connectionString: 'x' } })).not.toThrow();
    expect(() =>
      assertWhatsAppLinkConfig({
        HYPERDRIVE: { connectionString: 'x' },
        WA_EVENTS_QUEUE: { send: h.send },
      })
    ).toThrow(/SUITE_BUYER_KEY_SECRET/);
    process.env.SUITE_BUYER_KEY_SECRET = 'short';
    expect(() => suiteBuyerKeySecret()).toThrow();
  });
});
