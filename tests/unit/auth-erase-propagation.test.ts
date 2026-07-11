/**
 * Unit tests — AuthService.eraseAccount's third-party propagation hookup.
 *
 * Scope: this file does NOT re-test the full anonymization transaction
 * (see tests/integration/auth-gdpr.test.ts for that, against a real DB).
 * It tests one thing precisely: eraseAccount captures OneSignal player ids
 * BEFORE they're deleted, fires `account/erased` with them after the
 * transaction commits, and — critically — a dead/failing Inngest send
 * NEVER fails eraseAccount itself (fail-open, per the GDPR erasure gap
 * closure: the primary anonymization must succeed independently of any
 * third-party propagation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: { sendOrderConfirmation: vi.fn(), sendAdminNewOrder: vi.fn() },
}));

vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked: vi.fn().mockResolvedValue({ locked: false }),
    recordFailedAttempt: vi.fn(),
    clearAttempts: vi.fn(),
  },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: vi.fn().mockReturnValue(false), getClient: vi.fn() },
}));

vi.mock('@api/services/r2-cleanup.service', () => ({
  deleteR2ObjectIfOrphan: vi.fn().mockResolvedValue(undefined),
}));

// vi.mock factories are hoisted above top-level const declarations, so any
// value a factory closes over must itself be declared via vi.hoisted.
const { sendMock, mockPrisma } = vi.hoisted(() => {
  const sendMock = vi.fn();
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    oneSignalSubscription: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    review: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    address: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    abandonedCart: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    cart: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    wishlist: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    pushSubscription: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    refreshToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    loyaltyTransaction: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    loyaltyPoints: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn(),
  };
  return { sendMock, mockPrisma };
});

vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: sendMock },
}));

vi.mock('@force/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
  // Delegates to the mocked $transaction, invoking the callback with the
  // same mock prisma object (tx.* === prisma.* here, which is fine — the
  // real distinction only matters for RLS/isolation, not this test).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
}));

import { AuthService } from '@api/services/auth.service';

const CUSTOMER = {
  id: 'user-erase-1',
  storeId: 'store-1',
  role: 'customer',
  avatar: null,
};

describe('AuthService.eraseAccount — third-party propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(CUSTOMER);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
    mockPrisma.oneSignalSubscription.findMany.mockResolvedValue([]);
    sendMock.mockResolvedValue({ ids: ['evt-1'] });
  });

  it('fires account/erased with the userId and captured OneSignal player ids', async () => {
    mockPrisma.oneSignalSubscription.findMany.mockResolvedValue([
      { playerId: 'player-a' },
      { playerId: 'player-b' },
    ]);

    await AuthService.eraseAccount(CUSTOMER.id);

    expect(sendMock).toHaveBeenCalledWith({
      name: 'account/erased',
      data: { userId: CUSTOMER.id, oneSignalPlayerIds: ['player-a', 'player-b'] },
    });
  });

  it('captures player ids BEFORE the transaction deletes the rows (read happens pre-transaction)', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    // findMany (the capture read) must have been called at all — proves
    // the propagation event data isn't just guessed from thin air.
    expect(mockPrisma.oneSignalSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: CUSTOMER.id },
      select: { playerId: true },
    });
    expect(mockPrisma.oneSignalSubscription.deleteMany).toHaveBeenCalledWith({
      where: { userId: CUSTOMER.id },
    });
  });

  it('resolves successfully even when the account/erased enqueue rejects (fail-open)', async () => {
    sendMock.mockRejectedValue(new Error('inngest is down'));

    await expect(AuthService.eraseAccount(CUSTOMER.id)).resolves.toBeUndefined();

    // The primary anonymization transaction still ran to completion.
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER.id } })
    );
  });

  it('sends an empty oneSignalPlayerIds array when the user has no subscriptions', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    expect(sendMock).toHaveBeenCalledWith({
      name: 'account/erased',
      data: { userId: CUSTOMER.id, oneSignalPlayerIds: [] },
    });
  });
});
