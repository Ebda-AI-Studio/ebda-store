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
  directory: [
    { id: 'baseline-only', wbsEnabled: false },
    { id: 'row-only', wbsEnabled: false },
    { id: 'free-no-entitlement', wbsEnabled: false },
  ],
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    cart: {
      findMany: async () => {
        m.seen.push(m.scope);
        return [];
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
  acrossStoresFlat: async () => [],
  withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  currentStoreId: () => m.scope,
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: async (id: string, key: string) =>
      key === 'abandoned_cart' && m.entitled.has(id),
  },
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/notification-dispatcher.service', () => ({ notificationDispatcher: {} }));
vi.mock('@api/services/bundle.service', () => ({ resolveBundle: vi.fn() }));
vi.mock('@api/services/wbs-bridge.service', () => ({
  wbsBridgeService: {},
  WbsUnauthorizedError: class extends Error {},
}));
vi.mock('@api/services/encryption.service', () => ({ encryption: {} }));
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
