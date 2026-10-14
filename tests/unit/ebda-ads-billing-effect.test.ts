/**
 * Ebda own-ads tracking: a confirmed subscription payment queues a Purchase conversion for the
 * store OWNER with the deterministic dedup id, and a failing enqueue never breaks billing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A plain function, not vi.fn(): the global afterEach(vi.restoreAllMocks) re-surfaces a spy's
// rejected result as a test failure even though the code under test caught it.
const { state, logger } = vi.hoisted(() => ({
  state: { calls: [] as unknown[], impl: async (_req: unknown): Promise<void> => undefined },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({ default: logger }));
vi.mock('@api/services/ebda-ads-emit', () => ({
  emitEbdaConversion: (req: unknown) => {
    state.calls.push(req);
    return state.impl(req);
  },
}));
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () => ({
          name: 'Shop',
          slug: 'shop',
          domain: null,
          settings: null,
          ownerId: 'owner-1',
          owner: { email: 'o@x.co' },
        }),
      },
      storeSubscription: { findUnique: async () => ({ planCode: 'growth' }) },
      plan: { findMany: async () => [] },
    }),
}));
vi.mock('../../apps/api/src/config', () => ({ config: { adminUrl: 'https://store.ebda.app' } }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/socket.service', () => ({ socketService: { notifyStore: vi.fn() } }));
vi.mock('@api/services/feature.service', () => ({ featureService: { invalidateCache: vi.fn() } }));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/services/billing/account.service', () => ({
  reconcileStoreAccess: vi.fn(),
  instapayDetails: vi.fn(),
}));
vi.mock('@api/services/billing/manual-config', () => ({ supportContact: () => ({}) }));

import { runBillingEffects } from '@api/services/billing/billing-notify';

beforeEach(() => {
  state.calls = [];
  state.impl = async () => undefined;
});

describe('subscription_paid billing effect', () => {
  it('emits Purchase for the owner with the sub_<billingEventId> dedup id', async () => {
    await runBillingEffects([{ kind: 'subscription_paid', storeId: 's1', billingEventId: 'b1' }]);
    expect(state.calls).toEqual([
      {
        name: 'Purchase',
        eventId: 'sub_b1',
        userId: 'owner-1',
        storeId: 's1',
        billingEventId: 'b1',
      },
    ]);
  });
  it('an emit that throws is swallowed by the effect runner (billing is never blocked)', async () => {
    state.impl = async () => {
      throw new Error('boom');
    };
    await expect(
      runBillingEffects([{ kind: 'subscription_paid', storeId: 's1', billingEventId: 'b1' }])
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'subscription_paid' }),
      expect.stringContaining('effect failed')
    );
  });
});
