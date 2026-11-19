/**
 * Defect class of WA-2 across EVERY bridge method: nothing that names a buyer or an order trusts the claim. Key-only methods
 * rebuild HMAC(secret, phone); order methods compare against the key stored on the order (constant time). Strict mode
 * (WA_BRIDGE_REQUIRE_BUYER_PROOF=1) refuses a call that sends no proof.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../apps/api/src/lib/derived-secret', () => ({
  derivedSecret: () => Buffer.alloc(32, 7),
}));

import { createBridge } from '../../../apps/api/src/lib/wa/bridge/service';
import { makeFakePort, S, BK, BK_OTHER, BUYER } from './fake-port';

const SECRET = 'ebda-suite-buyer-key-test-v1';
const mk = (strict = false) => {
  const fake = makeFakePort();
  const b = createBridge({
    port: fake.port,
    storefrontUrl: async () => 'https://x',
    buyerKeySecret: () => SECRET,
    requireBuyerProof: () => strict,
  });
  return { b, fake };
};
const PHONE = BUYER.phoneE164;
const OTHER_PHONE = '+201111111111';
const addr = { area: 'Maadi', street: '9 Road 233' };
async function place(b: ReturnType<typeof mk>['b'], paymentMethod: 'cod' | 'link' | 'instapay') {
  const r = (await b.createOrderFromChat(S, {
    items: [{ variantId: 'v1', quantity: 1 }],
    buyer: BUYER,
    address: addr,
    paymentMethod,
    idempotencyKey: `idem-${paymentMethod}-0001`,
  })) as { ok: boolean; value: { orderId: string; orderNumber: string } };
  expect(r.ok).toBe(true);
  return r.value;
}
const bad = { ok: false, reason: 'invalid' };
const gone = { ok: false, reason: 'not_found' };

describe('key-only methods rebuild the key from the phone', () => {
  it('a key paired with a phone that is not its own is refused by all four', async () => {
    const { b } = mk();
    expect(await b.getCustomerAddresses(S, BK, OTHER_PHONE)).toMatchObject(bad);
    expect(await b.saveCustomerAddress(S, BK, addr, OTHER_PHONE)).toMatchObject(bad);
    expect(await b.getOrderStatus(S, 'EB-1001', BK, OTHER_PHONE)).toMatchObject(bad);
    expect(await b.listCustomerOrders(S, BK, 5, OTHER_PHONE)).toMatchObject(bad);
    // a forged key for the right phone too
    expect(await b.listCustomerOrders(S, BK_OTHER, 5, PHONE)).toMatchObject(bad);
  });
  it('the right pair passes', async () => {
    const { b } = mk();
    expect(await b.getCustomerAddresses(S, BK, PHONE)).toMatchObject({ ok: true });
    expect(await b.saveCustomerAddress(S, BK, addr, PHONE)).toMatchObject({ ok: true });
    expect(await b.listCustomerOrders(S, BK, 5, PHONE)).toMatchObject({ ok: true });
  });
  it('strict mode refuses a call with no phone; relaxed mode still allows the old shape', async () => {
    expect(await mk(true).b.getCustomerAddresses(S, BK)).toMatchObject(bad);
    expect(await mk(true).b.listCustomerOrders(S, BK, 5)).toMatchObject(bad);
    expect(await mk(false).b.getCustomerAddresses(S, BK)).toMatchObject({ ok: true });
  });
  it('a missing secret throws, trusting nothing', async () => {
    const b = createBridge({
      port: makeFakePort().port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => '',
    });
    await expect(b.getCustomerAddresses(S, BK, PHONE)).rejects.toThrow();
  });
});

describe('order methods compare against the key stored on the order', () => {
  it('getPaymentLink: another buyer key sees the order as unknown', async () => {
    const { b } = mk();
    const o = await place(b, 'link');
    expect(await b.getPaymentLink(S, o.orderId, BK_OTHER)).toMatchObject(gone);
    expect(await b.getPaymentLink(S, o.orderId, BK)).toMatchObject({ ok: true });
  });
  it('recordCodOutcome: another buyer key cannot confirm or refuse the order', async () => {
    const { b } = mk();
    const o = await place(b, 'cod');
    const req = (buyerKey: string) => ({
      orderId: o.orderId,
      buyerKey,
      outcome: 'refused',
      at: '2026-11-12T10:00:00+02:00',
      idempotencyKey: 'cod-idem-0001',
    });
    expect(await b.recordCodOutcome(S, req(BK_OTHER))).toMatchObject(gone);
    expect(await b.recordCodOutcome(S, req(BK))).toMatchObject({ ok: true });
  });
  it('attachPaymentProof: another buyer key cannot attach a proof', async () => {
    const { b } = mk();
    const o = await place(b, 'instapay');
    const url = 'https://chat.ebda.app/m/1';
    expect(await b.attachPaymentProof(S, o.orderId, url, BK_OTHER)).toMatchObject(gone);
    expect(await b.attachPaymentProof(S, o.orderId, url, BK)).toMatchObject({ ok: true });
  });
  it('an unknown order and a mismatch answer the same (no existence leak)', async () => {
    const { b } = mk();
    const o = await place(b, 'link');
    expect(await b.getPaymentLink(S, 'nope', BK)).toEqual(
      await b.getPaymentLink(S, o.orderId, BK_OTHER)
    );
  });
  it('strict mode refuses an order call with no buyer key; relaxed keeps the old shape', async () => {
    const strict = mk(true);
    const o = await place(strict.b, 'link');
    expect(await strict.b.getPaymentLink(S, o.orderId)).toMatchObject(gone);
    const relaxed = mk(false);
    const o2 = await place(relaxed.b, 'link');
    expect(await relaxed.b.getPaymentLink(S, o2.orderId)).toMatchObject({ ok: true });
  });
});
