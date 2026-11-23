/**
 * S3-O7: the post-payment fan-out for an order a courier statement marked paid is DEFERRED to the request's commit
 * and awaited, never fired inside the open transaction and never dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  queued: [] as Array<() => Promise<unknown>>,
  importCodRemittances: vi.fn(),
}));

vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeStock: async () => ({ importCodRemittances: h.importCodRemittances }),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => h.send(...a) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// the "commit": work is queued and only runs when the test flushes it
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (_name: string, run: () => Promise<unknown>) => {
    h.queued.push(run);
    return Promise.resolve(null);
  },
}));

const CSV = 'tracking_number,collected,fee,date,reference\nT1,50.00,0.00,2026-10-01,L1';

beforeEach(() => {
  vi.clearAllMocks();
  h.queued.length = 0;
  h.send.mockResolvedValue(undefined);
  h.importCodRemittances.mockResolvedValue({
    inserted: 1,
    duplicates: 0,
    unmatched: 0,
    settled: [{ orderId: 'o1', paymentId: 'p1' }],
    flagged: [],
  });
});

describe('COD statement fan-out', () => {
  it('is deferred until commit, then sent once per settled order', async () => {
    const { CodReconciliationService } = await import('@api/services/cod-reconciliation.service');
    await new CodReconciliationService().importSettlement('s1', 'bosta', CSV);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queued).toHaveLength(1);
    await Promise.all(h.queued.map(f => f()));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith({
      name: 'order/created',
      data: { orderId: 'o1', storeId: 's1', paymentMethod: 'cod', locale: undefined },
    });
  });

  it('a statement that settles nothing defers nothing', async () => {
    h.importCodRemittances.mockResolvedValue({
      inserted: 0,
      duplicates: 1,
      unmatched: 0,
      settled: [],
      flagged: [],
    });
    const { CodReconciliationService } = await import('@api/services/cod-reconciliation.service');
    await new CodReconciliationService().importSettlement('s1', 'bosta', CSV);
    expect(h.queued).toHaveLength(0);
  });
});
