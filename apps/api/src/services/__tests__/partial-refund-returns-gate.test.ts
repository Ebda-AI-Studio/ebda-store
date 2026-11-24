import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ruling REFUND-GATE-1: refunding money is never plan-gated; the returns workflow (restock) is. The decision is made on the
// server from the order's own lines: only a TRACKED line can restock, an untracked one never blocks a refund.
const m = vi.hoisted(() => ({ isEnabled: vi.fn(), quote: vi.fn() }));

vi.mock('../feature.service', () => ({ featureService: { isFeatureEnabled: m.isEnabled } }));
vi.mock('../../lib/repo-factory', () => ({
  storeMoney: async () => ({ analyticsRefundQuote: m.quote }),
  storeDb: async () => ({}),
}));
vi.mock('../../lib/customer-directory', () => ({}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  ReturnStatus: {},
  ReturnType: {},
  withStore: vi.fn(),
}));
vi.mock('../email.service', () => ({ EmailService: {} }));
vi.mock('../socket.service', () => ({ socketService: {} }));
vi.mock('../../lib/after-tenant-commit', () => ({ deferAfterTenantCommit: vi.fn() }));
vi.mock('../order.service', () => ({ OrderService: {} }));
vi.mock('../wallet.service', () => ({ WalletService: {} }));
vi.mock('../payment.service', () => ({ PaymentService: {} }));

import { ReturnService } from '../return.service';

const quote = (coversWholeOrder = false) => ({
  refundable: 10000,
  coversWholeOrder,
  lines: [
    { orderItemId: 'tee', productId: 'p1', name: 'Tee', trackInventory: true },
    { orderItemId: 'ebook', productId: 'p2', name: 'Ebook', trackInventory: false },
  ],
});
const args = (items: Array<{ orderItemId: string; quantity: number; restock?: boolean }>) => ({
  orderId: 'o1',
  reason: 'damaged',
  refundMethod: 'cash',
  items,
});
const tee = (restock?: boolean) => ({
  orderItemId: 'tee',
  quantity: 1,
  ...(restock === undefined ? {} : { restock }),
});
const ebook = { orderItemId: 'ebook', quantity: 1 }; // the key is absent on the wire, as the admin UI sends it

let adminCreate: ReturnType<typeof vi.spyOn>;
let complete: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.quote.mockResolvedValue(quote());
  adminCreate = vi
    .spyOn(ReturnService, 'adminCreate')
    .mockResolvedValue({ id: 'r1', status: 'received' } as never);
  complete = vi
    .spyOn(ReturnService, 'complete')
    .mockResolvedValue({ id: 'r1', returnNumber: 'RET-1', refundAmount: 10000 } as never);
});

describe('adminPartialRefund plan gate (REFUND-GATE-1)', () => {
  it('plan without returns: an untracked line (restock key absent) is REFUNDED, not blocked', async () => {
    m.isEnabled.mockResolvedValue(false);
    const out = await ReturnService.adminPartialRefund('s1', 'u1', args([ebook]), 'k1');
    expect(out).toMatchObject({ refundAmount: 10000 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(adminCreate.mock.calls[0][1].items).toEqual([ebook]);
  });

  it('plan without returns: tracked + untracked, no choice sent -> refunded with the tracked line forced to no-restock', async () => {
    m.isEnabled.mockResolvedValue(false);
    await ReturnService.adminPartialRefund('s1', 'u1', args([tee(), ebook]), 'k1');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(adminCreate.mock.calls[0][1].items).toEqual([tee(false), ebook]);
  });

  it('plan without returns: an explicit restock=true on a TRACKED line is refused before anything is written', async () => {
    m.isEnabled.mockResolvedValue(false);
    await expect(
      ReturnService.adminPartialRefund('s1', 'u1', args([tee(true), ebook]), 'k1')
    ).rejects.toMatchObject({ code: 'RETURNS_FEATURE_REQUIRED_FOR_RESTOCK', statusCode: 403 });
    expect(adminCreate).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('plan without returns: restock=true on an UNTRACKED line is harmless (it never restocks) and is refunded', async () => {
    m.isEnabled.mockResolvedValue(false);
    await ReturnService.adminPartialRefund('s1', 'u1', args([{ ...ebook, restock: true }]), 'k1');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('feature lookup failure counts as off: the refund goes, nothing is restocked', async () => {
    m.isEnabled.mockRejectedValue(new Error('flags down'));
    await ReturnService.adminPartialRefund('s1', 'u1', args([tee(), ebook]), 'k1');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(adminCreate.mock.calls[0][1].items[0]).toMatchObject({ restock: false });
  });

  it('plan without returns, every line refunded with a tracked line: the existing whole-order refusal, no money moves', async () => {
    m.isEnabled.mockResolvedValue(false);
    m.quote.mockResolvedValue(quote(true));
    await expect(
      ReturnService.adminPartialRefund('s1', 'u1', args([tee(), ebook]), 'k1')
    ).rejects.toMatchObject({ code: 'FULL_RETURN_RESTOCK_ALL' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('plan with returns: restock true is passed through untouched and refunded', async () => {
    m.isEnabled.mockResolvedValue(true);
    await ReturnService.adminPartialRefund('s1', 'u1', args([tee(true), ebook]), 'k1');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(adminCreate.mock.calls[0][1].items).toEqual([tee(true), ebook]);
  });
});
