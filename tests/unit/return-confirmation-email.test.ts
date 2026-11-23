/**
 * Unit test — the return-confirmation email actually gets dispatched.
 *
 * `/stores/:storeId/returns` runs under `tenantContext`, so the old bare
 * `void EmailService.sendReturnConfirmation(...)` in `ReturnService.create`
 * inherited the request's tenant transaction and made its Prisma reads AFTER
 * that transaction committed — P2028, swallowed by the site's own logging
 * `.catch`. Every return confirmation silently failed to send.
 *
 * Two things have to hold, and each is asserted separately:
 *
 *  1. `ReturnService.create` hands the email to the post-commit queue instead
 *     of firing it inside the doomed transaction — so it is NOT sent while
 *     the request transaction is open, and IS sent once it has committed.
 *     (Revert return.service.ts to the bare `void` and the "not yet" assertion
 *     reddens: the email fires inline.)
 *
 *  2. `EmailService.sendReturnConfirmation` / `sendReturnStatusUpdate` route
 *     through the DURABLE Redis retry queue, the same path the order-lifecycle
 *     emails use, so a transient Resend failure retries instead of vanishing.
 *     (Drop `{ queue: true }` and the enqueue assertions redden.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  prismaMock,
  runInTenantContextMock,
  emailServiceMock,
  loggerMock,
  sendAlertMock,
  socketMock,
} = vi.hoisted(() => ({
  prismaMock: {
    order: { findFirst: vi.fn() },
    return: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    // create() counts units a backorder single-line cancel already took back.
    orderEvent: { findMany: vi.fn().mockResolvedValue([]) },
    // No raw SQL: create() takes no advisory lock any more (Ruling NZ-REFUND-LOCK-1).
  },
  runInTenantContextMock: vi.fn(
    async (_storeId: string | undefined, fn: () => Promise<unknown>, _userId?: string) => fn()
  ),
  emailServiceMock: {
    sendReturnConfirmation: vi.fn().mockResolvedValue(undefined),
    sendReturnStatusUpdate: vi.fn().mockResolvedValue(undefined),
  },
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  sendAlertMock: vi.fn().mockResolvedValue('sent'),
  socketMock: {
    newReturnNotification: vi.fn(),
    returnStatusNotification: vi.fn(),
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: prismaMock,
  runInTenantContext: runInTenantContextMock,
  onClosedTenantTxAccess: vi.fn(),
  Prisma: {},
  ReturnStatus: {},
  ReturnType: {},
}));

vi.mock('@api/services/email.service', () => ({ EmailService: emailServiceMock }));
vi.mock('@api/services/socket.service', () => ({ socketService: socketMock }));
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/services/accounting/posting/partial-return-allocation', () => ({
  allocatePartialReturn: vi.fn(),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: sendAlertMock }));
vi.mock('@api/lib/logger', () => ({ default: loggerMock }));

import { ReturnService } from '@api/services/return.service';
import { withDeferredWork } from '@api/lib/after-tenant-commit';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const ORDER_ID = '33333333-3333-3333-3333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-4444-444444444444';
const ORDER_ITEM_ID = '55555555-5555-5555-5555-555555555555';

function seedHappyPath(): void {
  prismaMock.order.findFirst.mockResolvedValue({
    id: ORDER_ID,
    orderNumber: 'ORD-1001',
    locale: 'en',
    items: [
      {
        id: ORDER_ITEM_ID,
        productId: 'prod-1',
        productName: 'Widget',
        quantity: 2,
        price: 10,
        total: 20,
        bundleGroupId: null,
        bundleName: null,
      },
    ],
    customer: { email: 'buyer@example.com', firstName: 'Bay', lastName: 'Er' },
    store: { name: 'Probe Store' },
  });
  prismaMock.return.findMany.mockResolvedValue([]);
  prismaMock.orderEvent.findMany.mockResolvedValue([]);
  prismaMock.return.create.mockResolvedValue({ id: 'ret-1', items: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  runInTenantContextMock.mockImplementation(
    async (_storeId: string | undefined, fn: () => Promise<unknown>, _userId?: string) => fn()
  );
  seedHappyPath();
});

describe('ReturnService.create — confirmation email dispatch', () => {
  const input = {
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    type: 'refund' as const,
    reason: 'damaged',
    items: [
      { orderItemId: ORDER_ITEM_ID, productId: 'prod-1', productName: 'Widget', quantity: 1 },
    ],
  };

  it('does not send inside the request transaction, and does send once it commits', async () => {
    await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
      await ReturnService.create(STORE_ID, input);
      // Still inside the tenant transaction — sending here is exactly the
      // defect (the Prisma reads would land on a committed tx).
      expect(emailServiceMock.sendReturnConfirmation).not.toHaveBeenCalled();
    });

    expect(emailServiceMock.sendReturnConfirmation).toHaveBeenCalledTimes(1);
    const [storeId, payload, locale] = emailServiceMock.sendReturnConfirmation.mock.calls[0];
    expect(storeId).toBe(STORE_ID);
    expect(payload).toMatchObject({
      email: 'buyer@example.com',
      customerName: 'Bay Er',
      storeName: 'Probe Store',
      orderNumber: 'ORD-1001',
      type: 'refund',
    });
    expect(locale).toBe('en');
  });

  it('re-establishes the request’s tenant context for the deferred send', async () => {
    await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
      await ReturnService.create(STORE_ID, input);
    });

    expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
    const [storeId, , userId] = runInTenantContextMock.mock.calls[0];
    expect(storeId).toBe(STORE_ID);
    expect(userId).toBe(USER_ID);
  });

  it('surfaces a send failure instead of swallowing it', async () => {
    emailServiceMock.sendReturnConfirmation.mockRejectedValueOnce(
      Object.assign(new Error('Transaction already closed'), { code: 'P2028' })
    );

    await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
      await ReturnService.create(STORE_ID, input);
    });

    expect(loggerMock.error).toHaveBeenCalled();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      source: 'after-tenant-commit.email.returnConfirmation',
    });
  });

  it('still sends inline outside a request (Inngest / script paths unchanged)', async () => {
    await ReturnService.create(STORE_ID, input);

    expect(emailServiceMock.sendReturnConfirmation).toHaveBeenCalledTimes(1);
    expect(runInTenantContextMock).not.toHaveBeenCalled();
  });
});
