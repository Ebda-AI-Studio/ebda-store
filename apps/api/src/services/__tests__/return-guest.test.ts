import { describe, it, expect, vi, beforeEach } from 'vitest';

// GUEST-RET-1: a merchant-opened return on a GUEST order carries `guest:<orderId>` as its customer. The API must (a) show the
// order's own identity instead of looking the marker up as an account and (b) never mail / push a status update for it.
const m = vi.hoisted(() => ({
  customerRows: vi.fn(),
  sendStatus: vi.fn(),
  socketStatus: vi.fn(),
  returnStatus: vi.fn(),
  returnFind: vi.fn(),
  orderFind: vi.fn(),
}));

vi.mock('../../lib/customer-directory', () => ({
  customerRow: vi.fn(),
  customerRows: m.customerRows,
  isLiveCustomer: () => true,
  pickSelected: (u: Record<string, unknown>) => u,
}));
vi.mock('@ebda/database', () => ({
  prisma: { user: { findMany: vi.fn(async () => []), findFirst: vi.fn() } },
  Prisma: {},
  ReturnStatus: {},
  ReturnType: {},
  withStore: async (_s: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findFirst: async () => ({ name: 'Amelia' }) } }),
}));
vi.mock('../email.service', () => ({ EmailService: { sendReturnStatusUpdate: m.sendStatus } }));
vi.mock('../socket.service', () => ({
  socketService: { returnStatusNotification: m.socketStatus },
}));
vi.mock('../../lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../lib/repo-factory', () => ({
  storeDb: async () => ({
    return: { findFirst: m.returnFind },
    order: { findFirst: m.orderFind },
  }),
  storeMoney: async () => ({ returnStatus: m.returnStatus }),
}));
vi.mock('../order.service', () => ({ OrderService: {} }));
vi.mock('../feature.service', () => ({ featureService: {} }));
vi.mock('../wallet.service', () => ({ WalletService: {} }));
vi.mock('../payment.service', () => ({ PaymentService: {} }));

import { ReturnService, withCustomer, guestCustomerOf } from '../return.service';

const guestRow = (shippingAddress: unknown) => ({
  id: 'r1',
  storeId: 's1',
  customerId: 'guest:o1',
  returnNumber: 'RET-1',
  order: { orderNumber: 'ORD-1', locale: 'ar', shippingAddress },
});

beforeEach(() => vi.clearAllMocks());

describe('guest return identity (withCustomer)', () => {
  it('never looks the guest marker up as an account; shows the order shipping-address identity', async () => {
    m.customerRows.mockResolvedValue([]);
    const [row] = await withCustomer(
      's1',
      [guestRow({ firstName: 'Mona', lastName: 'Ali', email: 'm@x.com', phone: '0100' })],
      { email: true }
    );
    expect(m.customerRows).toHaveBeenCalledWith('s1', []);
    expect(row.customer).toMatchObject({ firstName: 'Mona', email: 'm@x.com', isGuest: true });
  });
  it('accepts a JSON-string address and yields null when the order was not joined', () => {
    expect(guestCustomerOf({ shippingAddress: '{"firstName":"A"}' })).toMatchObject({
      firstName: 'A',
    });
    expect(guestCustomerOf(undefined)).toBeNull();
  });
});

describe('return status update on a guest return', () => {
  it('mails the contact on the order (the shopper asked for the return) but never pushes a socket event', async () => {
    m.returnFind.mockResolvedValue(guestRow(null));
    m.orderFind.mockResolvedValue({
      shippingAddress: { firstName: 'Mona', lastName: 'Ali', email: 'm@x.com' },
    });
    m.customerRows.mockResolvedValue([]);
    vi.spyOn(ReturnService, 'getById').mockResolvedValue({} as never);
    await ReturnService.updateStatus('s1', 'r1', 'approved' as never, 'u1');
    expect(m.returnStatus).toHaveBeenCalled();
    expect(m.sendStatus).toHaveBeenCalledTimes(1);
    expect(m.sendStatus.mock.calls[0][1]).toMatchObject({
      email: 'm@x.com',
      customerName: 'Mona Ali',
    });
    expect(m.socketStatus).not.toHaveBeenCalled();
  });
  it('a guest return whose order has no email is not mailed at all', async () => {
    m.returnFind.mockResolvedValue(guestRow(null));
    m.orderFind.mockResolvedValue({ shippingAddress: { phone: '0100' } });
    m.customerRows.mockResolvedValue([]);
    vi.spyOn(ReturnService, 'getById').mockResolvedValue({} as never);
    await ReturnService.updateStatus('s1', 'r1', 'approved' as never, 'u1');
    expect(m.sendStatus).not.toHaveBeenCalled();
    expect(m.socketStatus).not.toHaveBeenCalled();
  });
  it('still mails a real customer (the gate is the marker, not "never")', async () => {
    m.returnFind.mockResolvedValue({ ...guestRow(null), customerId: 'cust-1' });
    m.customerRows.mockResolvedValue([
      { id: 'cust-1', email: 'c@x.com', firstName: 'C', lastName: 'D' },
    ]);
    vi.spyOn(ReturnService, 'getById').mockResolvedValue({} as never);
    await ReturnService.updateStatus('s1', 'r1', 'approved' as never, 'u1');
    expect(m.sendStatus).toHaveBeenCalledTimes(1);
    expect(m.socketStatus).toHaveBeenCalledTimes(1);
  });
});
