/**
 * RECEIVER-CHECK-1 wiring: runExtraction hands the store's expected receivers to the reader, stores only the yes / no,
 * logs a P2 (never the receiver text) when there is nothing to compare with, and a model error ends in manual review
 * (`failed`), never an approval. Database, storage and the model are stubs: what is asserted is the service's behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: {
    id: 'r1',
    kind: 'order',
    orderId: 'o1',
    storageKey: 'k',
    mimeType: 'image/png',
    extractionStatus: 'pending',
  } as Record<string, unknown>,
  payment: { metadata: { handle: 'Shop@InstaPay', phone: '+20 101 234 5678' } } as Record<
    string,
    unknown
  > | null,
  updates: [] as Array<Record<string, unknown>>,
  read: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: {
      instapayReceipt: {
        findUnique: vi.fn(async () => h.row),
        updateMany: vi.fn(async (a: Record<string, unknown>) => {
          h.updates.push(a);
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => h.row),
      },
      payment: { findFirst: vi.fn(async () => h.payment) },
    },
  })
);
vi.mock('@api/lib/ai/instapay-receipt-reader', () => ({
  readInstapayReceipt: (...a: unknown[]) => h.read(...a),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    getPrivate: vi.fn(async () => ({ body: Buffer.from('png') })),
    deletePrivate: vi.fn(),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: (...a: unknown[]) => h.warn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/lib/after-tenant-commit', () => ({ deferAfterTenantCommit: vi.fn() }));

import { InstapayReceiptService } from '@api/services/payment-providers/instapay-receipt.service';

const EXT = {
  amountMinor: 5000,
  reference: '123456789012',
  transferDate: null,
  transferTime: null,
  looksEdited: false,
  confidence: 0.9,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.payment = { metadata: { handle: 'Shop@InstaPay', phone: '+20 101 234 5678' } };
  h.row = {
    id: 'r1',
    kind: 'order',
    orderId: 'o1',
    storageKey: 'k',
    mimeType: 'image/png',
    extractionStatus: 'pending',
  };
});

describe('InstapayReceiptService.runExtraction - receiver check', () => {
  it('passes the order payments handle and mobile (normalised) to the reader and stores only the yes / no', async () => {
    h.read.mockResolvedValue({ ...EXT, receiverMatch: true });
    expect(await InstapayReceiptService.runExtraction('s1', 'r1')).toBe('done');
    expect(h.read.mock.calls[0][0].expectedReceivers.sort()).toEqual([
      '1012345678',
      'shop@instapay',
    ]);
    const stored = JSON.stringify(h.updates[0]);
    expect(stored).toContain('"receiverMatch":true');
    expect(stored).not.toMatch(/shop@instapay|1012345678|Shop@InstaPay/i);
  });

  it('a subscription receipt is compared with the platform own InstaPay handle', async () => {
    process.env.EBDA_INSTAPAY_HANDLE = 'ebda@instapay';
    h.row = { ...h.row, kind: 'subscription', orderId: null };
    h.read.mockResolvedValue({ ...EXT, receiverMatch: false });
    await InstapayReceiptService.runExtraction('s1', 'r1');
    expect(h.read.mock.calls[0][0].expectedReceivers).toEqual(['ebda@instapay']);
    expect(JSON.stringify(h.updates[0])).toContain('"receiverMatch":false');
    delete process.env.EBDA_INSTAPAY_HANDLE;
  });

  it('missing expected receiver: the reader gets an empty list, a P2 is logged (no receiver text), the read still completes', async () => {
    h.payment = { metadata: {} };
    h.read.mockResolvedValue({ ...EXT, receiverMatch: null });
    expect(await InstapayReceiptService.runExtraction('s1', 'r1')).toBe('done');
    expect(h.read.mock.calls[0][0].expectedReceivers).toEqual([]);
    const p2 = h.warn.mock.calls.find(c => String(c[1]).includes('[P2]'));
    expect(p2).toBeTruthy();
    expect(JSON.stringify(h.warn.mock.calls)).not.toMatch(/@instapay|\d{10}/);
  });

  it('model error: the read ends `failed` (manual review exactly as today), nothing is approved', async () => {
    h.read.mockRejectedValue(Object.assign(new Error('workers ai down'), { code: 'AI_FAILED' }));
    expect(await InstapayReceiptService.runExtraction('s1', 'r1')).toBe('failed');
    const data = h.updates.map(u => u.data as Record<string, unknown>);
    expect(data.some(d => d.extractionStatus === 'failed')).toBe(true);
    expect(data.some(d => d.status === 'approved' || d.extractionStatus === 'done')).toBe(false);
  });
});
