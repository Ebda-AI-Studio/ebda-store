/**
 * `assertValidTransition` unit tests (money-integrity Task 6).
 *
 * `assertValidTransition(from, to)` is the state machine check extracted
 * from `OrderService.updateStatus`'s inline `validTransitions` block. It is
 * now shared by `updateStatus` AND the 3 payment-gateway/webhook direct
 * writers in `payment.factory.ts` that bypass `updateStatus` entirely
 * (`refund()`'s full-refund write, the out-of-band refund-webhook write,
 * and the general payment-webhook order write) — see
 * `tests/unit/payment-webhook-status-transition.test.ts` for the
 * direct-writer wiring tests (each rejects a stale/invalid transition
 * before it can regress the order).
 *
 * Importing `@api/services/order.service` for real requires the full
 * transitive mock scaffold already established in `tests/unit/order.test.ts`
 * (heavy service — email, socket, cart, inngest, feature-flag deps) even
 * though `assertValidTransition` itself touches none of them; the mocks
 * below are copied from that file so the module can load.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@force/database', () => ({
  prisma: {
    order: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    cart: { findFirst: vi.fn(), create: vi.fn() },
    cartItem: { deleteMany: vi.fn() },
    product: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    productVariant: { update: vi.fn() },
    store: { findUnique: vi.fn().mockResolvedValue({ name: 'Test Store' }) },
    taxRate: { findMany: vi.fn().mockResolvedValue([]) },
    inventoryHistory: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    orderEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    coupon: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    backorderLine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  Prisma: {},
  OrderStatus: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
    sendAdminNewOrder: vi.fn().mockResolvedValue(undefined),
    sendOrderShipped: vi.fn().mockResolvedValue(undefined),
    sendPaymentSuccess: vi.fn().mockResolvedValue(undefined),
    sendAdminRefund: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@api/services/socket.service', () => ({
  socketService: { newOrderNotification: vi.fn(), orderStatusNotification: vi.fn() },
}));

vi.mock('@api/services/cart.service', () => ({
  CartService: { getOrCreate: vi.fn() },
}));

vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn().mockResolvedValue({ ids: [] }),
    createFunction: vi.fn(() => ({})),
  },
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getStoreFeatures: vi.fn(),
    invalidateCache: vi.fn(),
  },
}));

import { assertValidTransition } from '@api/services/order.service';

describe('assertValidTransition', () => {
  it('rejects a stale/backwards transition (refunded → processing)', () => {
    expect(() => assertValidTransition('refunded', 'processing')).toThrow(
      'Cannot transition from refunded to processing'
    );
  });

  it('rejects reviving a cancelled order (cancelled → confirmed) but allows refunding it', () => {
    expect(() => assertValidTransition('cancelled', 'confirmed')).toThrow(
      'Cannot transition from cancelled to confirmed'
    );
    // A paid order that was cancelled can still be refunded; only `refunded` is terminal.
    expect(() => assertValidTransition('cancelled', 'refunded')).not.toThrow();
  });

  it('rejects a stale "payment failed" webhook regressing a shipped order to pending', () => {
    expect(() => assertValidTransition('shipped', 'pending')).toThrow(
      'Cannot transition from shipped to pending'
    );
  });

  it('allows a valid forward transition (pending → confirmed)', () => {
    expect(() => assertValidTransition('pending', 'confirmed')).not.toThrow();
  });

  it('allows an admin to jump ahead (pending → delivered)', () => {
    expect(() => assertValidTransition('pending', 'delivered')).not.toThrow();
  });

  it('allows refunded from every non-terminal state — a refund can follow a completed payment in any state', () => {
    expect(() => assertValidTransition('pending', 'refunded')).not.toThrow();
    // The reported prod bug (#770): a paid order cancelled by staff must be refundable.
    expect(() => assertValidTransition('cancelled', 'refunded')).not.toThrow();
    expect(() => assertValidTransition('confirmed', 'refunded')).not.toThrow();
    expect(() => assertValidTransition('processing', 'refunded')).not.toThrow();
    expect(() => assertValidTransition('shipped', 'refunded')).not.toThrow();
    expect(() => assertValidTransition('delivered', 'refunded')).not.toThrow();
  });

  it('treats a same-status write as an idempotent no-op (duplicate/retried webhook)', () => {
    expect(() => assertValidTransition('confirmed', 'confirmed')).not.toThrow();
    expect(() => assertValidTransition('pending', 'pending')).not.toThrow();
    expect(() => assertValidTransition('refunded', 'refunded')).not.toThrow();
  });

  it('throws an AppError with the INVALID_STATUS_TRANSITION code and 400 status', async () => {
    const { AppError } = await import('@api/middleware/error-handler');
    try {
      assertValidTransition('refunded', 'processing');
      throw new Error('expected assertValidTransition to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as InstanceType<typeof AppError>).statusCode).toBe(400);
      expect((err as InstanceType<typeof AppError>).code).toBe('INVALID_STATUS_TRANSITION');
    }
  });
});
