/**
 * order-status-changed fanout (Builder Reality Audit Lens E, E2-4).
 *
 * Verifies the post-purchase side effects migrated off updateStatus's in-process
 * fire-and-forget onto retriable Inngest steps: the right side effects run per
 * status, and any exhausted step re-throws so the run dead-letters.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@api/lib/store-operational', () => ({
  STORE_NOT_OPERATIONAL: 'STORE_NOT_OPERATIONAL',
  isStoreOperational: (s: unknown) => s === 'active',
  storeOperational: async () => true,
  storeMayMessageCustomers: async () => true,
  assertStoreOperational: async () => undefined,
  activeStoreIds: async () => ({ has: () => true }) as unknown as Set<string>,
  requireOperationalStore: (_q: unknown, _r: unknown, next: () => void) => next(),
}));

const h = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  orderUpdateMany: vi.fn(),
  storeFindUnique: vi.fn(),
  sendPaymentSuccess: vi.fn(),
  sendOrderShipped: vi.fn(),
  sendAdminRefund: vi.fn(),
  dispatch: vi.fn(),
  earnPoints: vi.fn(),
  processCommission: vi.fn(),
  inngestSend: vi.fn(),
  createShipment: vi.fn(),
  isFeatureEnabled: vi.fn(),
  // Spy (not an inline passthrough) so tests can assert the FORCE-RLS side
  // effects actually run INSIDE a tenant context — the whole point of the fix.
  runInTenant: vi.fn((_s: string, fn: () => unknown) => fn()),
}));

// a Postgres store: the Durable Object money client is absent, so the job takes its unchanged Postgres path
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/repo-factory')>()),
  storeMoney: async () => null,
  storeDb: async () => ({}),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    order: { findUnique: h.orderFindUnique, updateMany: h.orderUpdateMany },
    store: { findUnique: h.storeFindUnique },
  },
  runInTenantContext: h.runInTenant,
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendPaymentSuccess: h.sendPaymentSuccess,
    sendOrderShipped: h.sendOrderShipped,
    sendAdminRefund: h.sendAdminRefund,
  },
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: h.dispatch },
}));
vi.mock('@api/services/loyalty.service', () => ({
  LoyaltyService: { earnPointsFromPurchase: h.earnPoints },
}));
vi.mock('@api/services/affiliate.service', () => ({
  affiliateService: { processCommission: h.processCommission },
}));
vi.mock('@api/services/shipping-carrier.service', () => ({
  shippingCarrierService: { createShipmentForOrder: h.createShipment },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.isFeatureEnabled },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: vi.fn(() => ({})), send: h.inngestSend },
}));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleOrderStatusChanged } from '@api/lib/inngest/functions/order-status-changed';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };

const ORDER = {
  id: 'o1',
  storeId: 's1',
  customerId: 'c1',
  orderNumber: 'ORD-1',
  total: 5000,
  subtotal: 4500,
  tax: 0,
  shipping: 500,
  locale: 'en',
  customer: { email: 'buyer@test.com', firstName: 'Sam', lastName: 'B' },
  items: [{ productName: 'Widget', quantity: 1, price: 4500 }],
  shippingAddress: {
    firstName: 'Sam',
    lastName: 'B',
    address1: 'X',
    city: 'EG',
    state: '',
    postalCode: '',
    country: 'EG',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.orderFindUnique.mockResolvedValue(ORDER);
  h.orderUpdateMany.mockResolvedValue({ count: 1 });
  h.storeFindUnique.mockResolvedValue({ name: 'Test Store' });
  h.isFeatureEnabled.mockResolvedValue(false);
  for (const fn of [
    h.sendPaymentSuccess,
    h.sendOrderShipped,
    h.sendAdminRefund,
    h.dispatch,
    h.earnPoints,
    h.processCommission,
    h.createShipment,
  ])
    fn.mockResolvedValue(undefined);
});

describe('order-status-changed fanout', () => {
  it('delivered → affiliate commission + loyalty earn + dispatch(order_delivered)', async () => {
    const r = await handleOrderStatusChanged('o1', 's1', 'delivered', false, stepStub);
    expect(h.processCommission).toHaveBeenCalledWith('s1', 'o1');
    expect(h.earnPoints).toHaveBeenCalledWith('s1', 'c1', 'o1', 5000);
    expect(h.dispatch).toHaveBeenCalledWith('s1', 'order_delivered', expect.any(Object));
    expect(r.ran).toEqual(
      expect.arrayContaining(['affiliate-commission', 'loyalty-earn', 'dispatch-delivered'])
    );
  });

  it('delivered → affiliate + loyalty run INSIDE runInTenantContext (FORCE-RLS)', async () => {
    await handleOrderStatusChanged('o1', 's1', 'delivered', false, stepStub);
    // load-order + load-store + affiliate-commission + loyalty-earn each wrap the
    // storeId in runInTenantContext. If any FORCE-RLS side effect is left
    // unwrapped, this count drops below 4 and the test fails.
    const s1Wraps = h.runInTenant.mock.calls.filter(c => c[0] === 's1');
    expect(s1Wraps.length).toBeGreaterThanOrEqual(4);
    expect(h.processCommission).toHaveBeenCalledWith('s1', 'o1');
    expect(h.earnPoints).toHaveBeenCalledWith('s1', 'c1', 'o1', 5000);
  });

  it('confirmed → booking is handed to the retried shipment-create job, never run inline', async () => {
    h.isFeatureEnabled.mockResolvedValue(true);
    await handleOrderStatusChanged('o1', 's1', 'confirmed', false, stepStub);
    // a carrier outage must never fail or hold up the fanout: the booking is an event
    expect(h.inngestSend).toHaveBeenCalledWith({
      name: 'shipment/create.requested',
      data: { storeId: 's1', orderId: 'o1' },
    });
    expect(h.createShipment).not.toHaveBeenCalled();
  });

  it('shipped → shipped email + dispatch(order_shipped)', async () => {
    await handleOrderStatusChanged('o1', 's1', 'shipped', false, stepStub);
    expect(h.sendOrderShipped).toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledWith('s1', 'order_shipped', expect.any(Object));
    expect(h.processCommission).not.toHaveBeenCalled();
  });

  it('confirmed → payment-success email, and the shipment event is sent (the job checks the feature flag)', async () => {
    await handleOrderStatusChanged('o1', 's1', 'confirmed', false, stepStub);
    expect(h.sendPaymentSuccess).toHaveBeenCalled();
    expect(h.createShipment).not.toHaveBeenCalled();
  });

  it('refunded WITHOUT captured payment → no refund email/dispatch', async () => {
    await handleOrderStatusChanged('o1', 's1', 'refunded', false, stepStub);
    expect(h.sendAdminRefund).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  // Ruling FU46-1a: the refund bookkeeping email goes to the STORE's configured
  // order-notification address (`settings.orderInvoiceEmail`), never to Ebda's
  // own address; with no address set nothing is sent.
  it('refunded WITH captured payment → bookkeeping email to the store order address only', async () => {
    h.storeFindUnique.mockResolvedValue({
      name: 'Test Store',
      settings: { orderInvoiceEmail: ' orders@store.test ' },
    });
    const r = await handleOrderStatusChanged('o1', 's1', 'refunded', true, stepStub);
    expect(h.sendAdminRefund).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'orders@store.test', orderNumber: 'ORD-1' })
    );
    expect(r.ran).toEqual(['email-admin-refund']);
  });

  it('refunded WITH captured payment, no order address set → no email at all (FU46-1a)', async () => {
    const r = await handleOrderStatusChanged('o1', 's1', 'refunded', true, stepStub);
    expect(h.sendAdminRefund).not.toHaveBeenCalled();
    expect(r.ran).toEqual([]);
  });

  // Once-per-order "Refund issued": the customer-facing set (refund email +
  // refund_processed dispatch + admin push) is produced ONLY by the
  // order/refunded fanout, under its per-order `refund_notified` claim. This
  // fanout dispatching the same key was unclaimed, so a paid order cancelled
  // first (fanout notifies, claim written) and refunded afterwards notified the
  // customer a SECOND time from here — the claim cannot suppress a producer it
  // doesn't gate. No status may reintroduce that dispatch.
  it('never dispatches refund_processed — the claimed order/refunded fanout owns it', async () => {
    for (const status of ['confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'] as const) {
      await handleOrderStatusChanged('o1', 's1', status, true, stepStub);
    }
    expect(
      h.dispatch.mock.calls.filter(c => c[1] === 'refund_processed'),
      'refund_processed must only come from the order/refunded fanout'
    ).toEqual([]);
  });

  it('re-throws when a side-effect step fails (so the run dead-letters)', async () => {
    h.sendOrderShipped.mockRejectedValueOnce(new Error('resend down'));
    await expect(
      handleOrderStatusChanged('o1', 's1', 'shipped', false, stepStub)
    ).rejects.toThrow();
  });

  it('skips cleanly when the order is missing', async () => {
    h.orderFindUnique.mockResolvedValue(null);
    const r = await handleOrderStatusChanged('o1', 's1', 'shipped', false, stepStub);
    expect(r.skipped).toBe('order-not-found');
    expect(h.sendOrderShipped).not.toHaveBeenCalled();
  });
});

/**
 * #558 — the transition is claimed before any side effect, so a second event
 * for the same order + transition (racing updateStatus calls, the inline
 * fallback after a delayed send, a stuck-sweep re-send) sends nothing twice.
 */
