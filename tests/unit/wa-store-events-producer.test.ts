/**
 * Store -> Ebda Chat producer (contract 2026-10-24 section 4): the events, their envelope, the
 * buyer key, idempotent ids, and the "not linked / no phone: send nothing" rules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  products: vi.fn(),
  cart: vi.fn(),
  linkRow: vi.fn(),
  planInput: vi.fn(),
  order: vi.fn(),
  linked: vi.fn(),
  send: vi.fn(),
  consent: vi.fn(),
  owner: vi.fn(),
  consentRow: vi.fn(),
  store: vi.fn(),
}));
const dbMock = vi.hoisted(() => ({
  order: { findUnique: h.order },
  abandonedCart: { findFirst: h.cart },
  user: { findFirst: h.owner },
  storeWhatsAppConsent: { findUnique: h.consentRow },
  product: { findMany: h.products },
  store: { findUnique: h.store },
}));
vi.mock('@ebda/database', () => ({
  prisma: dbMock,
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  // the cart event reads `Store` (a platform row) with withStore
  withStore: (_s: string, fn: (tx: unknown) => unknown) => fn(dbMock),
}));
// a Postgres store: the job reads through the same prisma mock (a DO store is covered in jobs-money-on-do.test.ts)
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (storeId: string) => ({ storeId, backend: 'pg', db: dbMock }),
}));
vi.mock('@api/lib/wa/consent', () => ({ WhatsAppConsentService: { hasConsent: h.consent } }));
vi.mock('@api/lib/wa/link', () => ({ isWhatsAppLinked: h.linked, hasWhatsAppLinkRow: h.linkRow }));
vi.mock('@api/lib/wa/plan-state', () => ({
  PLAN_CHANGED_EVENT: 'store/plan-changed',
  planChangedInput: h.planInput,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { storeEventSchema } from '@api/contracts/wa-v1';
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
  status: 'pending',
  paymentStatus: 'unpaid',
  statusFanoutRequestedAt: new Date('2026-10-25T10:05:00Z'),
  payments: [{ provider: 'cod', status: 'cod_pending' }],
};

beforeEach(() => {
  process.env.SUITE_BUYER_KEY_SECRET = SECRET;
  h.order.mockReset().mockResolvedValue(ORDER);
  h.linked.mockReset().mockResolvedValue(true);
  h.consent.mockReset().mockResolvedValue(true);
  h.consentRow.mockReset().mockResolvedValue(null);
  h.owner.mockReset().mockResolvedValue({ deletedAt: null });
  h.linkRow.mockReset().mockResolvedValue(true);
  h.cart.mockReset().mockResolvedValue({
    status: 'pending',
    recoveredAt: null,
    customerPhone: '01001234567',
    createdAt: new Date('2026-10-25T09:00:00Z'),
  });
  h.store.mockReset().mockResolvedValue({
    slug: 'souq',
    domain: null,
    settings: { defaultLanguage: 'en' },
  });
  h.planInput.mockReset().mockResolvedValue({
    seed: 'plan:x',
    input: {
      type: 'store.plan_changed',
      storeId: STORE,
      data: {
        planCode: 'business',
        includesWhatsApp: true,
        ownerUserId: 'o1',
        effectiveAt: '2026-10-25T10:00:00.000Z',
        status: 'past_due',
        periodEnd: '2026-12-01T00:00:00.000Z',
      },
    },
  });
  h.send.mockReset().mockResolvedValue(undefined);
  clearCfBindings();
  setCfBindings({ WA_EVENTS_QUEUE: { send: h.send } });
});

const send_clear = () => h.send.mockClear();
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

  it('order/created is re-sent by other paths: the SAME order always yields the SAME envelope ids', async () => {
    await emitStoreEventsFor(ev('cod'));
    const first = sent().map(e => e.id);
    h.send.mockClear();
    // a different source event id (a COD mark-paid / delivery / stuck-sweep re-send)
    await emitStoreEventsFor({ ...ev('cod'), id: 'a-completely-different-source-event' });
    expect(sent().map(e => e.id)).toEqual(first);
  });

  it('a re-sent order/created after the COD order was paid or shipped does NOT ask the buyer to confirm again', async () => {
    for (const settled of [
      { paymentStatus: 'paid', payments: [{ provider: 'cod', status: 'completed' }] },
      { status: 'shipped' },
      { status: 'delivered', paymentStatus: 'paid' },
    ]) {
      h.send.mockClear();
      h.order.mockResolvedValue({ ...ORDER, ...settled });
      await emitStoreEventsFor(ev('cod'));
      expect(sent().map(e => e.type)).toEqual(['order.created']);
    }
  });

  it('a card order that is still unpaid never gets a COD request', async () => {
    h.order.mockResolvedValue({ ...ORDER, payments: [{ provider: 'paymob', status: 'pending' }] });
    await emitStoreEventsFor(ev('paymob'));
    expect(sent().map(e => e.type)).toEqual(['order.created']);
  });

  it('empty locale / source fall back instead of failing the envelope forever', async () => {
    h.order.mockResolvedValue({ ...ORDER, locale: '', source: '' });
    await emitStoreEventsFor({ ...ev('cod'), data: { ...ev('cod').data, locale: '' } });
    expect(sent()[0]!.data).toMatchObject({ locale: 'ar', channel: 'web' });
  });

  it('a retry of the same source event sends the SAME envelope ids (consumers dedupe on id)', async () => {
    await emitStoreEventsFor(ev('cod'));
    const first = sent().map(e => e.id);
    h.send.mockClear();
    await emitStoreEventsFor(ev('cod'));
    expect(sent().map(e => e.id)).toEqual(first);
    expect(new Set(first).size).toBe(2); // ...and the two event types differ
  });

  it('an order or COD payment that is not visible yet (event sent inside the request transaction) throws so the job retries', async () => {
    h.order.mockResolvedValue(null);
    await expect(emitStoreEventsFor(ev('cod'))).rejects.toThrow(/not visible yet/);
    h.order.mockResolvedValue({ ...ORDER, payments: [] });
    await expect(emitStoreEventsFor(ev('cod'))).rejects.toThrow(/COD payment .* not visible yet/);
    expect(h.send).not.toHaveBeenCalled();
    // a settled COD order with no pending payment row is NOT "not visible": it just gets no request
    h.order.mockResolvedValue({
      ...ORDER,
      status: 'delivered',
      paymentStatus: 'paid',
      payments: [],
    });
    await expect(emitStoreEventsFor(ev('cod'))).resolves.toBe(1);
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
  it('emits order.status_changed stamped with the transition time CARRIED in the event', async () => {
    await emitStoreEventsFor({
      id: 's2',
      name: 'order/status-changed',
      data: {
        orderId: 'o1',
        storeId: STORE,
        status: 'confirmed',
        requestedAt: '2026-10-25T10:01:00.000Z',
      },
    });
    expect(sent()[0]).toMatchObject({
      type: 'order.status_changed',
      data: { orderId: 'o1', status: 'confirmed', updatedAt: '2026-10-25T10:01:00.000Z' },
    });
    expect(h.order).not.toHaveBeenCalled(); // no read of the order's CURRENT stamp
  });

  it('an old event without the time uses the order stamp only while it is still for THIS status', async () => {
    h.order.mockResolvedValue({
      statusFanoutRequestedAt: new Date('2026-10-25T10:05:00Z'),
      statusFanoutRequestedStatus: 'shipped',
      updatedAt: new Date('2026-10-25T10:02:00Z'),
    });
    await emitStoreEventsFor({
      name: 'order/status-changed',
      data: { orderId: 'o1', storeId: STORE, status: 'confirmed' },
    });
    // `confirmed` must not borrow `shipped`'s newer stamp (WhatsApp would roll the status back)
    expect(sent()[0]!.data.updatedAt).toBe('2026-10-25T10:02:00.000Z');
  });

  it('two transitions of one order get different ids (a later status is not deduped away)', async () => {
    const mk = (status: string, at: string) =>
      emitStoreEventsFor({
        name: 'order/status-changed',
        data: { orderId: 'o1', storeId: STORE, status, requestedAt: at },
      });
    await mk('confirmed', '2026-10-25T10:01:00Z');
    await mk('cancelled', '2026-10-25T10:09:00Z');
    expect(new Set(sent().map(e => e.id)).size).toBe(2);
  });

  it('a malformed shipment updatedAt falls back instead of retrying forever', async () => {
    await emitStoreEventsFor({
      name: 'shipment/status-updated',
      data: {
        orderId: 'o1',
        storeId: STORE,
        shipmentId: 'sh1',
        status: 'created',
        updatedAt: 'garbage',
      },
    });
    expect(storeEventSchema.safeParse(sent()[0]).success).toBe(true);
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
    expect(() => assertWhatsAppLinkConfig({})).not.toThrow();
    expect(() =>
      assertWhatsAppLinkConfig({
        WA_EVENTS_QUEUE: { send: h.send },
      })
    ).toThrow(/SUITE_BUYER_KEY_SECRET/);
    process.env.SUITE_BUYER_KEY_SECRET = 'short';
    expect(() => suiteBuyerKeySecret()).toThrow();
  });
});

describe('store/plan-changed', () => {
  const ev = { id: 'p1', name: 'store/plan-changed', data: { storeId: STORE } };
  it('goes to every store that has a link row, even an UNLINKED one (that is when the gate must hear)', async () => {
    h.linked.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev)).toBe(1);
    expect(sent()[0]).toMatchObject({
      type: 'store.plan_changed',
      data: { planCode: 'business', status: 'past_due', periodEnd: '2026-12-01T00:00:00.000Z' },
    });
    expect(storeEventSchema.safeParse(sent()[0]).success).toBe(true);
  });
  it('a store Ebda Chat has never heard of gets nothing', async () => {
    h.linkRow.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev)).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('the same state sends the same envelope id (the 6-hourly reconcile dedupes)', async () => {
    await emitStoreEventsFor(ev);
    const first = sent()[0]!.id;
    h.send.mockClear();
    await emitStoreEventsFor({ ...ev, id: 'another' });
    expect(sent()[0]!.id).toBe(first);
  });
});

describe('cart/abandoned', () => {
  const ev = { id: 'c1', name: 'cart/abandoned', data: { storeId: STORE, cartId: 'cart-1' } };

  it('emits cart.abandoned with the buyer key, the store language and a signed restore link', async () => {
    process.env.JWT_SECRET ??= 'test-jwt-secret-0123456789abcdef-0123456789';
    expect(await emitStoreEventsFor(ev)).toBe(1);
    const e = sent()[0]!;
    expect(storeEventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      type: 'cart.abandoned',
      data: { cartId: 'cart-1', phoneE164: '+201001234567', locale: 'en' },
    });
    expect(String(e.data.recoveryUrl)).toMatch(/^https:\/\/souq\.ebda\.app\/cart\?restore=/);
    expect(String(e.data.buyerKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('WA-CONSENT-1: no marketing consent, no cart.abandoned (checked at send time)', async () => {
    h.consent.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev)).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.consent).toHaveBeenCalledWith(STORE, expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it('WA-CONSENT-1: a revoke between capture and send stops the reminder; a re-tick resumes it', async () => {
    h.consent.mockResolvedValueOnce(false);
    expect(await emitStoreEventsFor(ev)).toBe(0);
    h.consent.mockResolvedValueOnce(true);
    expect(await emitStoreEventsFor(ev)).toBe(1);
  });

  it('a deactivated account is never chased, even with a live consent row', async () => {
    h.cart.mockResolvedValue({ ...(await h.cart()), customerId: 'user-1' });
    h.owner.mockResolvedValue({ deletedAt: new Date() });
    expect(await emitStoreEventsFor(ev)).toBe(0);
    h.owner.mockResolvedValue(null);
    expect(await emitStoreEventsFor(ev)).toBe(0);
    h.owner.mockResolvedValue({ deletedAt: null });
    expect(await emitStoreEventsFor(ev)).toBe(1);
  });

  it('a cart that was already recovered (the shopper ordered) is never chased', async () => {
    h.cart.mockResolvedValue({ ...(await h.cart()), status: 'recovered' });
    expect(await emitStoreEventsFor(ev)).toBe(0);
  });

  it('no usable phone, or a store that is not linked: nothing', async () => {
    h.cart.mockResolvedValue({ ...(await h.cart()), customerPhone: 'n/a' });
    expect(await emitStoreEventsFor(ev)).toBe(0);
    h.linked.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev)).toBe(0);
  });

  it('a cart row that is not committed yet throws so the job retries; the id is stable per cart', async () => {
    h.cart.mockResolvedValueOnce(null);
    await expect(emitStoreEventsFor(ev)).rejects.toThrow(/not visible yet/);
    await emitStoreEventsFor(ev);
    const first = sent()[0]!.id;
    h.send.mockClear();
    await emitStoreEventsFor({ ...ev, id: 'another' });
    expect(sent()[0]!.id).toBe(first);
  });
});

describe('account/erased (customer.erased)', () => {
  const KEY = 'b'.repeat(64);
  const ev = {
    id: 'e1',
    name: 'account/erased',
    data: { storeId: STORE, buyerKey: KEY, userId: 'u1' },
  };

  it('sends ONLY the hashed key, for any store Ebda Chat knows, linked or not', async () => {
    h.linked.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev)).toBe(1);
    expect(sent()[0]).toMatchObject({
      type: 'customer.erased',
      storeId: STORE,
      data: { buyerKey: KEY },
    });
    expect(Object.keys(sent()[0]!.data)).toEqual(['buyerKey']);
    expect(JSON.stringify(sent()[0])).not.toMatch(/phone|u1/i);
  });

  it('a store WhatsApp never knew, or an erasure without a key (no phone / no secret), sends nothing', async () => {
    h.linkRow.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev)).toBe(0);
    h.linkRow.mockResolvedValue(true);
    expect(await emitStoreEventsFor({ ...ev, data: { storeId: STORE, userId: 'u1' } })).toBe(0);
    expect(await emitStoreEventsFor({ ...ev, data: { buyerKey: KEY } })).toBe(0);
  });
});

describe('catalog/changed', () => {
  const UP = new Date('2026-10-25T08:00:00Z');
  const ev = (productIds: string[] | null) => ({
    id: 'k1',
    name: 'catalog/changed',
    data: { storeId: STORE, productIds },
  });
  beforeEach(() => {
    h.products.mockReset();
  });

  it('upserted for a live product with its variant ids, deleted for a soft-deleted or vanished one', async () => {
    h.products.mockResolvedValue([
      { id: 'p1', updatedAt: UP, deletedAt: null, variants: [{ id: 'v1' }, { id: 'v2' }] },
      {
        id: 'p2',
        updatedAt: UP,
        deletedAt: new Date('2026-10-25T09:00:00Z'),
        variants: [{ id: 'v3' }],
      },
    ]);
    expect(await emitStoreEventsFor(ev(['p1', 'p2', 'p3']))).toBe(3);
    const [a, b, c] = sent();
    expect(a).toMatchObject({
      type: 'catalog.product_upserted',
      data: { productId: 'p1', variantIds: ['v1', 'v2'], updatedAt: UP.toISOString() },
    });
    expect(b).toMatchObject({
      type: 'catalog.product_deleted',
      data: { productId: 'p2', variantIds: ['v3'] },
    });
    expect(c).toMatchObject({
      type: 'catalog.product_deleted',
      data: { productId: 'p3', variantIds: [] },
    });
    for (const e of sent()) expect(storeEventSchema.safeParse(e).success).toBe(true);
  });

  it('productIds null resyncs the whole catalog; a store that is not linked sends nothing', async () => {
    h.products
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([{ id: 'p1', updatedAt: UP, deletedAt: null, variants: [] }]);
    expect(await emitStoreEventsFor(ev(null))).toBe(1);
    h.linked.mockResolvedValue(false);
    h.send.mockClear();
    expect(await emitStoreEventsFor(ev(['p1']))).toBe(0);
  });

  it('the same product state is the same envelope id (a re-sent change dedupes)', async () => {
    h.products.mockResolvedValue([{ id: 'p1', updatedAt: UP, deletedAt: null, variants: [] }]);
    await emitStoreEventsFor(ev(['p1']));
    const first = sent()[0]!.id;
    h.send.mockClear();
    await emitStoreEventsFor({ ...ev(['p1']), id: 'k2' });
    expect(sent()[0]!.id).toBe(first);
  });
});

describe('customer.consent_changed v1.5 wording (WA-OPTIN-WORDING-1)', () => {
  const K = 'f'.repeat(64);
  const ev = { name: 'wa/consent-changed', data: { storeId: STORE, buyerKey: K } };
  const row = (over: object) => ({
    granted: true,
    grantedAt: new Date('2026-10-25T10:00:00Z'),
    revokedAt: null,
    updatedAt: new Date('2026-10-25T10:00:00Z'),
    locale: 'ar',
    ...over,
  });

  it('an opt-in carries the exact words shown beside the tick, in the locale shown, and validates', async () => {
    const { whatsappOptInWording } = await import('@ebda/shared');
    for (const locale of ['ar', 'en'] as const) {
      h.consentRow.mockResolvedValue(row({ locale }));
      send_clear();
      await emitStoreEventsFor(ev);
      const e = sent().at(-1)!;
      expect(storeEventSchema.safeParse(e).success).toBe(true);
      expect(e.data.wording).toEqual({ text: whatsappOptInWording(locale), locale });
    }
    // the wording IS the checkout's label + note (one source), not a copy
    const { WHATSAPP_OPTIN_LABEL, WHATSAPP_OPTIN_NOTE } = await import('@ebda/shared');
    expect(whatsappOptInWording('en')).toBe(`${WHATSAPP_OPTIN_LABEL.en} ${WHATSAPP_OPTIN_NOTE.en}`);
  });

  it('a withdrawal, an unknown locale and a missing locale carry no wording', async () => {
    for (const r of [
      row({ granted: false, locale: 'ar' }),
      row({ locale: 'fr' }),
      row({ locale: null }),
    ]) {
      h.consentRow.mockResolvedValue(r);
      send_clear();
      await emitStoreEventsFor(ev);
      const e = sent().at(-1)!;
      expect(storeEventSchema.safeParse(e).success).toBe(true);
      expect(e.data).not.toHaveProperty('wording');
    }
  });

  it('the vendored contract is v1.5', async () => {
    const { CONTRACT_VERSION } = await import('@api/contracts/wa-v1');
    expect(CONTRACT_VERSION).toBe('1.5');
  });
});

describe('customer.consent_changed (envelope v1.1)', () => {
  const K = 'e'.repeat(64);
  const ev = { name: 'wa/consent-changed', data: { storeId: STORE, buyerKey: K } };

  it('sends the CURRENT state, valid against the pinned v1.1 schema, deterministic id', async () => {
    h.consentRow.mockResolvedValue({
      granted: true,
      grantedAt: new Date('2026-10-25T10:00:00Z'),
      revokedAt: null,
      updatedAt: new Date('2026-10-25T10:00:00Z'),
    });
    expect(await emitStoreEventsFor(ev)).toBe(1);
    const e = sent()[0]!;
    expect(storeEventSchema.parse(e)).toMatchObject({
      type: 'customer.consent_changed',
      data: { buyerKey: K, marketingOptIn: true },
    });
    await emitStoreEventsFor(ev);
    expect(sent()[1]!.id).toBe(e.id);
  });

  it('a removed row (erasure) is announced as marketingOptIn=false', async () => {
    h.consentRow.mockResolvedValue(null);
    await emitStoreEventsFor(ev);
    expect(sent()[0]!.data.marketingOptIn).toBe(false);
  });

  it('a store that never linked WhatsApp is not told', async () => {
    h.linkRow.mockResolvedValue(false);
    expect(await emitStoreEventsFor(ev)).toBe(0);
  });
});

// WA-C5: the contract's `order.created.paymentMethod` carries `instapay` as its own value (never folded into `card`), the producer
// emits it for an InstaPay order, and a raw gateway name that is not in the enum fails the envelope instead of leaking out.
describe('order.created paymentMethod: instapay (WA-C5)', () => {
  const instapayEvent = {
    id: 'src-ip',
    name: 'order/created',
    data: { orderId: 'o1', storeId: STORE, paymentMethod: 'instapay', locale: 'ar' },
  };

  it('an InstaPay order emits ONE valid order.created with paymentMethod instapay and no COD confirmation request', async () => {
    h.order.mockResolvedValue({
      ...ORDER,
      status: 'awaiting_payment_confirmation',
      payments: [{ provider: 'instapay', status: 'pending' }],
    });
    expect(await emitStoreEventsFor(instapayEvent)).toBe(1);
    const [created] = sent();
    expect(storeEventSchema.safeParse(created).success).toBe(true);
    expect(created).toMatchObject({ type: 'order.created', data: { paymentMethod: 'instapay' } });
    expect(sent().map(e => e.type)).not.toContain('order.cod_confirmation_requested');
  });

  it('the contract enum accepts instapay and rejects a raw gateway or unknown method', () => {
    const base = {
      id: '22222222-2222-4222-8222-222222222222',
      v: 1,
      storeId: STORE,
      occurredAt: '2026-10-25T10:00:00.000Z',
      type: 'order.created',
      data: {
        orderId: 'o1',
        orderNumber: '1001',
        buyerKey: 'a'.repeat(64),
        phoneE164: '+201001234567',
        locale: 'ar',
        totalMinor: 100,
        currency: 'EGP',
        paymentMethod: 'instapay',
        channel: 'web',
      },
    };
    expect(storeEventSchema.safeParse(base).success).toBe(true);
    for (const bad of ['paymob', 'bank_transfer', 'INSTAPAY', ''])
      expect(
        storeEventSchema.safeParse({ ...base, data: { ...base.data, paymentMethod: bad } }).success
      ).toBe(false);
  });

  it('every method the producer can output is accepted by the contract, and instapay is never folded into card', () => {
    for (const raw of [
      'cod',
      'wallet',
      'instapay',
      'link',
      'paymob',
      'kashier',
      'fawry',
      undefined,
      '',
    ])
      expect(['cod', 'link', 'card', 'wallet', 'instapay']).toContain(contractPaymentMethod(raw));
    expect(contractPaymentMethod('instapay')).not.toBe('card');
    expect(contractPaymentMethod('InstaPay')).toBe('instapay');
  });
});
