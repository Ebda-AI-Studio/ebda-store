/**
 * Store side of the WhatsAppBridge contract test (audit WA-RPC). `tests/vectors/ebda-wa/bridge-v1.json` is a recorded
 * conversation: ordered calls and the exact answers. ebda-whatsapp vendors the SAME file byte for byte (sha pinned in
 * SHA256SUMS on both sides) and replays it through its own adapter and schemas, so a one-sided change fails on one side.
 * Regenerate with `WA_BRIDGE_REGEN=1` (then update SHA256SUMS and the vendored copy in ebda-whatsapp).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../../../apps/api/src/lib/derived-secret', () => ({
  derivedSecret: () => Buffer.alloc(32, 7),
}));

import { createBridge } from '../../../apps/api/src/lib/wa/bridge/service';
import {
  signCheckoutToken,
  verifyCheckoutToken,
  storeBuyerId,
} from '../../../apps/api/src/lib/wa/bridge/checkout-token';
import { makeFakePort, S, BK, BUYER } from './fake-port';
import { CASES } from './cases';

// The secret behind the pinned vector key BK (tests/vectors/ebda-wa/buyer-key.json); the bridge recomputes it (WA-2).
const SECRET = 'ebda-suite-buyer-key-test-v1';
const FIXTURE = path.resolve(__dirname, '../../vectors/ebda-wa/bridge-v1.json');
const SUMS = path.resolve(__dirname, '../../vectors/ebda-wa/SHA256SUMS');
const bridge = () =>
  createBridge({
    port: makeFakePort().port,
    storefrontUrl: async () => 'https://dar-mona.ebda.app',
    buyerKeySecret: () => SECRET,
    now: () => 1_762_800_000_000,
  });
const call = (b: ReturnType<typeof bridge>, m: string, a: unknown[]) =>
  (b as never as Record<string, (...x: unknown[]) => Promise<unknown>>)[m]!(...a);

async function record() {
  const b = bridge();
  const out = [];
  for (const c of CASES)
    out.push({ ...c, expect: JSON.parse(JSON.stringify(await call(b, c.method, c.args))) });
  return { version: 1, cases: out };
}

describe('WhatsAppBridge contract vectors', () => {
  if (process.env.WA_BRIDGE_REGEN) {
    it('regenerates the fixture', async () => {
      writeFileSync(FIXTURE, JSON.stringify(await record(), null, 1) + '\n');
    });
    return;
  }
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    cases: Array<{ name: string; method: string; args: unknown[]; expect: unknown }>;
  };
  it('covers every case in cases.ts, in order', () => {
    expect(fx.cases.map(c => [c.name, c.method, c.args])).toEqual(
      CASES.map(c => [c.name, c.method, JSON.parse(JSON.stringify(c.args))])
    );
  });
  it('replays to the recorded answers', async () => {
    const b = bridge();
    for (const c of fx.cases)
      expect(JSON.parse(JSON.stringify(await call(b, c.method, c.args))), c.name).toEqual(c.expect);
  });
  it('the fixture sha is pinned', () => {
    const sums = readFileSync(SUMS, 'utf8');
    expect(sums).toContain(
      `${createHash('sha256').update(readFileSync(FIXTURE)).digest('hex')}  bridge-v1.json`
    );
  });
});

describe('WhatsAppBridge behaviour', () => {
  it('every one of the 12 RPC names the caller uses exists', () => {
    expect(Object.keys(bridge()).sort()).toEqual([
      'attachPaymentProof',
      'createCheckoutLink',
      'createOrderFromChat',
      'getCustomerAddresses',
      'getOrderStatus',
      'getPaymentLink',
      'getProducts',
      'getStoreProfile',
      'listCatalog',
      'listCustomerOrders',
      'recordCodOutcome',
      'saveCustomerAddress',
    ]);
  });
  it('a checkout link carries ids and quantities, no price, and verifies once, then expires', async () => {
    const b = bridge();
    const r = (await b.createCheckoutLink(S, {
      items: [{ variantId: 'v1', quantity: 2 }],
      buyer: BUYER,
    })) as { ok: true; value: { checkoutUrl: string; summary: unknown } };
    expect(r.ok).toBe(true);
    expect(r.value.summary).toEqual({ itemsCount: 2, totalMinor: 50000, currency: 'EGP' });
    const token = new URL(r.value.checkoutUrl).searchParams.get('t')!;
    const p = verifyCheckoutToken(token, 1_762_800_000_000 + 60_000)!;
    expect(p).toMatchObject({
      storeId: S,
      bk: storeBuyerId(S, BK),
      items: [{ variantId: 'v1', quantity: 2 }],
    });
    expect(JSON.stringify(p)).not.toMatch(/price|total/i);
    expect(verifyCheckoutToken(token, 1_762_800_000_000 + 31 * 60_000)).toBeNull();
    expect(verifyCheckoutToken(token.slice(0, -2) + 'AA')).toBeNull();
  });
  it('a token minted for another store payload does not verify', () => {
    const t = signCheckoutToken(
      { storeId: S, items: [{ variantId: 'v1', quantity: 1 }], bk: 'x' },
      1
    );
    const [body, sig] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), storeId: 'x' })
    ).toString('base64url');
    expect(verifyCheckoutToken(`${forged}.${sig}`, 2)).toBeNull();
  });
  it('a gateway outage on a link order keeps the order and returns no url', async () => {
    const { port } = makeFakePort();
    port.issuePaymentLink = async () => {
      throw new Error('gateway down');
    };
    const b = createBridge({
      port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => SECRET,
    });
    const r = (await b.createOrderFromChat(S, {
      items: [{ variantId: 'v1', quantity: 1 }],
      buyer: BUYER,
      addressId: 'a1',
      paymentMethod: 'link',
      idempotencyKey: 'idem-gateway-1',
    })) as { ok: true; value: { orderId: string; paymentUrl: string | null } };
    expect(r.ok && r.value.orderId).toBeTruthy();
    expect(r.value.paymentUrl).toBeNull();
  });
  it('an unexpected port error is rethrown (the caller retries), never swallowed into data', async () => {
    const { port } = makeFakePort();
    port.catalogPage = async () => {
      throw new Error('do unavailable');
    };
    const log = vi.fn();
    const b = createBridge({
      port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => SECRET,
      log,
    });
    await expect(b.listCatalog(S, null, 10)).rejects.toThrow('do unavailable');
    expect(log).toHaveBeenCalled();
  });
  it('the store gate runs before any read of a tenant table', async () => {
    const { port } = makeFakePort();
    const spy = vi.spyOn(port, 'catalogPage');
    const b = createBridge({
      port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => SECRET,
    });
    await b.listCatalog('33333333-3333-4333-8333-333333333333', null, 10);
    await b.listCatalog('22222222-2222-4222-8222-222222222222', null, 10);
    expect(spy).not.toHaveBeenCalled();
  });
  it('a COD refusal after a confirmation cancels once; a later confirmation does not resurrect it', async () => {
    const { port, orders } = makeFakePort();
    const b = createBridge({
      port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => SECRET,
    });
    const placed = (await b.createOrderFromChat(S, {
      items: [{ variantId: 'v1', quantity: 1 }],
      buyer: BUYER,
      addressId: 'a1',
      paymentMethod: 'cod',
      idempotencyKey: 'idem-cod-xx1',
    })) as { ok: true; value: { orderId: string } };
    await b.recordCodOutcome(S, {
      orderId: placed.value.orderId,
      outcome: 'confirmed',
      at: '2026-11-11T10:00:00Z',
      idempotencyKey: 'idem-cod-xx2',
    });
    await b.recordCodOutcome(S, {
      orderId: placed.value.orderId,
      outcome: 'refused',
      at: '2026-11-11T10:01:00Z',
      idempotencyKey: 'idem-cod-xx3',
    });
    await b.recordCodOutcome(S, {
      orderId: placed.value.orderId,
      outcome: 'confirmed',
      at: '2026-11-11T10:02:00Z',
      idempotencyKey: 'idem-cod-xx4',
    });
    expect(orders.get(placed.value.orderId)!.status).toBe('cancelled');
  });
});