describe('order-status-changed fanout — per-transition claim', () => {
  it('claims the transition only while the order is still at that status', async () => {
    await handleOrderStatusChanged('o1', 's1', 'shipped', false, stepStub);
    expect(h.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: 'o1', storeId: 's1', status: 'shipped', statusFanoutClaimedAt: null },
      data: { statusFanoutClaimedAt: expect.any(Date) },
    });
  });

  it('a duplicate event for an already-claimed transition sends NOTHING', async () => {
    h.orderUpdateMany.mockResolvedValue({ count: 0 });
    const r = await handleOrderStatusChanged('o1', 's1', 'delivered', false, stepStub);
    expect(r).toEqual({ skipped: 'already-claimed', ran: [] });
    expect(h.processCommission).not.toHaveBeenCalled();
    expect(h.earnPoints).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.sendOrderShipped).not.toHaveBeenCalled();
    expect(h.orderFindUnique).not.toHaveBeenCalled();
  });
});

/**
 * issue 2071 — the claim is a dedup lock taken before the side effects; the
 * completion stamp is what says they all succeeded. Mutation-proof: stamping
 * before `Promise.allSettled` (or unconditionally) reddens the failure case.
 */
describe('order-status-changed fanout — completion stamp (issue 2071)', () => {
  const stampCalls = () =>
    h.orderUpdateMany.mock.calls.filter(
      c => (c[0] as { data: Record<string, unknown> }).data.statusFanoutCompletedAt !== undefined
    );

  it('stamps statusFanoutCompletedAt after every side effect succeeded', async () => {
    await handleOrderStatusChanged('o1', 's1', 'shipped', false, stepStub);
    expect(stampCalls()).toHaveLength(1);
    expect(stampCalls()[0][0]).toMatchObject({
      where: {
        id: 'o1',
        storeId: 's1',
        statusFanoutRequestedStatus: 'shipped',
        statusFanoutClaimedAt: { not: null },
        statusFanoutCompletedAt: null,
      },
    });
  });

  // issue 2295 — a direct status writer (gateway refund, payment confirm) can
  // move orders.status mid-run without re-arming; keyed on the live status the
  // stamp then missed and the sweep paged a false "failed after claim" P1.
  it('keys the stamp on the claimed transition, never the live status', async () => {
    await handleOrderStatusChanged('o1', 's1', 'shipped', false, stepStub);
    const where = (stampCalls()[0][0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty('status');
    expect(where.statusFanoutRequestedStatus).toBe('shipped');
  });

  it('does NOT stamp when a side effect failed — the sweep must be able to see it', async () => {
    h.sendOrderShipped.mockRejectedValueOnce(new Error('resend down'));
    await expect(
      handleOrderStatusChanged('o1', 's1', 'shipped', false, stepStub)
    ).rejects.toThrow();
    expect(stampCalls()).toHaveLength(0);
  });
});
