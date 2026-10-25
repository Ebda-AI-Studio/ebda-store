/**
 * WA-CONSENT-1 reviews 4-6: who OWNS a consent row (PDPL export/erasure scope) and what an erasure may
 * delete. Table-backed fake so ownership transitions are observable, not just call shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matches } from '../helpers/campaign-fake-db';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  carts: [] as Row[],
  users: [] as Row[],
  orders: [] as Row[],
  consents: [] as Row[],
}));

const same = (r: Row, k: { storeId: string; buyerKey: string }) =>
  r.storeId === k.storeId && r.buyerKey === k.buyerKey;
const consentTable = {
  findUnique: async ({ where }: any) =>
    h.consents.find(r => same(r, where.storeId_buyerKey)) ?? null,
  findMany: async ({ where }: any) => h.consents.filter(r => matches(r, where)),
  upsert: async ({ where, create, update }: any) => {
    const row = h.consents.find(r => same(r, where.storeId_buyerKey));
    if (row) Object.assign(row, update);
    else h.consents.push({ userId: null, ...create });
    return {};
  },
  updateMany: async ({ where, data }: any) => {
    const hit = h.consents.filter(r => matches(r, where));
    hit.forEach(r => Object.assign(r, data));
    return { count: hit.length };
  },
  deleteMany: async ({ where }: any) => {
    const hit = h.consents.filter(r => matches(r, where));
    hit.forEach(r => h.consents.splice(h.consents.indexOf(r), 1));
    return { count: hit.length };
  },
};
const fakePrisma = {
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
  storeWhatsAppConsent: consentTable,
};
vi.mock('@ebda/database', () => ({
  prisma: new Proxy({}, { get: (_t, k) => (fakePrisma as any)[k] }),
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));

import { buyerKeyFor } from '@ebda/shared';
import { WhatsAppConsentService } from '@api/lib/wa/consent';

const S = '11111111-1111-4111-8111-111111111111';
const key = (phone: string) => buyerKeyFor(process.env.SUITE_BUYER_KEY_SECRET!, phone);

beforeEach(async () => {
  process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
  for (const a of [h.carts, h.users, h.orders, h.consents]) a.length = 0;
  h.carts.push({ id: 'cart-a', storeId: S, sessionId: 'sess-a', customerId: 'user-a' });
  h.users.push({ id: 'user-a', storeId: S, phone: '01001234567' });
  h.orders.push({
    storeId: S,
    customerId: 'user-a',
    status: 'delivered',
    shippingAddress: { phone: '+201001234567' },
  });
});

describe('only a PROVEN grant binds a row to an account', () => {
  it('a proven grant binds', async () => {
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true });
    expect(h.consents[0]).toMatchObject({ userId: 'user-a', granted: true });
  });

  it("an UNPROVEN revoke does not bind: the account cannot claim and export someone else's row", async () => {
    h.users[0]!.phone = '01099999999'; // never on one of its orders
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: false });
    expect(h.consents[0]).toMatchObject({ granted: false, userId: null });
    expect(await WhatsAppConsentService.exportForAccount(S, 'user-a')).toHaveLength(0);
  });

  it("an unproven revoke by ANOTHER account leaves the owner untouched (cannot strip X's ownership)", async () => {
    h.consents.push({
      storeId: S,
      buyerKey: (await key('01001234567'))!,
      userId: 'user-x',
      granted: true,
    });
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: false });
    expect(h.consents[0]).toMatchObject({ granted: false, userId: 'user-x' });
  });

  it('a STOP or an admin write never sets or overwrites the owner', async () => {
    h.consents.push({
      storeId: S,
      buyerKey: (await key('01001234567'))!,
      userId: 'user-x',
      granted: true,
    });
    await WhatsAppConsentService.record(S, '01001234567', { consent: false, source: 'whatsapp' });
    await WhatsAppConsentService.record(S, '01001234567', { consent: false, source: 'admin' });
    expect(h.consents[0]).toMatchObject({ userId: 'user-x' });
  });

  it('only a PROVEN grant by another account rebinds the row', async () => {
    h.consents.push({
      storeId: S,
      buyerKey: (await key('01001234567'))!,
      userId: 'user-x',
      granted: false,
    });
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true });
    expect(h.consents[0]).toMatchObject({ granted: true, userId: 'user-a' });
  });
});

describe('PDPL export and erasure', () => {
  it('grant on phone A, change to phone B, grant on B: export lists both, erasure removes both', async () => {
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true }); // phone A
    h.users[0]!.phone = '01112345678'; // changed to B, proven by a delivered order
    h.orders.push({
      storeId: S,
      customerId: 'user-a',
      status: 'delivered',
      shippingAddress: { phone: '01112345678' },
    });
    await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-a', { consent: true }); // phone B
    expect(h.consents).toHaveLength(2);
    expect(await WhatsAppConsentService.exportForAccount(S, 'user-a')).toHaveLength(2);
    const n = await WhatsAppConsentService.eraseForAccount(
      fakePrisma as any,
      S,
      'user-a',
      (await key('01112345678'))!
    );
    expect(n).toBe(2);
    expect(h.consents).toHaveLength(0);
  });

  it("erasing X keeps another account's row and a STOP opt-out on a number X never proved", async () => {
    h.consents.push(
      { storeId: S, buyerKey: '1'.repeat(64), userId: 'user-x', granted: true },
      {
        storeId: S,
        buyerKey: '2'.repeat(64),
        userId: 'user-x',
        granted: false,
        revokedSource: 'whatsapp',
      },
      { storeId: S, buyerKey: '3'.repeat(64), userId: 'user-y', granted: true },
      {
        storeId: S,
        buyerKey: '4'.repeat(64),
        userId: null,
        granted: false,
        revokedSource: 'whatsapp',
      }
    );
    // X's current number is unproven: no key is passed
    await WhatsAppConsentService.eraseForAccount(fakePrisma as any, S, 'user-x', undefined);
    expect(h.consents.map(r => [r.buyerKey[0], r.userId])).toEqual([
      ['2', null], // opt-out kept, owner cleared
      ['3', 'user-y'],
      ['4', null],
    ]);
  });

  it('another account cannot export or erase a row it did not prove', async () => {
    h.consents.push({ storeId: S, buyerKey: '5'.repeat(64), userId: 'user-x', granted: true });
    expect(await WhatsAppConsentService.exportForAccount(S, 'user-y')).toHaveLength(0);
    expect(
      await WhatsAppConsentService.eraseForAccount(fakePrisma as any, S, 'user-y', undefined)
    ).toBe(0);
    expect(h.consents).toHaveLength(1);
  });
});
