/**
 * Cart detection uses the EFFECTIVE `abandoned_cart` entitlement (plan baseline OR a
 * store_features row, resolved by featureService), not "has an enabled store_features row".
 * Before, a store whose entitlement came only from its plan had no row and was never swept, so
 * push, SMS and the new email channel silently never fired for it (review item 4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  scope: '',
  seen: [] as string[],
  entitled: new Set<string>(),
  carts: [] as Record<string, any>[],
  findManyArgs: [] as any[],
  created: [] as any[],
  due: [] as Record<string, any>[],
  directory: [{ id: 'baseline-only' }, { id: 'row-only' }, { id: 'free-no-entitlement' }],
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    cart: {
      findMany: async (args: unknown) => {
        m.seen.push(m.scope);
        m.findManyArgs.push(args);
        return m.carts;
      },
    },
    abandonedCart: {
      create: async ({ data }: { data: unknown }) => {
        m.created.push(data);
        return data;
      },
    },
    abandonedCartConfig: { findUnique: async () => null },
    // The OLD query: a row for only one store. The new code must not depend on it.
    storeFeature: { findMany: async () => [{ storeId: 'row-only' }] },
  },
  runInStoreScope: async (id: string, fn: () => Promise<unknown>) => {
    m.scope = id;
    try {
      return await fn();
    } finally {
      m.scope = '';
    }
  },
  storeDirectory: async (filter?: (s: Record<string, unknown>) => boolean) =>
    m.directory.filter(s => (filter ? filter(s) : true)),
  acrossStores: async () => [],
  acrossStoresFlat: async () => m.due,
  withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  currentStoreId: () => m.scope,
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    selectEnabled: async (ids: string[], key: string) =>
      ids.filter(id => key === 'abandoned_cart' && m.entitled.has(id)),
    isFeatureEnabled: async (id: string, key: string) =>
      key === 'abandoned_cart' && m.entitled.has(id),
  },
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/notification-dispatcher.service', () => ({ notificationDispatcher: {} }));
// The resolver reads a customer's price group from the database; this suite is about entitlement and email
// consent, so it prices every line at the product's own price.
vi.mock('@api/services/price-resolver.service', () => ({
  PriceResolver: {
    forBuyer: async () => ({
      priceCart: async (lines: { key: string; product: { price: number }; qty: number }[]) =>
        new Map(lines.map(l => [l.key, { unitMinor: l.product.price }])),
    }),
  },
}));
vi.mock('@api/services/bundle.service', () => ({ resolveBundle: vi.fn() }));
vi.mock('@api/services/cart-recovery-email.service', () => ({
  sweepCartRecoveryEmails: vi.fn(),
  CART_EMAIL_DEFAULT_DELAY_MINUTES: 120,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { abandonedCartService } from '@api/services/abandoned-cart.service';

beforeEach(() => {
  m.seen = [];
  m.entitled = new Set(['baseline-only', 'row-only']);
  m.carts = [];
  m.findManyArgs = [];
  m.created = [];
});

describe('detectNewAbandonments entitlement', () => {
  it('sweeps a store entitled only by its plan baseline (no store_features row)', async () => {
    await abandonedCartService.detectNewAbandonments();
    expect(m.seen).toContain('baseline-only');
  });

  it('sweeps a store entitled by an override row and skips a store with no entitlement', async () => {
    await abandonedCartService.detectNewAbandonments();
    expect(m.seen).toContain('row-only');
    expect(m.seen).not.toContain('free-no-entitlement');
  });
});

describe('guest carts with email consent', () => {
  beforeEach(() => {
    m.entitled = new Set(['baseline-only']); // one store is enough for these cases
  });

  const guestCart = (extra: Record<string, unknown> = {}) => ({
    id: 'cart-g',
    customerId: null,
    sessionId: 'sess_g',
    customer: null,
    items: [],
    bundles: [],
    guestEmail: 'sara@example.com',
    guestEmailConsentAt: new Date(),
    ...extra,
  });

  it('the cart query also accepts a guest cart that has an email AND a consent time', async () => {
    await abandonedCartService.detectNewAbandonments();
    const where = JSON.stringify(m.findManyArgs[0].where);
    expect(where).toContain('guestEmail');
    expect(where).toContain('guestEmailConsentAt');
  });

  it('a guest cart becomes an abandoned cart with the email, and no push/SMS sequence', async () => {
    m.carts = [guestCart()];
    await abandonedCartService.detectNewAbandonments();
    expect(m.created).toHaveLength(1);
    expect(m.created[0]).toMatchObject({
      cartId: 'cart-g',
      customerEmail: 'sara@example.com',
      nextStepAt: null, // push/SMS steps need a customer; only the email channel serves a guest
    });
  });

  it('a logged-in customer keeps their push/SMS sequence; a consented checkout email wins for the email', async () => {
    m.carts = [
      guestCart({
        id: 'cart-c',
        customerId: 'u1',
        customer: {
          id: 'u1',
          firstName: 'S',
          lastName: 'A',
          email: 'acct@example.com',
          phone: null,
        },
      }),
    ];
    await abandonedCartService.detectNewAbandonments();
    expect(m.created[0].customerEmail).toBe('sara@example.com');
    expect(m.created[0].nextStepAt).toBeInstanceOf(Date);
  });
});

describe('processReminders re-checks the entitlement live before it sends', () => {
  it('a store downgraded after detection gets no reminder; an entitled one still does', async () => {
    m.entitled = new Set(['baseline-only']); // 'row-only' was downgraded mid-run
    m.due = ['baseline-only', 'row-only'].map(storeId => ({
      id: `ac-${storeId}`,
      storeId,
      status: 'pending',
      nextStepAt: new Date(0),
    }));
    const send = vi.spyOn(abandonedCartService, 'sendStep').mockResolvedValue(undefined);
    await abandonedCartService.processReminders();
    expect(send.mock.calls.map(c => c[0].storeId)).toEqual(['baseline-only']);
    send.mockRestore();
    m.due = [];
  });
});
