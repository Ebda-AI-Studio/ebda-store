/**
 * issue 2035 (owner decision 2026-10-01): the abandoned-cart recovery LINK and
 * its dead public endpoint are removed; the abandoned-cart REPORT stays.
 *
 * - A reminder links to the store's plain `/cart` — no `?recover=&sig=`.
 * - `GET /stores/public/:storeId/cart/recover/:id` is no longer routed.
 * - The report's recovery figures are `null` (not tracked), never a
 *   fabricated 0, because nothing attributes an order to a reminder.
 *
 * Mutation-proof: restoring the signed URL reddens the first case; restoring
 * the route the second; returning 0 for the recovery figures the third.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(async () => undefined),
  update: vi.fn(async () => ({})),
  groupBy: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: { abandonedCart: { update: h.update, groupBy: h.groupBy } },
  withRlsBypass: vi.fn(),
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: h.dispatch },
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/bundle.service', () => ({ resolveBundle: vi.fn() }));
vi.mock('@api/services/wbs-bridge.service', () => ({
  wbsBridgeService: {},
  WbsUnauthorizedError: class extends Error {},
}));
vi.mock('@api/services/encryption.service', () => ({ encryption: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://store.force-ai.co', encryptionKey: 'k'.repeat(32) },
}));

import { abandonedCartService } from '@api/services/abandoned-cart.service';

beforeEach(() => vi.clearAllMocks());

describe('abandoned-cart reminders carry no recovery link (issue 2035)', () => {
  it('links to the plain cart page', async () => {
    vi.spyOn(abandonedCartService, 'getConfig').mockResolvedValue({
      step1Enabled: true,
      step1DelayMinutes: 60,
      step2Enabled: false,
      step2DelayMinutes: 240,
      step3Enabled: false,
      step3DelayMinutes: 1440,
      autoCouponEnabled: false,
    } as never);

    await abandonedCartService.sendStep(
      {
        id: 'ac-1',
        storeId: 'store-1',
        cartTotal: 5000,
        cartItemCount: 2,
        customer: null,
        store: { domain: 'shop.example', slug: 'shop', name: 'Shop' },
      },
      1
    );

    const data = h.dispatch.mock.calls[0][2] as { cartUrl: string };
    expect(data.cartUrl).toBe('https://shop.example/cart');
    expect(data.cartUrl).not.toMatch(/recover=|sig=/);
  });

  it('the public recovery endpoint is no longer routed', async () => {
    vi.doMock('@api/middleware/auth', () => {
      const pass = (_q: unknown, _r: unknown, n: () => void) => n();
      return { authenticate: pass, authorize: () => pass, optionalAuthenticate: pass };
    });
    const { default: router } = await import('@api/routes/abandoned-cart.routes');
    const paths = (router as unknown as { stack: Array<{ route?: { path: string } }> }).stack
      .map(l => l.route?.path)
      .filter(Boolean);
    expect(paths.some(p => /recover/.test(p as string))).toBe(false);
  });

  it('the report returns recovery figures as unknown (null), never 0', async () => {
    h.groupBy.mockResolvedValue([
      { status: 'step1_sent', _count: { id: 3 } },
      { status: 'expired', _count: { id: 2 } },
    ]);
    const stats = await abandonedCartService.getStats('store-1');
    expect(stats).toEqual({
      byStatus: { step1_sent: 3, expired: 2 },
      totalAbandoned: 5,
      totalRecovered: null,
      recoveryRate: null,
      recoveredRevenue: null,
    });
  });
});
