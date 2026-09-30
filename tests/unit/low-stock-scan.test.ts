/**
 * Unit tests for the low-stock scan service.
 *
 * Exercises:
 *  - Sentinel dedup logic: alert once, skip on re-scan, clear on restock.
 *  - Digest building: which products appear, which are filtered out.
 *  - Redis fail-open behaviour: when Redis is unavailable, scan still runs.
 *
 * DB is fully mocked — no network or Postgres required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be at top (vi.mock is hoisted by Vitest)
// ---------------------------------------------------------------------------

// vi.hoisted() runs BEFORE vi.mock() factories — use it to create shared
// mutable objects that the factories and test bodies both need to reference.
const { mockRedisClient, mockTx } = vi.hoisted(() => {
  // The scan reads/writes sentinels in batched pipelines. The pipeline mock
  // records queued ops and, on exec(), delegates to the same exists/setex/del
  // mocks the single-key helper tests use — so per-product `mockResolvedValueOnce`
  // chains and `toHaveBeenCalledWith` assertions keep working unchanged.
  const mockRedisClient = {
    exists: vi.fn().mockResolvedValue(0),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    // SET … EX … NX — the scan's pending claim. 'OK' = claimed, null = held.
    set: vi.fn().mockResolvedValue('OK'),
    pipeline: vi.fn(),
  };
  mockRedisClient.pipeline.mockImplementation(() => {
    const ops: Array<['exists' | 'setex' | 'del' | 'set', unknown[]]> = [];
    const p = {
      exists: (key: string) => {
        ops.push(['exists', [key]]);
        return p;
      },
      setex: (...args: unknown[]) => {
        ops.push(['setex', args]);
        return p;
      },
      del: (key: string) => {
        ops.push(['del', [key]]);
        return p;
      },
      set: (...args: unknown[]) => {
        ops.push(['set', args]);
        return p;
      },
      exec: async () => {
        const res: Array<[Error | null, unknown]> = [];
        for (const [op, args] of ops) {
          if (op === 'exists') res.push([null, await mockRedisClient.exists(args[0])]);
          else if (op === 'setex') {
            await mockRedisClient.setex(...(args as [string, number, string]));
            res.push([null, 'OK']);
          } else if (op === 'set') {
            res.push([null, await mockRedisClient.set(...args)]);
          } else {
            await mockRedisClient.del(args[0]);
            res.push([null, 1]);
          }
        }
        return res;
      },
    };
    return p;
  });

  const mockTx = {
    store: { findUnique: vi.fn() },
    product: { findMany: vi.fn() },
  };

  return { mockRedisClient, mockTx };
});

vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: vi.fn(() => mockRedisClient),
    isAvailable: vi.fn(() => true),
  },
}));

// withRlsBypass passes its callback a `tx` argument that mirrors prisma.
// We capture the callback and call it immediately with the hoisted mock tx.
vi.mock('@force/database', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRlsBypass: vi.fn(async (fn: (tx: any) => unknown) => fn(mockTx)),
  prisma: mockTx,
}));

vi.mock('@api/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  runLowStockScan,
  isSentinelSet,
  setSentinel,
  clearSentinel,
  commitLowStockAlertSentinels,
  SENTINEL_KEY_PREFIX,
  SENTINEL_TTL_SECONDS,
  PENDING_CLAIM_TTL_SECONDS,
} from '@api/services/inventory/low-stock-scan.service';

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-1',
    name: 'Test Store',
    settings: {},
    owner: { email: 'owner@test.com' },
    ...overrides,
  };
}

function makeProduct(
  overrides: Partial<{
    id: string;
    name: string;
    nameAr: string | null;
    inventory: number;
    lowStockThreshold: number;
  }> = {}
) {
  return {
    id: 'prod-1',
    name: 'Test Product',
    nameAr: null,
    inventory: 3,
    lowStockThreshold: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: sentinel helpers
// ---------------------------------------------------------------------------

describe('sentinel helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisClient.exists.mockResolvedValue(0);
    mockRedisClient.setex.mockResolvedValue('OK');
    mockRedisClient.del.mockResolvedValue(1);
  });

  it('isSentinelSet returns false when key does not exist', async () => {
    mockRedisClient.exists.mockResolvedValue(0);
    const result = await isSentinelSet('store-1', 'prod-1');
    expect(result).toBe(false);
    expect(mockRedisClient.exists).toHaveBeenCalledWith(`${SENTINEL_KEY_PREFIX}:store-1:prod-1`);
  });

  it('isSentinelSet returns true when key exists', async () => {
    mockRedisClient.exists.mockResolvedValue(1);
    const result = await isSentinelSet('store-1', 'prod-1');
    expect(result).toBe(true);
  });

  it('isSentinelSet returns false (fail-open) when redis throws', async () => {
    mockRedisClient.exists.mockRejectedValue(new Error('timeout'));
    const result = await isSentinelSet('store-1', 'prod-1');
    expect(result).toBe(false);
  });

  it('setSentinel calls setex with correct key and 30-day TTL', async () => {
    await setSentinel('store-1', 'prod-1');
    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      `${SENTINEL_KEY_PREFIX}:store-1:prod-1`,
      SENTINEL_TTL_SECONDS,
      '1'
    );
  });

  it('clearSentinel calls del with the correct key', async () => {
    await clearSentinel('store-1', 'prod-1');
    expect(mockRedisClient.del).toHaveBeenCalledWith(`${SENTINEL_KEY_PREFIX}:store-1:prod-1`);
  });

  it('setSentinel is a no-op (no throw) when redis is unavailable', async () => {
    mockRedisClient.setex.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(setSentinel('store-1', 'prod-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: runLowStockScan — digest building
// ---------------------------------------------------------------------------

describe('runLowStockScan — digest building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisClient.exists.mockResolvedValue(0);
    mockRedisClient.setex.mockResolvedValue('OK');
    mockRedisClient.del.mockResolvedValue(1);
    mockTx.store.findUnique.mockResolvedValue(makeStore());
  });

  it('includes a product that is in-stock-but-low (0 < inventory <= threshold)', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', inventory: 3, lowStockThreshold: 10 }),
    ]);
    const result = await runLowStockScan('store-1');
    expect(result.alertedProducts).toHaveLength(1);
    expect(result.alertedProducts[0].productId).toBe('p1');
    expect(result.alertedProducts[0].inventory).toBe(3);
    expect(result.alertedProducts[0].lowStockThreshold).toBe(10);
  });

  it('excludes a product with inventory === 0 (out-of-stock, different alert)', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p-oos', inventory: 0, lowStockThreshold: 5 }),
    ]);
    const result = await runLowStockScan('store-1');
    expect(result.alertedProducts).toHaveLength(0);
  });

  it('excludes a product with inventory > threshold (healthy)', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p-ok', inventory: 100, lowStockThreshold: 10 }),
    ]);
    const result = await runLowStockScan('store-1');
    expect(result.alertedProducts).toHaveLength(0);
  });

  it('includes product exactly at threshold (inventory === threshold)', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p-boundary', inventory: 10, lowStockThreshold: 10 }),
    ]);
    const result = await runLowStockScan('store-1');
    expect(result.alertedProducts).toHaveLength(1);
    expect(result.alertedProducts[0].productId).toBe('p-boundary');
  });

  it('resolves the store owner email as recipientEmail', async () => {
    mockTx.product.findMany.mockResolvedValue([]);
    mockTx.store.findUnique.mockResolvedValue(makeStore({ owner: { email: 'boss@store.com' } }));
    const result = await runLowStockScan('store-1');
    expect(result.recipientEmail).toBe('boss@store.com');
  });

  it('returns null recipientEmail when store not found', async () => {
    mockTx.store.findUnique.mockResolvedValue(null);
    const result = await runLowStockScan('store-1');
    expect(result.recipientEmail).toBeNull();
    expect(result.alertedProducts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: runLowStockScan — sentinel dedup
// ---------------------------------------------------------------------------

describe('runLowStockScan — sentinel dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisClient.exists.mockResolvedValue(0);
    mockRedisClient.setex.mockResolvedValue('OK');
    mockRedisClient.del.mockResolvedValue(1);
    mockTx.store.findUnique.mockResolvedValue(makeStore());
  });

  it('alert-once: first scan includes the product in the digest', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', inventory: 3, lowStockThreshold: 10 }),
    ]);
    mockRedisClient.exists.mockResolvedValue(0); // sentinel not set

    const result = await runLowStockScan('store-1');

    expect(result.alertedProducts).toHaveLength(1);
    expect(result.skippedCount).toBe(0);
  });

  // Regression for #187: the scan used to set the sentinel itself, before
  // any email had gone out. If the digest send later failed permanently
  // (retries exhausted — a bad owner email, a delivery outage), the product
  // was marked "alerted" with no notification ever having been delivered,
  // and stayed silently suppressed until it happened to cross the
  // threshold a second time. The scan step now only DETECTS; the caller
  // commits the sentinel via commitLowStockAlertSentinels() after a
  // successful send.
  it("does NOT set the sentinel itself — that is the caller's job, after a successful send", async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', inventory: 3, lowStockThreshold: 10 }),
    ]);
    mockRedisClient.exists.mockResolvedValue(0);

    const result = await runLowStockScan('store-1');

    expect(result.alertedProducts).toHaveLength(1);
    expect(mockRedisClient.setex).not.toHaveBeenCalled();
  });

  it('commitLowStockAlertSentinels() sets the sentinel — called by the caller AFTER a successful send', async () => {
    await commitLowStockAlertSentinels('store-1', ['p1']);

    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      `${SENTINEL_KEY_PREFIX}:store-1:p1`,
      SENTINEL_TTL_SECONDS,
      '1'
    );
  });

  // P2 on PR #1977: with the sentinel committed only after the send, two
  // overlapping scans (cron + "Scan now", or a double click) both read "unset"
  // and would both email the same digest. The scan now claims each hit with a
  // short SET NX; only the winner includes it.
  it('claims each new hit with a short pending SET NX, not the 30-day sentinel', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', inventory: 3, lowStockThreshold: 10 }),
    ]);
    mockRedisClient.exists.mockResolvedValue(0);

    await runLowStockScan('store-1');

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      `${SENTINEL_KEY_PREFIX}:store-1:p1`,
      'pending',
      'EX',
      PENDING_CLAIM_TTL_SECONDS,
      'NX'
    );
    expect(PENDING_CLAIM_TTL_SECONDS).toBeLessThan(SENTINEL_TTL_SECONDS);
  });

  it('a product another in-flight scan already claimed is left out of the digest', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', inventory: 3, lowStockThreshold: 10 }),
      makeProduct({ id: 'p2', inventory: 2, lowStockThreshold: 10 }),
    ]);
    mockRedisClient.exists.mockResolvedValue(0);
    mockRedisClient.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const result = await runLowStockScan('store-1');

    expect(result.alertedProducts.map(p => p.productId)).toEqual(['p1']);
    expect(result.skippedCount).toBe(1);
  });

  it('dedup: second scan with sentinel set skips the product', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', inventory: 3, lowStockThreshold: 10 }),
    ]);
    mockRedisClient.exists.mockResolvedValue(1); // sentinel already set

    const result = await runLowStockScan('store-1');

    expect(result.alertedProducts).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
    // setex should NOT be called again (already set)
    expect(mockRedisClient.setex).not.toHaveBeenCalled();
  });

  it('restock clears sentinel: product above threshold with existing sentinel', async () => {
    mockTx.product.findMany.mockResolvedValue([
      // Now healthy — inventory > threshold
      makeProduct({ id: 'p1', inventory: 50, lowStockThreshold: 10 }),
    ]);
    // Sentinel was set from a previous alert
    mockRedisClient.exists.mockResolvedValue(1);

    const result = await runLowStockScan('store-1');

    expect(result.alertedProducts).toHaveLength(0);
    expect(result.clearedCount).toBe(1);
    expect(mockRedisClient.del).toHaveBeenCalledWith(`${SENTINEL_KEY_PREFIX}:store-1:p1`);
  });

  it('does NOT clear sentinel for healthy product that was never alerted', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', inventory: 100, lowStockThreshold: 10 }),
    ]);
    mockRedisClient.exists.mockResolvedValue(0); // no sentinel = never alerted

    const result = await runLowStockScan('store-1');

    expect(result.clearedCount).toBe(0);
    expect(mockRedisClient.del).not.toHaveBeenCalled();
  });

  it('mixed scan: one new low, one already-alerted, one restocked', async () => {
    mockTx.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p-new', inventory: 2, lowStockThreshold: 10 }), // new low
      makeProduct({ id: 'p-skip', inventory: 1, lowStockThreshold: 10 }), // alerted before
      makeProduct({ id: 'p-ok', inventory: 50, lowStockThreshold: 10 }), // restocked
    ]);
    mockRedisClient.exists
      .mockResolvedValueOnce(0) // p-new: no sentinel
      .mockResolvedValueOnce(1) // p-skip: sentinel set
      .mockResolvedValueOnce(1); // p-ok: sentinel set (was alerted when it was low)

    const result = await runLowStockScan('store-1');

    expect(result.alertedProducts).toHaveLength(1);
    expect(result.alertedProducts[0].productId).toBe('p-new');
    expect(result.skippedCount).toBe(1);
    expect(result.clearedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: email template
// ---------------------------------------------------------------------------

describe('lowStockAlertTemplate', () => {
  it('renders EN subject with item count', async () => {
    const { lowStockAlertTemplate } = await import('@api/services/email-templates/low-stock-alert');
    const subject = lowStockAlertTemplate.subject.en({
      items: [makeProduct(), makeProduct({ id: 'p2' })],
      storeName: 'Test',
      adminUrl: 'https://admin.test',
    });
    expect(subject).toContain('2 products');
  });

  it('renders AR subject (plural)', async () => {
    const { lowStockAlertTemplate } = await import('@api/services/email-templates/low-stock-alert');
    const subject = lowStockAlertTemplate.subject.ar({
      items: [makeProduct(), makeProduct({ id: 'p2' })],
      storeName: 'Test',
      adminUrl: 'https://admin.test',
    });
    expect(subject).toContain('منتجات');
  });

  it('renders EN body with product name and inventory', async () => {
    const { lowStockAlertTemplate } = await import('@api/services/email-templates/low-stock-alert');
    const html = lowStockAlertTemplate.en({
      items: [makeProduct({ name: 'Widget', inventory: 3, lowStockThreshold: 10 })],
      storeName: 'MyStore',
      adminUrl: 'https://admin.test',
    });
    expect(html).toContain('Widget');
    expect(html).toContain('>3<');
    expect(html).toContain('>10<');
  });

  it('renders AR body using nameAr when available', async () => {
    const { lowStockAlertTemplate } = await import('@api/services/email-templates/low-stock-alert');
    const html = lowStockAlertTemplate.ar({
      items: [makeProduct({ name: 'Widget', nameAr: 'ودجت', inventory: 3, lowStockThreshold: 10 })],
      storeName: 'متجر',
      adminUrl: 'https://admin.test',
    });
    expect(html).toContain('ودجت');
    expect(html).not.toContain('Widget');
  });

  it('falls back to name in AR body when nameAr is null', async () => {
    const { lowStockAlertTemplate } = await import('@api/services/email-templates/low-stock-alert');
    const html = lowStockAlertTemplate.ar({
      items: [makeProduct({ name: 'Widget', nameAr: null, inventory: 3, lowStockThreshold: 10 })],
      storeName: 'متجر',
      adminUrl: 'https://admin.test',
    });
    expect(html).toContain('Widget');
  });

  it('escapes XSS in product name', async () => {
    const { lowStockAlertTemplate } = await import('@api/services/email-templates/low-stock-alert');
    const html = lowStockAlertTemplate.en({
      items: [
        makeProduct({
          name: '<script>alert(1)</script>',
          inventory: 1,
          lowStockThreshold: 5,
        }),
      ],
      storeName: 'Test',
      adminUrl: 'https://admin.test',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
