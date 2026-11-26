/**
 * Guest return request (Foundation criterion 19, Ruling GUEST-RET-1, audit S2-7).
 *
 * A guest (order.customer_id null) could not start a return: every return route needs a signed-in customer. The fix is
 * `ReturnService.createForGuest`: order number + the phone OR email on the order, ONE identical failure for every
 * identity miss, no PII echoed, and the row made by the same `create` the signed-in path uses (so the window and the
 * delivered-only rule apply). A request moves no money.
 *
 * Old code: `ReturnService.createForGuest` does not exist, so every case here fails (TypeError) on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, orderDb, emailServiceMock, loggerMock, socketMock, moneyMock, doState } =
  vi.hoisted(() => ({
    moneyMock: { returnCreate: vi.fn() },
    doState: { money: true },
    prismaMock: {
      order: { findFirst: vi.fn() },
      return: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
      orderEvent: { findMany: vi.fn().mockResolvedValue([]) },
    },
    orderDb: {
      order: { findFirst: vi.fn(), findMany: vi.fn() },
      orderItem: { findMany: vi.fn() },
      return: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    },
    emailServiceMock: {
      sendReturnConfirmation: vi.fn().mockResolvedValue(undefined),
      sendReturnStatusUpdate: vi.fn().mockResolvedValue(undefined),
    },
    loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    socketMock: { newReturnNotification: vi.fn(), returnStatusNotification: vi.fn() },
  }));

vi.mock('@ebda/database', () => ({
  prisma: prismaMock,
  runInTenantContext: vi.fn(async (_s: unknown, fn: () => Promise<unknown>) => fn()),
  onClosedTenantTxAccess: vi.fn(),
  Prisma: {},
  ReturnStatus: {},
  ReturnType: {},
  withStore: vi.fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(async () => orderDb),
  storeMoney: vi.fn(async () => (doState.money ? moneyMock : null)),
}));
vi.mock('@api/lib/customer-directory', () => ({
  customerRow: vi.fn(),
  customerRows: vi.fn(async () => []),
  isLiveCustomer: () => true,
  pickSelected: (u: Record<string, unknown>) => u,
}));
vi.mock('@api/services/email.service', () => ({ EmailService: emailServiceMock }));
vi.mock('@api/services/socket.service', () => ({ socketService: socketMock }));
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/services/accounting/posting/partial-return-allocation', () => ({
  allocatePartialReturn: vi.fn(),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/lib/logger', () => ({ default: loggerMock }));

import { ReturnService, guestFactorEquals } from '@api/services/return.service';
import { withDeferredWork } from '@api/lib/after-tenant-commit';
import { AppError } from '@api/middleware/error-handler';

const STORE = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '33333333-3333-3333-3333-333333333333';
const LINE_ID = '55555555-5555-5555-5555-555555555555';
const PHONE = '+201001234567';
const EMAIL = 'guest@example.com';

const base = { type: 'return' as const, reason: 'changed_mind' };

function seedGuestOrder(): void {
  orderDb.order.findFirst.mockImplementation(async (q: { where: { orderNumber: string } }) =>
    q.where.orderNumber === 'ORD-1001'
      ? {
          id: ORDER_ID,
          shippingAddress: { firstName: 'Gus', lastName: 'Tee', phone: PHONE, email: EMAIL },
        }
      : null
  );
  orderDb.orderItem.findMany.mockResolvedValue([
    { id: LINE_ID, productId: 'p1', productName: 'Widget', quantity: 2, bundleGroupId: null },
  ]);
  prismaMock.order.findFirst.mockResolvedValue({
    id: ORDER_ID,
    orderNumber: 'ORD-1001',
    locale: 'en',
    deliveredAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: LINE_ID,
        productId: 'p1',
        productName: 'Widget',
        quantity: 2,
        price: 10,
        total: 20,
        bundleGroupId: null,
        bundleName: null,
      },
    ],
    customer: null,
    shippingAddress: { firstName: 'Gus', lastName: 'Tee', phone: PHONE, email: EMAIL },
    store: { name: 'Probe', returnWindowDays: 14 },
  });
  prismaMock.return.findMany.mockResolvedValue([]);
  prismaMock.orderEvent.findMany.mockResolvedValue([]);
  moneyMock.returnCreate.mockResolvedValue({ returnId: 'ret-1' });
  orderDb.return.findFirst.mockResolvedValue({
    id: 'ret-1',
    returnNumber: 'RET-X',
    status: 'pending',
    customerId: `guest:${ORDER_ID}`,
    items: [],
  });
  doState.money = true;
}

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  vi.clearAllMocks();
  seedGuestOrder();
});

describe('ReturnService.createForGuest', () => {
  it('creates the return for a guest order proven by order number + phone, as a guest:true DO return (never a null customerId)', async () => {
    const r = await withDeferredWork({ storeId: STORE }, () =>
      ReturnService.createForGuest(STORE, {
        ...base,
        orderNumber: 'ORD-1001',
        phone: '01001234567', // another written form of the stored phone
      })
    );
    expect(r).toMatchObject({ returnNumber: 'RET-X' });
    const args = moneyMock.returnCreate.mock.calls[0][0];
    expect(args).toMatchObject({ orderId: ORDER_ID, guest: true });
    expect(args.customerId).toBeUndefined();
    // no lines named = the whole order
    expect(args.items).toHaveLength(1);
    // only a guest order (customer_id null) is looked up by number; delivered-only is enforced by the DO's returnCreate
    expect(orderDb.order.findFirst.mock.calls[0][0].where).toMatchObject({ customerId: null });
  });

  it('accepts the email as the second factor, case-insensitive', async () => {
    await withDeferredWork({ storeId: STORE }, () =>
      ReturnService.createForGuest(STORE, {
        ...base,
        orderNumber: 'ORD-1001',
        email: ' Guest@Example.COM ',
      })
    );
    expect(moneyMock.returnCreate).toHaveBeenCalledTimes(1);
  });

  it('a request moves no money: it asks the DO for a return row only (no refund method, no completion)', async () => {
    await withDeferredWork({ storeId: STORE }, () =>
      ReturnService.createForGuest(STORE, { ...base, orderNumber: 'ORD-1001', phone: PHONE })
    );
    const args = moneyMock.returnCreate.mock.calls[0][0];
    expect(args).not.toHaveProperty('refundMethod');
    expect(args).not.toHaveProperty('byMerchant');
    expect(moneyMock.returnCreate).toHaveBeenCalledTimes(1);
  });

  it('wrong phone, wrong email, unknown order, no factor: ONE identical failure, no row', async () => {
    const attempts = [
      { orderNumber: 'ORD-1001', phone: '+201009999999' }, // wrong phone
      { orderNumber: 'ORD-1001', email: 'other@example.com' }, // wrong email
      { orderNumber: 'ORD-9999', phone: PHONE }, // no such order
      { orderNumber: 'ORD-1001' }, // no factor
      { orderNumber: 'ORD-1001', phone: PHONE, email: 'other@example.com' }, // one right, one wrong
    ];
    const errors: AppError[] = [];
    for (const a of attempts)
      errors.push(await failure(ReturnService.createForGuest(STORE, { ...base, ...a })));
    const shapes = errors.map(e => JSON.stringify({ s: e.statusCode, c: e.code, m: e.message }));
    expect(new Set(shapes).size).toBe(1);
    expect(errors[0]).toMatchObject({ statusCode: 404, code: 'GUEST_RETURN_NOT_FOUND' });
    expect(prismaMock.return.create).not.toHaveBeenCalled();
  });

  it('echoes no PII in the failure', async () => {
    const e = await failure(
      ReturnService.createForGuest(STORE, {
        ...base,
        orderNumber: 'ORD-1001',
        phone: '+201009999999',
      })
    );
    const body = JSON.stringify({
      m: e.message,
      c: e.code,
      d: (e as { details?: unknown }).details,
    });
    for (const pii of [PHONE, EMAIL, '01009999999', 'Gus', 'Tee']) expect(body).not.toContain(pii);
  });

  it("a signed-in customer's order answers like a missing one", async () => {
    orderDb.order.findFirst.mockImplementation(async (q: { where: { customerId?: unknown } }) =>
      q.where.customerId === null ? null : { id: ORDER_ID, shippingAddress: { phone: PHONE } }
    );
    const e = await failure(
      ReturnService.createForGuest(STORE, { ...base, orderNumber: 'ORD-1001', phone: PHONE })
    );
    expect(e.code).toBe('GUEST_RETURN_NOT_FOUND');
  });

  it('an order with no phone on it never matches an empty given phone', async () => {
    orderDb.order.findFirst.mockResolvedValue({ id: ORDER_ID, shippingAddress: {} });
    const e = await failure(
      ReturnService.createForGuest(STORE, { ...base, orderNumber: 'ORD-1001', phone: ' ' })
    );
    expect(e.code).toBe('GUEST_RETURN_NOT_FOUND');
  });
});

describe('createForGuest on a store without a StoreDO', () => {
  it('answers RETURNS_NEED_DO_STORE: the guest marker lives on the StoreDO only', async () => {
    doState.money = false;
    const e = await failure(
      ReturnService.createForGuest(STORE, { ...base, orderNumber: 'ORD-1001', phone: PHONE })
    );
    expect(e.code).toBe('RETURNS_NEED_DO_STORE');
    expect(prismaMock.return.create).not.toHaveBeenCalled();
  });
});

describe('the merchant returns list', () => {
  it('shows a guest:<orderId> return with the contact left on the order, and looks up no account for it', async () => {
    orderDb.return.findMany.mockResolvedValue([
      {
        id: 'ret-1',
        orderId: ORDER_ID,
        customerId: `guest:${ORDER_ID}`,
        order: {
          orderNumber: 'ORD-1001',
          shippingAddress: { firstName: 'Gus', lastName: 'Tee', phone: PHONE, email: EMAIL },
        },
      },
    ]);
    orderDb.return.count.mockResolvedValue(1);
    const { returns } = await ReturnService.list(STORE, {});
    expect(returns[0].customer).toMatchObject({
      firstName: 'Gus',
      lastName: 'Tee',
      email: EMAIL,
      isGuest: true,
    });
  });
});

describe('guestFactorEquals', () => {
  it('compares equal values, rejects different and empty ones', () => {
    expect(guestFactorEquals('a', 'a')).toBe(true);
    expect(guestFactorEquals('a', 'b')).toBe(false);
    expect(guestFactorEquals('', '')).toBe(false);
    expect(guestFactorEquals('abc', 'abcd')).toBe(false);
  });
});
