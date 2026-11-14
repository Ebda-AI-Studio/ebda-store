/**
 * Ebda Chat agent context RPC (Ruling CHAT-AGENT-1..3): meaning search, store policies, customer profile.
 * Pure over the fake port: gate order, buyer proof, no invented fields, no cross-buyer read.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../apps/api/src/lib/derived-secret', () => ({
  derivedSecret: () => Buffer.alloc(32, 7),
}));

import { createBridge } from '../../../apps/api/src/lib/wa/bridge/service';
import { makeFakePort, S, S_UNLINKED, S_UNKNOWN } from './fake-port';

const SECRET = 'ebda-suite-buyer-key-test-v1';
const PHONE = '+201001234567'; // its HMAC under SECRET is the pinned BK
const mk = (over: Partial<ReturnType<typeof makeFakePort>['port']> = {}) => {
  const { port } = makeFakePort();
  Object.assign(port, over);
  return {
    port,
    b: createBridge({
      port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => SECRET,
      requireBuyerProof: () => false, // the profile must be strict even with the legacy flag OFF
    }),
  };
};

describe('searchProducts', () => {
  it('returns catalogue rows with the canonical retailerId, in the port order', async () => {
    const { b } = mk();
    const r = await b.searchProducts(S, 'هدية', { limit: 5 });
    expect(r.ok && r.value.items.map(i => i.retailerId)).toEqual(['v1', 'v2']);
  });
  it('passes the price ceiling (minor units) and the limit to the port', async () => {
    const { b, port } = mk();
    const spy = vi.spyOn(port, 'searchProducts');
    const r = await b.searchProducts(S, 'هدية', { maxPriceMinor: 30000, limit: 3 });
    expect(spy).toHaveBeenCalledWith(S, 'هدية', { maxPriceMinor: 30000, limit: 3 });
    expect(r.ok && r.value.items.map(i => i.retailerId)).toEqual(['v1']);
  });
  it('an empty result is ok + empty (a real negative), not a failure', async () => {
    const { b } = mk();
    const r = await b.searchProducts(S, 'no-such-thing', { limit: 5 });
    expect(r).toEqual({ ok: true, value: { items: [] } });
  });
  it('refuses a blank query, a limit over 20 and a fractional price before any read', async () => {
    const { b, port } = mk();
    const spy = vi.spyOn(port, 'searchProducts');
    for (const [q, o] of [
      ['   ', { limit: 5 }],
      ['x', { limit: 21 }],
      ['x', { limit: 0 }],
      ['x', { limit: 5, maxPriceMinor: 10.5 }],
    ] as const)
      expect(await b.searchProducts(S, q, o as never)).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    expect(spy).not.toHaveBeenCalled();
  });
  it('runs the store gate first: unknown and unlinked stores never reach the search', async () => {
    const { b, port } = mk();
    const spy = vi.spyOn(port, 'searchProducts');
    expect(await b.searchProducts(S_UNKNOWN, 'x', { limit: 5 })).toMatchObject({
      reason: 'not_found',
    });
    expect(await b.searchProducts(S_UNLINKED, 'x', { limit: 5 })).toMatchObject({
      reason: 'not_linked',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('getStorePolicies', () => {
  it('composes the profile (payment methods, COD) with the declared facts', async () => {
    const { b } = mk();
    const r = await b.getStorePolicies(S);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      name: 'Dar Mona',
      nameAr: 'دار منى',
      currency: 'EGP',
      paymentMethods: ['cod', 'link', 'instapay'],
      instapay: true,
      cod: { available: true, fixedFeeMinor: 2500, percentBps: null },
      returns: { windowDays: 14, feesPaidBy: 'customer' },
      hours: 'Sat-Thu 10am-10pm',
    });
    expect(r.value.shipping.zones[0]).toMatchObject({ feeMinor: 6000, freeOverMinor: 100000 });
  });
  it('a store that declared nothing answers null / empty, never a default fee or window', async () => {
    const { b } = mk({
      storePolicies: async () => ({
        nameAr: null,
        shipping: { zones: [], governorates: [] },
        returns: { windowDays: null, feesPaidBy: null },
        cod: { fixedFeeMinor: null, percentBps: null },
        hours: null,
        location: null,
      }),
    });
    const r = await b.getStorePolicies(S);
    expect(r.ok && r.value).toMatchObject({
      nameAr: null,
      shipping: { zones: [], governorates: [] },
      returns: { windowDays: null, feesPaidBy: null },
      hours: null,
      location: null,
    });
  });
  it('0 return days (no returns) stays 0, not null', async () => {
    const { b } = mk({
      storePolicies: async () => ({
        nameAr: null,
        shipping: { zones: [], governorates: [] },
        returns: { windowDays: 0, feesPaidBy: null },
        cod: { fixedFeeMinor: null, percentBps: null },
        hours: null,
        location: null,
      }),
    });
    const r = await b.getStorePolicies(S);
    expect(r.ok && r.value.returns.windowDays).toBe(0);
  });
  it('COD fields are null when the store has COD off', async () => {
    const { b, port } = mk();
    port.storeProfile = async () => ({
      name: 'X',
      logoUrl: null,
      locale: 'ar',
      currency: 'EGP',
      paymentMethods: ['link'],
      codEnabled: false,
      instapay: null,
    });
    const r = await b.getStorePolicies(S);
    expect(r.ok && r.value.cod).toEqual({
      available: false,
      fixedFeeMinor: null,
      percentBps: null,
    });
  });
  it('gate: unknown store is not_found', async () => {
    const { b } = mk();
    expect(await b.getStorePolicies(S_UNKNOWN)).toMatchObject({ reason: 'not_found' });
  });
});

describe('getCustomerProfile (buyer proof = the phone)', () => {
  it('returns first name, default address, recent orders and locale for the phone holder', async () => {
    const { b } = mk();
    const r = await b.getCustomerProfile(S, PHONE);
    expect(r.ok && r.value).toMatchObject({
      firstName: 'Mona',
      preferredLocale: 'ar',
      defaultAddress: { area: 'Maadi', governorate: 'Cairo' },
      recentOrders: [{ orderNumber: 'EB-900', items: [{ name: 'Item v1', quantity: 1 }] }],
    });
  });
  it('rebuilds the key from the phone: the port is asked for HMAC(secret, phone), never a caller key', async () => {
    const { b, port } = mk();
    const spy = vi.spyOn(port, 'customerProfile');
    await b.getCustomerProfile(S, PHONE);
    expect(spy.mock.calls[0]![1]).toMatch(/^[0-9a-f]{64}$/);
  });
  it('an unknown phone returns ok + null (nothing), not another buyer and not an error', async () => {
    const { b } = mk();
    expect(await b.getCustomerProfile(S, '+201999999999')).toEqual({ ok: true, value: null });
  });
  it('with no phone, a malformed phone, or a key-shaped string it is invalid and the port is not read', async () => {
    const { b, port } = mk();
    const spy = vi.spyOn(port, 'customerProfile');
    for (const p of [undefined, '', '01001234567', 'e8771d41'.repeat(8)])
      expect(await b.getCustomerProfile(S, p as never)).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    expect(spy).not.toHaveBeenCalled();
  });
  it('is strict whatever WA_BRIDGE_REQUIRE_BUYER_PROOF says (flag OFF here)', async () => {
    const { b } = mk();
    expect(await b.getCustomerProfile(S, undefined as never)).toMatchObject({ reason: 'invalid' });
  });
  it('a store that does not resolve never reaches the customer tables', async () => {
    const { b, port } = mk();
    const spy = vi.spyOn(port, 'customerProfile');
    expect(await b.getCustomerProfile(S_UNKNOWN, PHONE)).toMatchObject({ reason: 'not_found' });
    expect(await b.getCustomerProfile(S_UNLINKED, PHONE)).toMatchObject({ reason: 'not_linked' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('does not put the phone in an error log', async () => {
    const log = vi.fn();
    const { port } = makeFakePort();
    port.customerProfile = async () => {
      throw new Error('do unavailable');
    };
    const b = createBridge({
      port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => SECRET,
      log,
    });
    await expect(b.getCustomerProfile(S, PHONE)).rejects.toThrow();
    expect(JSON.stringify(log.mock.calls)).not.toContain('1001234567');
  });
});
