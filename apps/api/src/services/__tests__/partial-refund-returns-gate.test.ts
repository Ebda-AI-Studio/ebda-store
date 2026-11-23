import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ruling REFUND-GATE-1: refunding money is never plan-gated; the returns workflow (restock) is.
const m = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  quote: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../feature.service', () => ({ featureService: { isFeatureEnabled: m.isEnabled } }));
vi.mock('../../lib/repo-factory', () => ({
  storeMoney: async () => ({ analyticsRefundQuote: m.quote, returnCreate: m.create }),
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

const args = (restock?: boolean) => ({
  orderId: 'o1',
  reason: 'damaged',
  refundMethod: 'cash',
  items: [{ orderItemId: 'i1', quantity: 1, ...(restock === undefined ? {} : { restock }) }],
});

beforeEach(() => {
  vi.clearAllMocks();
  m.quote.mockResolvedValue({ refundable: 0, coversWholeOrder: false, lines: [] });
});

describe('adminPartialRefund plan gate', () => {
  it('plan without `returns`: restock true or unset is refused before anything is read or written', async () => {
    m.isEnabled.mockResolvedValue(false);
    for (const r of [true, undefined])
      await expect(
        ReturnService.adminPartialRefund('s1', 'u1', args(r), 'k1')
      ).rejects.toMatchObject({ code: 'RETURNS_FEATURE_REQUIRED_FOR_RESTOCK', statusCode: 403 });
    expect(m.isEnabled).toHaveBeenCalledWith('s1', 'returns');
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('plan without `returns`: restock false still refunds (reaches the quote and the refund path)', async () => {
    m.isEnabled.mockResolvedValue(false);
    await expect(
      ReturnService.adminPartialRefund('s1', 'u1', args(false), 'k1')
    ).rejects.toMatchObject({ code: 'NOTHING_REFUNDABLE' }); // the stub quote has nothing left: past the gate
    expect(m.quote).toHaveBeenCalled();
  });

  it('plan with `returns`: restock true is allowed (reaches the quote)', async () => {
    m.isEnabled.mockResolvedValue(true);
    await expect(
      ReturnService.adminPartialRefund('s1', 'u1', args(true), 'k1')
    ).rejects.toMatchObject({
      code: 'NOTHING_REFUNDABLE',
    });
    expect(m.quote).toHaveBeenCalled();
  });
});
