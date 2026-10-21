/**
 * Checkout email opt-in (review item 1): consent record + guest cart email + restore link.
 * In-memory Prisma that evaluates `where`, so dropping a predicate turns a test red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matches, uuid, STORE_A, STORE_B } from '../helpers/campaign-fake-db';

type Row = Record<string, any>;
const h = vi.hoisted(() => {
  process.env.API_URL = 'https://api.test';
  process.env.CART_RESTORE_SECRET = 'unit-test-cart-restore-secret';
  return {
    db: {
      carts: [] as Row[],
      items: [] as Row[],
      bundles: [] as Row[],
      subs: [] as Row[],
      configs: [] as Row[],
    },
    addItems: vi.fn(async (..._a: unknown[]) => ({})),
    addBundle: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
    feature: vi.fn(async (..._a: unknown[]) => true),
  };
});
const { db } = h;

function table(rows: () => Row[]) {
  return {
    findFirst: async ({ where }: { where?: Row } = {}) =>
      rows().find(r => matches(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row } = {}) => rows().filter(r => matches(r, where)),
    create: async ({ data }: { data: Row }) => {
      const row = { id: uuid(), ...data };
      rows().push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows().find(x => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows().filter(r => matches(r, where));
      hit.forEach(r => Object.assign(r, data));
      return { count: hit.length };
    },
  };
}
vi.mock('@ebda/database', () => ({
  prisma: {
    cart: table(() => h.db.carts),
    cartItem: table(() => h.db.items),
    cartBundle: table(() => h.db.bundles),
    newsletterSubscriber: table(() => h.db.subs),
    abandonedCartConfig: table(() => h.db.configs),
  },
}));
vi.mock('@api/services/cart.service', () => ({
  CartService: { addItems: h.addItems, addBundle: h.addBundle },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.feature },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  recordCartEmailConsent,
  restoreCartIntoSession,
  cartEmailOptInAvailable,
} from '@api/services/cart-email-optin.service';
import { signCartRestoreToken } from '@api/lib/cart-restore-token';

function mkCart(extra: Row = {}) {
  const c = {
    id: uuid(),
    storeId: STORE_A,
    sessionId: 'sess_a',
    guestEmail: null,
    guestEmailConsentAt: null,
    ...extra,
  };
  db.carts.push(c);
  return c;
}
beforeEach(() => {
  Object.values(db).forEach(a => (a.length = 0));
  h.addItems.mockClear();
  h.addBundle.mockClear();
  h.feature.mockReset().mockResolvedValue(true);
});

describe('recordCartEmailConsent', () => {
  it('ticked box: stores the cart email + consent time and creates a cart_reminders subscriber from checkout', async () => {
    const cart = mkCart();
    const r = await recordCartEmailConsent(STORE_A, 'sess_a', {
      email: ' Sara@Example.com ',
      consent: true,
      language: 'ar',
    });
    expect(r.status).toBe('opted_in');
    expect(cart.guestEmail).toBe('sara@example.com');
    expect(cart.guestEmailConsentAt).toBeInstanceOf(Date);
    expect(db.subs).toHaveLength(1);
    expect(db.subs[0]).toMatchObject({
      storeId: STORE_A,
      email: 'sara@example.com',
      source: 'checkout',
      consentScope: 'cart_reminders',
      isActive: true,
      language: 'ar',
    });
    expect(db.subs[0].consentAt).toBeInstanceOf(Date);
  });

  it('an existing newsletter subscriber keeps the newsletter scope (never downgraded)', async () => {
    mkCart();
    db.subs.push({
      id: uuid(),
      storeId: STORE_A,
      email: 'sara@example.com',
      isActive: true,
      unsubscribedAt: null,
      consentScope: 'newsletter',
      source: 'footer',
    });
    expect(
      (
        await recordCartEmailConsent(STORE_A, 'sess_a', {
          email: 'sara@example.com',
          consent: true,
        })
      ).status
    ).toBe('opted_in');
    expect(db.subs).toHaveLength(1);
    expect(db.subs[0].consentScope).toBe('newsletter');
    expect(db.subs[0].source).toBe('footer');
  });

  it('NEVER re-activates an unsubscribed address, and records no cart consent for it', async () => {
    const cart = mkCart();
    const gone = {
      id: uuid(),
      storeId: STORE_A,
      email: 'sara@example.com',
      isActive: false,
      unsubscribedAt: new Date(),
      consentScope: 'newsletter',
    };
    db.subs.push(gone);
    const r = await recordCartEmailConsent(STORE_A, 'sess_a', {
      email: 'sara@example.com',
      consent: true,
    });
    expect(r.status).toBe('unsubscribed');
    expect(gone.isActive).toBe(false);
    expect(cart.guestEmail).toBeNull();
  });

  it('matches an existing subscriber case-insensitively (no duplicate row)', async () => {
    mkCart();
    db.subs.push({
      id: uuid(),
      storeId: STORE_A,
      email: 'Sara@Example.com',
      isActive: true,
      unsubscribedAt: null,
      consentScope: 'newsletter',
    });
    await recordCartEmailConsent(STORE_A, 'sess_a', { email: 'sara@example.com', consent: true });
    expect(db.subs).toHaveLength(1);
  });

  it("unticking withdraws the cart's consent but leaves the subscriber row alone", async () => {
    const cart = mkCart({ guestEmail: 'sara@example.com', guestEmailConsentAt: new Date() });
    db.subs.push({
      id: uuid(),
      storeId: STORE_A,
      email: 'sara@example.com',
      isActive: true,
      unsubscribedAt: null,
      consentScope: 'cart_reminders',
    });
    expect(
      (
        await recordCartEmailConsent(STORE_A, 'sess_a', {
          email: 'sara@example.com',
          consent: false,
        })
      ).status
    ).toBe('withdrawn');
    expect(cart.guestEmail).toBeNull();
    expect(cart.guestEmailConsentAt).toBeNull();
    expect(db.subs[0].isActive).toBe(true);
  });

  it("only touches this session's cart in this store", async () => {
    const other = mkCart({ sessionId: 'sess_b' });
    const otherStore = mkCart({ storeId: STORE_B });
    expect(
      (await recordCartEmailConsent(STORE_A, 'sess_none', { email: 'a@b.co', consent: true }))
        .status
    ).toBe('no_cart');
    expect(other.guestEmail).toBeNull();
    expect(otherStore.guestEmail).toBeNull();
    expect(db.subs).toHaveLength(0);
  });

  it('rejects a malformed address', async () => {
    mkCart();
    expect(
      (await recordCartEmailConsent(STORE_A, 'sess_a', { email: 'not-an-email', consent: true }))
        .status
    ).toBe('invalid_email');
    expect(db.subs).toHaveLength(0);
  });
});

describe('cartEmailOptInAvailable', () => {
  it('true only when the plan feature is on AND the merchant enabled the email channel', async () => {
    db.configs.push({ storeId: STORE_A, emailEnabled: true });
    expect(await cartEmailOptInAvailable(STORE_A)).toBe(true);
    expect(await cartEmailOptInAvailable(STORE_B)).toBe(false);
    h.feature.mockResolvedValue(false);
    expect(await cartEmailOptInAvailable(STORE_A)).toBe(false);
  });
});

describe('restoreCartIntoSession', () => {
  it('re-attaches the source cart lines to the visiting session, once', async () => {
    const src = mkCart({ sessionId: 'sess_old' });
    db.items.push({
      id: uuid(),
      cartId: src.id,
      productId: 'p1',
      variantId: null,
      quantity: 2,
      note: null,
    });
    db.bundles.push({ id: uuid(), cartId: src.id, bundleId: 'b1', quantity: 1 });
    const token = signCartRestoreToken(STORE_A, src.id);
    const r = await restoreCartIntoSession(STORE_A, token, 'sess_new');
    expect(r).toEqual({ restored: true, added: 2 });
    expect(h.addItems).toHaveBeenCalledWith(
      STORE_A,
      'sess_new',
      [{ productId: 'p1', variantId: undefined, quantity: 2, note: null }],
      undefined
    );
    expect(h.addBundle).toHaveBeenCalledWith(STORE_A, 'sess_new', 'b1', 1, undefined);
  });

  it('is idempotent: lines the visiting cart already has are not added again', async () => {
    const src = mkCart({ sessionId: 'sess_old' });
    db.items.push({
      id: uuid(),
      cartId: src.id,
      productId: 'p1',
      variantId: null,
      quantity: 2,
      note: null,
    });
    const mine = mkCart({ sessionId: 'sess_new' });
    db.items.push({
      id: uuid(),
      cartId: mine.id,
      productId: 'p1',
      variantId: null,
      quantity: 2,
      note: null,
    });
    const r = await restoreCartIntoSession(
      STORE_A,
      signCartRestoreToken(STORE_A, src.id),
      'sess_new'
    );
    expect(r).toEqual({ restored: true, added: 0 });
    expect(h.addItems).not.toHaveBeenCalled();
  });

  it('opening the link in the cart own session is a no-op', async () => {
    const src = mkCart({ sessionId: 'sess_a' });
    db.items.push({
      id: uuid(),
      cartId: src.id,
      productId: 'p1',
      variantId: null,
      quantity: 1,
      note: null,
    });
    expect(
      await restoreCartIntoSession(STORE_A, signCartRestoreToken(STORE_A, src.id), 'sess_a')
    ).toEqual({ restored: true, added: 0 });
    expect(h.addItems).not.toHaveBeenCalled();
  });

  it('rejects an invalid or expired token, another store, and a vanished cart', async () => {
    const src = mkCart();
    const tok = signCartRestoreToken(STORE_A, src.id);
    expect((await restoreCartIntoSession(STORE_A, 'garbage', 's')).restored).toBe(false);
    expect((await restoreCartIntoSession(STORE_B, tok, 's')).restored).toBe(false);
    const expired = signCartRestoreToken(STORE_A, src.id, Date.now() - 8 * 24 * 3600e3);
    expect((await restoreCartIntoSession(STORE_A, expired, 's')).restored).toBe(false);
    db.carts.length = 0;
    expect((await restoreCartIntoSession(STORE_A, tok, 's')).restored).toBe(false);
    expect(h.addItems).not.toHaveBeenCalled();
  });
});
