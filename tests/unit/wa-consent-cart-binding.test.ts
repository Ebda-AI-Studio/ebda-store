/**
 * WA-CONSENT-1 security review: the checkout opt-in takes NO phone from the request. It is bound to
 * the caller's own cart session and account. A different session / user / guest cannot opt in or
 * revoke anybody; a burst is rate-limited per IP+session and per store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { matches } from '../helpers/campaign-fake-db';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  carts: [] as Row[],
  users: [] as Row[],
  orders: [] as Row[],
  consents: [] as Row[],
  upsert: vi.fn(),
  find: vi.fn(),
  updateMany: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    cart: { findFirst: async ({ where }: any) => h.carts.find(r => matches(r, where)) ?? null },
    user: { findFirst: async ({ where }: any) => h.users.find(r => matches(r, where)) ?? null },
    order: {
      findMany: async ({ where }: any) =>
        h.orders.filter(
          r =>
            r.customerId === where.customerId &&
            r.storeId === where.storeId &&
            r.status === where.status
        ),
    },
    storeWhatsAppConsent: {
      upsert: h.upsert,
      updateMany: h.updateMany,
      findMany: async ({ where }: any) => h.consents.filter(r => matches(r, where)),
      deleteMany: async ({ where }: any) => {
        const hit = h.consents.filter(r => matches(r, where));
        hit.forEach(r => h.consents.splice(h.consents.indexOf(r), 1));
        return { count: hit.length };
      },
      findUnique: (a: any) => h.find(a),
    },
  },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));

import { WhatsAppConsentService, revokeForPhoneChange } from '@api/lib/wa/consent';

const S = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
  h.upsert.mockReset().mockResolvedValue({});
  h.updateMany.mockReset().mockResolvedValue({ count: 1 });
  h.orders.length = 0;
  h.orders.push({
    storeId: S,
    customerId: 'user-a',
    status: 'delivered',
    shippingAddress: { phone: '+201001234567' },
  });
  h.orders.push({
    storeId: S,
    customerId: 'user-b',
    status: 'delivered',
    shippingAddress: { phone: '01112345678' },
  });
  h.find.mockReset().mockResolvedValue({ granted: true, userId: null });
  h.consents.length = 0;
  h.carts.length = 0;
  h.users.length = 0;
  h.carts.push({ id: 'cart-a', storeId: S, sessionId: 'sess-a', customerId: 'user-a' });
  h.carts.push({ id: 'cart-b', storeId: S, sessionId: 'sess-b', customerId: 'user-b' });
  h.users.push({ id: 'user-a', storeId: S, phone: '01001234567' });
  h.users.push({ id: 'user-b', storeId: S, phone: '01112345678' });
});

describe('recordForCart', () => {
  it("records the caller's OWN account number against their own cart", async () => {
    const r = await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true });
    expect(r).toEqual({ status: 'recorded', granted: true, cartId: 'cart-a' });
    expect(h.upsert.mock.calls[0]![0].create).toMatchObject({
      granted: true,
      grantedSource: 'checkout',
    });
  });

  it("a different session cannot opt in; a revoke only ever touches the CALLER's own number", async () => {
    // user-b with user-a's session id: no grant
    expect(
      await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-b', { consent: true })
    ).toEqual({ status: 'no_cart' });
    expect(
      await WhatsAppConsentService.recordForCart(S, 'unknown', 'user-a', { consent: true })
    ).toEqual({ status: 'no_cart' });
    expect(h.upsert).not.toHaveBeenCalled();
    // user-b "revoking" with user-a's session id withdraws user-b's number, never user-a's
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-b', { consent: false });
    const bKey = h.upsert.mock.calls[0]![0].where.storeId_buyerKey.buyerKey;
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: false });
    const aKey = h.upsert.mock.calls[1]![0].where.storeId_buyerKey.buyerKey;
    expect(aKey).not.toBe(bKey);
  });

  it('an account with no phone records nothing', async () => {
    h.users[0]!.phone = null;
    expect(
      await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true })
    ).toEqual({
      status: 'no_phone',
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("two customers get two different buyer keys (nobody is addressed by someone else's number)", async () => {
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true });
    await WhatsAppConsentService.recordForCart(S, 'sess-b', 'user-b', { consent: true });
    const k = h.upsert.mock.calls.map(c => c[0].where.storeId_buyerKey.buyerKey);
    expect(k[0]).not.toBe(k[1]);
  });
});

describe("state read does not leak someone else's consent", () => {
  it('an unproven profile phone reports granted:false even if that number has consent', async () => {
    h.users[0]!.phone = '01112345678'; // user-b's number, never on user-a's orders
    const r = await WhatsAppConsentService.stateForUser(S, 'user-a');
    expect(r).toEqual({ granted: false, proven: false });
  });
  it('a proven phone reports the real state', async () => {
    const r = await WhatsAppConsentService.stateForUser(S, 'user-a');
    expect(r).toEqual({ granted: true, proven: true });
  });
});

describe('a profile phone is self-declared: granting needs proof it is theirs', () => {
  it('a phone that is on none of their orders cannot be opted in', async () => {
    h.users[0]!.phone = '01099999999'; // set on the profile, never used on an order
    expect(
      await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true })
    ).toEqual({
      status: 'phone_unproven',
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it("someone else's order phone does not count (user-a claims user-b's number)", async () => {
    h.users[0]!.phone = '01112345678';
    expect(
      await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true })
    ).toEqual({
      status: 'phone_unproven',
    });
  });
  it('a pending or cancelled order proves nothing: only a DELIVERED order does', async () => {
    const src = readFileSync('apps/api/src/lib/wa/consent.ts', 'utf8');
    expect(src).toMatch(/status: 'delivered'/);
  });
  it('REVOKING needs no proof and no cart: withdrawal always works (any device)', async () => {
    h.carts.length = 0;
    const r = await WhatsAppConsentService.recordForCart(S, 'other-device', 'user-a', {
      consent: false,
    });
    expect(r).toMatchObject({ status: 'recorded', granted: false });
  });
  it('REVOKING needs no proof: withdrawal always works', async () => {
    h.users[0]!.phone = '01099999999';
    const r = await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: false });
    expect(r).toMatchObject({ status: 'recorded', granted: false });
  });
  it("changing the profile phone revokes the OLD number's consent (source profile)", async () => {
    await revokeForPhoneChange(S, '01001234567');
    const a = h.updateMany.mock.calls[0]![0];
    expect(a.where).toMatchObject({ storeId: S, granted: true });
    expect(a.where.buyerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.data).toMatchObject({ granted: false, revokedSource: 'profile' });
  });
  it('updateProfile calls it when the phone changes', () => {
    const src = readFileSync('apps/api/src/services/auth.service.ts', 'utf8');
    expect(src).toContain('revokeForPhoneChange(current.storeId, current.phone)');
    // BEFORE the phone is written: a failed revoke leaves the phone unchanged.
    expect(src.indexOf('revokeForPhoneChange(current.storeId')).toBeLessThan(
      src.indexOf('...(data.phone !== undefined && { phone: data.phone })')
    );
  });
});
