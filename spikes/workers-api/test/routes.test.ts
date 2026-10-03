import { describe, it, expect } from 'vitest';
import { AMELIA, RIVAL, SECRET, call, rawTx, hmacHex, pmap } from './helpers';
import { parseHost, RESERVED_SLUGS } from '../src/host';

const post = (host: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(host, path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const AMELIA_PRODUCT = 'a0000000-0000-4000-8000-000000000001';
const RIVAL_PRODUCT = 'b0000000-0000-4000-8000-000000000001';

describe('host routing', () => {
  it('slug host and custom domain map to the right store', async () => {
    const a = await (await call('amelia.ebda.app', '/products')).json() as any;
    const c = await (await call('shop.amelia.example', '/products')).json() as any;
    const cu = await (await call('SHOP.Amelia.Example:443', '/products')).json() as any;
    expect([a.storeId, c.storeId, cu.storeId]).toEqual([AMELIA.id, AMELIA.id, AMELIA.id]);
  });
  it('unknown host -> 404 (never the first store)', async () => {
    for (const h of ['nope.ebda.app', 'ebda.app', 'a.b.ebda.app', 'example.org', 'localhost', 'xn--.ebda.app', '-bad.ebda.app']) {
      const r = await call(h, '/products');
      expect([h, r.status]).toEqual([h, 404]);
      expect(await r.text()).not.toContain('Amelia');
    }
  });
  it('reserved slugs never resolve to a store', async () => {
    for (const s of RESERVED_SLUGS) {
      expect([s, (await call(`${s}.ebda.app`, '/products')).status]).toEqual([s, 404]);
      expect(parseHost(`${s}.ebda.app`, 'ebda.app')).toBeNull();
    }
    expect([...RESERVED_SLUGS].sort()).toEqual(['admin', 'api', 'app', 'docs', 'help', 'status', 'whatsapp', 'www']);
  });
});

describe('cart add', () => {
  it('add twice -> quantity 2, both 200 (no 25P02 abort)', async () => {
    const s = crypto.randomUUID();
    const r1 = await post(AMELIA.host, '/cart/items', { productId: AMELIA_PRODUCT }, { 'x-session-id': s });
    const r2 = await post(AMELIA.host, '/cart/items', { productId: AMELIA_PRODUCT }, { 'x-session-id': s });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const b = (await r2.json()) as any;
    expect(b.items).toEqual([{ productId: AMELIA_PRODUCT, quantity: 2 }]);
    expect(await rawTx((tx) => tx.cart.count({ where: { sessionId: s } }), AMELIA.id)).toBe(1);
  });
  it('12 concurrent adds on one cart -> quantity 12, no errors', async () => {
    const s = crypto.randomUUID();
    await post(AMELIA.host, '/cart/items', { productId: AMELIA_PRODUCT }, { 'x-session-id': s }); // cart exists
    const rs = await pmap(Array.from({ length: 12 }), 6, () => post(AMELIA.host, '/cart/items', { productId: AMELIA_PRODUCT }, { 'x-session-id': s }));
    console.log('[cart-concurrent] statuses', rs.map((r) => r.status).join(','));
    const items = await rawTx((tx) => tx.cartItem.findMany({ where: { cart: { sessionId: s } } }), AMELIA.id);
    expect(items[0].quantity).toBe(1 + rs.filter((r) => r.status === 200).length);
    expect(rs.every((r) => r.status === 200)).toBe(true);
  });
  it("another tenant's product id on this host is a 404, and writes nothing", async () => {
    const s = crypto.randomUUID();
    const r = await post(AMELIA.host, '/cart/items', { productId: RIVAL_PRODUCT }, { 'x-session-id': s });
    expect(r.status).toBe(404);
    expect(await rawTx((tx) => tx.cart.count({ where: { sessionId: s } }), AMELIA.id)).toBe(0);
  });
  it('same session id on two hosts yields two independent carts', async () => {
    const s = crypto.randomUUID();
    const a = (await (await post(AMELIA.host, '/cart/items', { productId: AMELIA_PRODUCT }, { 'x-session-id': s })).json()) as any;
    const b = (await (await post(RIVAL.host, '/cart/items', { productId: RIVAL_PRODUCT, quantity: 3 }, { 'x-session-id': s })).json()) as any;
    expect(a.cartId).not.toBe(b.cartId);
    expect(b.items).toEqual([{ productId: RIVAL_PRODUCT, quantity: 3 }]);
  });
});

describe('payment webhook', () => {
  const send = async (host: string, evt: object, sig?: string | null) => {
    const raw = JSON.stringify(evt);
    const h: Record<string, string> = {};
    if (sig !== null) h['x-signature'] = sig ?? (await hmacHex(SECRET, raw));
    return post(host, '/webhooks/payments/fakepay', raw, h);
  };
  const cartStatus = (storeId: string, id: string) => rawTx((tx) => tx.cart.findUnique({ where: { id }, select: { status: true } }), storeId);

  it('bad signature -> 401; missing -> 401; bad hex -> 401; unknown provider -> 404; nothing stored', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    expect((await send(AMELIA.host, { eventId, cartId: 'x' }, 'deadbeef')).status).toBe(401);
    expect((await send(AMELIA.host, { eventId, cartId: 'x' }, null)).status).toBe(401);
    expect((await send(AMELIA.host, { eventId, cartId: 'x' }, 'zz')).status).toBe(401);
    // valid signature of a DIFFERENT body
    expect((await send(AMELIA.host, { eventId, cartId: 'x' }, await hmacHex(SECRET, '{"other":1}'))).status).toBe(401);
    expect((await post(AMELIA.host, '/webhooks/payments/nopay', '{}', { 'x-signature': 'aa' })).status).toBe(404);
    expect(await rawTx((tx) => tx.webhookEvent.count({ where: { eventId } }), AMELIA.id)).toBe(0);
  });
  it('good -> 200 and cart paid; replay -> 200 no duplicate row, no second state change', async () => {
    const s = crypto.randomUUID();
    const cartId = ((await (await post(AMELIA.host, '/cart/items', { productId: AMELIA_PRODUCT }, { 'x-session-id': s })).json()) as any).cartId;
    const eventId = `evt_${crypto.randomUUID()}`;
    const r1 = await send(AMELIA.host, { eventId, cartId });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ duplicate: false, cartMarkedPaid: true });
    expect((await cartStatus(AMELIA.id, cartId))?.status).toBe('paid');
    const r2 = await send(AMELIA.host, { eventId, cartId });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ duplicate: true });
    expect(await rawTx((tx) => tx.webhookEvent.count({ where: { provider: 'fakepay', eventId } }), AMELIA.id)).toBe(1);
  });
  it('5 simultaneous replays of one event -> exactly one row, all 200', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const rs = await Promise.all(Array.from({ length: 5 }, () => send(AMELIA.host, { eventId, cartId: 'none' })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await rawTx((tx) => tx.webhookEvent.count({ where: { eventId } }), AMELIA.id)).toBe(1);
  });
  it("a webhook delivered on rival's host cannot mark amelia's cart paid", async () => {
    const s = crypto.randomUUID();
    const cartId = ((await (await post(AMELIA.host, '/cart/items', { productId: AMELIA_PRODUCT }, { 'x-session-id': s })).json()) as any).cartId;
    const r = await send(RIVAL.host, { eventId: `evt_${crypto.randomUUID()}`, cartId });
    expect(await r.json()).toMatchObject({ cartMarkedPaid: false });
    expect((await cartStatus(AMELIA.id, cartId))?.status).toBe('open');
  });
});
