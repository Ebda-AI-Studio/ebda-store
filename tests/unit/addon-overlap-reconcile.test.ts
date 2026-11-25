/**
 * Daily reconcile of overlapping PAID add-on terms (the rare stalled-settlement case, review of #797): a P1 with the store id,
 * both billing event ids and the overlap in days so a super admin can refund the overlap; the same overlap alerts once.
 * Deterministic: the fake ledger decides everything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  events: [] as Array<Record<string, any>>,
  keys: new Set<string>(),
  alert: vi.fn(async () => undefined),
  findManyCalls: [] as any[],
}));

vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/platform/billing-d1', () => ({
  onD1: async () => false,
  claimAddonMarkerD1: vi.fn(),
  setTermEndOnceD1: vi.fn(),
  acrossBilling: async (fn: (s?: string) => Promise<unknown>) => [
    { storeId: 's1', value: await fn('s1') },
  ],
}));
const fakeTx = () => ({
  billingEvent: {
    findMany: vi.fn(async (args: any) => {
      h.findManyCalls.push(args);
      const w = args.where;
      return h.events
        .filter(
          e =>
            e.storeId === w.storeId &&
            e.type === 'upgrade' &&
            e.status === 'succeeded' &&
            e.planCode.startsWith(w.planCode.startsWith) &&
            e.forPeriodEnd > w.forPeriodEnd.gt &&
            (w.id?.gt === undefined || e.id > w.id.gt)
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, args.take);
    }),
    createMany: vi.fn(async ({ data }: any) => {
      const k = data[0].idempotencyKey;
      if (h.keys.has(k)) return { count: 0 };
      h.keys.add(k);
      h.events.push({ ...data[0], status: 'succeeded' });
      return { count: 1 };
    }),
  },
});
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (t: unknown) => unknown) => fn(fakeTx()),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
}));

import { reconcileAddonOverlaps } from '@api/services/billing/addon-overlap';

const NOW = new Date('2027-03-01T10:00:00.000Z');
const DAY = 86_400_000;
const term = (id: string, endInDays: number, over: Record<string, any> = {}) => ({
  id,
  storeId: 's1',
  type: 'upgrade',
  status: 'succeeded',
  planCode: 'addon:feature:floating_widget',
  forPeriodEnd: new Date(NOW.getTime() + endInDays * DAY),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.events = [];
  h.keys = new Set();
  h.findManyCalls = [];
});

describe('overlapping paid add-on terms', () => {
  it('raises ONE P1 naming the store, both billing events and the overlap in days', async () => {
    // A: ends in 20d (started 10d ago). B: ends in 45d (started 15d from now... start = end - 30d = +15d): no overlap with A
    // here B ends in 35d: starts +5d, A ends +20d -> overlap 15 days
    h.events = [term('ev-a', 20), term('ev-b', 35)];
    const out = await reconcileAddonOverlaps(NOW);
    expect(out.alerted).toBe(1);
    expect(h.alert).toHaveBeenCalledTimes(1);
    const a = (h.alert.mock.calls[0] as any[])[0];
    expect(a.level).toBe('p1');
    expect(a.body).toContain('s1');
    expect(a.body).toContain('ev-a');
    expect(a.body).toContain('ev-b');
    expect(a.body).toContain('15 days');
  });

  it('touching terms (B starts exactly where A ends) are NOT an overlap', async () => {
    h.events = [term('ev-a', 20), term('ev-b', 50)];
    expect((await reconcileAddonOverlaps(NOW)).alerted).toBe(0);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('a different add-on, or a refunded/failed term, never overlaps', async () => {
    h.events = [
      term('ev-a', 20),
      term('ev-b', 35, { planCode: 'addon:feature:loyalty' }),
      term('ev-c', 35, { status: 'refunded' }),
    ];
    expect((await reconcileAddonOverlaps(NOW)).alerted).toBe(0);
  });

  it('a replay raises no second alert (the same overlap is recorded once)', async () => {
    h.events = [term('ev-a', 20), term('ev-b', 35)];
    await reconcileAddonOverlaps(NOW);
    const again = await reconcileAddonOverlaps(NOW);
    expect(again.alerted).toBe(0);
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it('the alert carries ids only: no email, no name', async () => {
    h.events = [term('ev-a', 20), term('ev-b', 35)];
    await reconcileAddonOverlaps(NOW);
    const body = (h.alert.mock.calls[0] as any[])[0].body as string;
    expect(body).not.toMatch(/@/);
  });

  it('reads with an explicit select and pages by key, finding an overlap that straddles two pages', async () => {
    h.events = [
      term('ev-1', 20),
      term('ev-2', 90),
      term('ev-3', 120),
      term('ev-4', 35),
      term('ev-5', 150),
    ];
    const out = await reconcileAddonOverlaps(NOW, { pageSize: 2 });
    expect(out.alerted).toBe(1); // ev-1 vs ev-4
    expect(h.findManyCalls.length).toBeGreaterThanOrEqual(3);
    for (const c of h.findManyCalls) {
      expect(c.select).toEqual(expect.objectContaining({ id: true, forPeriodEnd: true }));
      expect(c.take).toBe(2);
    }
  });
});
