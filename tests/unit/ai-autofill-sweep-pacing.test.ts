/**
 * Task 8 review I4: the daily sweep paces on REAL provider calls (sleep-after-success,
 * AI_BULK_THROTTLE_MS × calls), sleeps nothing for a product that made no call, backs off a full
 * minute window on a provider 429 (not swallowed), and stops the store on a quota cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: (...a: unknown[]) => warn(...a), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const products = [
  { id: 'p1', updatedAt: new Date() },
  { id: 'p2', updatedAt: new Date() },
  { id: 'p3', updatedAt: new Date() },
  { id: 'p4', updatedAt: new Date() },
];
vi.mock('@ebda/database', () => ({
  prisma: { product: { findMany: vi.fn(async () => products) } },
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => ({ theme: {} }) } }),
  hasTenantContext: () => false,
  runInTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  onClosedTenantTxAccess: vi.fn(),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('../../apps/api/src/services/ai.service', () => ({ AIService: {} }));

const { sweepStore, RATE_LIMIT_BACKOFF_MS } =
  await import('../../apps/api/src/services/ai-autofill.service');

const res = (
  r: Partial<{ filled: number; calls: number; rateLimited: boolean; capped: boolean }>
) => ({
  filled: 0,
  skipped: false,
  calls: 0,
  rateLimited: false,
  capped: false,
  ...r,
});

let sleeps: number[];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(() => {
  sleeps = [];
  warn.mockClear();
});

describe('sweepStore pacing (I4)', () => {
  it('sleeps throttle × real calls after each product, and nothing when no call was made', async () => {
    const fill = vi
      .fn()
      .mockResolvedValueOnce(res({ filled: 3, calls: 3 })) // translate + seo + search words
      .mockResolvedValueOnce(res({ calls: 0, skipped: true })) // caught-up product
      .mockResolvedValueOnce(res({ filled: 1, calls: 1 }))
      .mockResolvedValueOnce(res({ calls: 0 }));
    const balance = vi
      .fn()
      .mockResolvedValueOnce({ balanced: false, calls: 0 })
      .mockResolvedValueOnce({ balanced: false, calls: 0 })
      .mockResolvedValueOnce({ balanced: true, calls: 2 })
      .mockResolvedValueOnce({ balanced: false, calls: 0 });
    const out = await sweepStore('s1', { fill, balance, sleep, throttleMs: 100 });
    expect(sleeps).toEqual([300, 100, 200]);
    expect(out).toMatchObject({ products: 4, filled: 5, calls: 6, rateLimited: 0 });
  });

  it('a provider 429 is not swallowed: warn + backoff of a full minute window, then continue', async () => {
    const fill = vi
      .fn()
      .mockResolvedValueOnce(res({ calls: 1, rateLimited: true }))
      .mockResolvedValue(res({ calls: 1 }));
    const balance = vi.fn().mockResolvedValue({ balanced: false, calls: 0 });
    const out = await sweepStore('s1', { fill, balance, sleep, throttleMs: 100 });
    expect(RATE_LIMIT_BACKOFF_MS).toBe(60_000);
    expect(sleeps[0]).toBe(100); // the call that did succeed before the 429
    expect(sleeps[1]).toBe(60_000);
    expect(fill).toHaveBeenCalledTimes(4);
    expect(out.rateLimited).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 's1', rateLimited: 1 }),
      expect.stringMatching(/429/)
    );
  });

  it('a quota cap stops the store (terminal for the day): no further product is tried', async () => {
    const fill = vi
      .fn()
      .mockResolvedValueOnce(res({ calls: 1 }))
      .mockResolvedValueOnce(res({ capped: true }))
      .mockResolvedValue(res({ calls: 1 }));
    const balance = vi.fn().mockResolvedValue({ balanced: false, calls: 0 });
    const out = await sweepStore('s1', { fill, balance, sleep, throttleMs: 100 });
    expect(fill).toHaveBeenCalledTimes(2);
    expect(out.capped).toBe(true);
  });
});
