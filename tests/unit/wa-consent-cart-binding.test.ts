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
  upsert: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    cart: { findFirst: async ({ where }: any) => h.carts.find(r => matches(r, where)) ?? null },
    user: { findFirst: async ({ where }: any) => h.users.find(r => matches(r, where)) ?? null },
    storeWhatsAppConsent: { upsert: h.upsert },
  },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));

import { WhatsAppConsentService } from '@api/lib/wa/consent';

const S = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
  h.upsert.mockReset().mockResolvedValue({});
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

  it("a different session cannot opt in or revoke: the session cart must be the caller's", async () => {
    for (const consent of [true, false]) {
      // user-b with user-a's session id
      expect(
        await WhatsAppConsentService.recordForCart(S, 'sess-a', 'user-b', { consent })
      ).toEqual({
        status: 'no_cart',
      });
    }
    expect(
      await WhatsAppConsentService.recordForCart(S, 'unknown', 'user-a', { consent: true })
    ).toEqual({
      status: 'no_cart',
    });
    expect(h.upsert).not.toHaveBeenCalled();
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

describe('the route', () => {
  const src = readFileSync('apps/api/src/routes/public.routes.ts', 'utf8');
  const block = src.slice(
    src.indexOf("'/cart/whatsapp-optin'") - 200,
    src.indexOf('// POST /cart/restore')
  );

  it('has no phone in its body schema (strict: a body phone is rejected, never used)', () => {
    const schema = block.slice(
      block.indexOf('cartWhatsAppOptInSchema'),
      block.indexOf('router.post')
    );
    expect(schema).not.toMatch(/phone/i);
    expect(schema).toContain('.strict()');
    expect(block).not.toMatch(/body\.phone|req\.body\.phone/);
  });

  it('requires a signed-in customer and rate-limits per IP+session and per store', () => {
    expect(block).toContain('optionalAuthenticate');
    expect(block).toContain('LOGIN_REQUIRED');
    expect(block).toContain('cartLimiter');
    expect(block).toContain('newsletterLimiter');
    expect(block).toContain('whatsappConsentStoreLimiter');
    expect(block).toContain("source: 'checkout'");
  });
});
