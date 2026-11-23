/**
 * issue 2035 (owner decision 2026-10-01): the abandoned-cart recovery LINK and
 * its dead public endpoint are removed; the abandoned-cart REPORT stays.
 *
 * - A reminder links to the store's plain `/cart` — no `?recover=&sig=`.
 * - `GET /stores/public/:storeId/cart/recover/:id` is no longer routed.
 * - The report's recovery figures are MEASURED (issue 2356): order creation
 *   marks the open abandoned cart `recovered`, so they are last-touch
 *   "ordered later" figures, not `null`.
 *
 * Mutation-proof: restoring the signed URL reddens the first case; restoring
 * the route the second; nulling the recovery figures the third.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(async () => undefined),
  update: vi.fn(async () => ({})),
  groupBy: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: { abandonedCart: { update: h.update, groupBy: h.groupBy }, $queryRaw: h.queryRaw },
  // the recovered-revenue SQL splices the shared revenue definition through Prisma.raw (REVENUE-DEF-1)
  Prisma: { raw: (sql: string) => ({ sql }) },
  withRlsBypass: vi.fn(),
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: h.dispatch },
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/bundle.service', () => ({ resolveBundle: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://ebda.app', encryptionKey: 'k'.repeat(32) },
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

  it('the report measures last-touch recovery (issue 2356), revenue from revenue-countable orders only', async () => {
    h.groupBy.mockResolvedValue([
      { status: 'step1_sent', _count: { id: 3 } },
      { status: 'expired', _count: { id: 4 } },
      { status: 'recovered', _count: { id: 1 } },
    ]);
    h.queryRaw.mockResolvedValue([{ revenue: 12_500n }]);
    const stats = await abandonedCartService.getStats('store-1');
    expect(stats).toEqual({
      byStatus: { step1_sent: 3, expired: 4, recovered: 1 },
      totalAbandoned: 8,
      totalRecovered: 1,
      recoveryRate: 12.5,
      recoveredRevenue: 12_500,
    });
    // the SQL text with every Prisma.raw fragment (the shared REVENUE-DEF-1 predicate and net-amount SQL) spliced in
    const [strings, ...values] = h.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.reduce((acc, part, i) => {
      const v = values[i];
      const frag =
        v && typeof v === 'object' && 'sql' in v
          ? (v as { sql: string }).sql
          : i < values.length
            ? '?'
            : '';
      return acc + part + frag;
    }, '');
    expect(sql).toMatch(/JOIN public\.orders o ON o\.id = ac\.recovered_order_id/);
    // the revenue-countable definition: cancelled / refunded / awaiting InstaPay orders and failed / refunded payments are out
    expect(sql).toMatch(
      /o\.status NOT IN \('cancelled', 'refunded', 'awaiting_payment_confirmation'\)/
    );
    expect(sql).toMatch(/o\.payment_status NOT IN \('failed', 'refunded'\)/);
    // and the amount is the NET of refunds (the shared refund joins are present)
    expect(sql).toMatch(/LEFT JOIN \(SELECT order_id, SUM\(refund_amount\)/);
    expect(values.filter(v => typeof v === 'string')).toEqual(['store-1', 'store-1']);
  });

  it('an empty store reads 0 (a real zero), not unknown', async () => {
    h.groupBy.mockResolvedValue([]);
    h.queryRaw.mockResolvedValue([{ revenue: 0n }]);
    const stats = await abandonedCartService.getStats('store-1');
    expect(stats).toMatchObject({ totalRecovered: 0, recoveryRate: 0, recoveredRevenue: 0 });
  });

  it('order creation is the attribution writer the report reads', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/services/order.service.ts'),
      'utf8'
    );
    expect(src).toMatch(
      /status: 'recovered',\s+recoveredAt: new Date\(\),\s+recoveredOrderId: newOrder\.id/
    );
  });
});
