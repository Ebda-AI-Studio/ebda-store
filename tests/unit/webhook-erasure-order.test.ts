/**
 * M10 / Ruling WH-7: `AuthService.eraseAccount` strips the shopper's contact data from the webhook delivery log BEFORE the
 * orders lose their customer link (the redaction matches the log by those order ids and the email, so once the link is
 * gone the match is gone). Behaviour, not source order: the real eraseAccount runs against a recording fake transaction and the
 * recorded statement order is asserted. The harness (mocks) mirrors tests/unit/auth-erase-propagation.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: { sendOrderConfirmation: vi.fn() },
}));

vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked: vi.fn().mockResolvedValue({ locked: false }),
    recordFailedAttempt: vi.fn(),
    clearAttempts: vi.fn(),
  },
}));

const { setUserTokenVersion, clearUserTokenVersion, sendAlert } = vi.hoisted(() => ({
  setUserTokenVersion: vi.fn().mockResolvedValue(undefined),
  clearUserTokenVersion: vi.fn().mockResolvedValue(undefined),
  sendAlert: vi.fn().mockResolvedValue('sent'),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: vi.fn().mockReturnValue(false),
    getClient: vi.fn(),
    setUserTokenVersion,
    clearUserTokenVersion,
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert }));

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
    passkeyCredential: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    order: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // webhook delivery-log redaction (Ruling WH-7)
    $executeRaw: vi.fn().mockResolvedValue(0),
    review: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    address: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    smsMarketingConsent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    storeWhatsAppConsent: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    abandonedCart: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    cart: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    wishlist: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    wholesaleApplication: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    pushSubscription: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    providerVerification: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    refreshToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    loyaltyTransaction: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    loyaltyPoints: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // Customer wallet (D1): erasure scrubs ledger notes and forfeits any
    // balance. No wallet here — the forfeit path itself is covered against a
    // real DB in tests/integration/customer-wallet.test.ts.
    walletTransaction: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      // Stores whose ledger notes the erasure scrubs (PR 2279 audit).
      findMany: vi.fn().mockResolvedValue([]),
    },
    customerWallet: { findMany: vi.fn().mockResolvedValue([]) },
    customer: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerAddress: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    newsletterSubscriber: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    campaignRecipient: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    instapayReceipt: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
    // Records every raw statement: strict RLS has no bypass GUC, so none may mention one.
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return { sendMock, mockPrisma };
});

vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: sendMock },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
  // These tests cover the context-less callers (self-service /auth/me/erase,
  // the retention cron), which take the `withMoneyTx` branch. The ambient
  // tenant-transaction branch is covered against a real DB + RLS in
  // tests/integration/customer-privacy-cross-tenant.test.ts.
  hasTenantContext: () => false,
  currentStoreId: () => 'store-1',
  // Delegates to the mocked $transaction, invoking the callback with the
  // same mock prisma object (tx.* === prisma.* here, which is fine — the
  // real distinction only matters for RLS/isolation, not this test).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
  // The shopper is read as themselves, and the context-less erase opens its own scoped
  // transaction: both just run the callback against the fake client here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withUser: async (_userId: string, fn: any) => fn(mockPrisma),
  runInTenantContext: async (_storeId: string | undefined, fn: () => unknown) => fn(),
}));

// Address erasure and the wallet-forfeit audit rows go through SECURITY DEFINER functions
// (`ebda_user_addresses_delete`, `ebda_audit_log_insert`); `address.deleteMany` and
// `auditLog.create` stay the fakes the assertions below read.
vi.mock('@api/lib/definer', () => ({
  deleteUserAddresses: (userId: string) => mockPrisma.address.deleteMany({ where: { userId } }),
  // `ebda_user_tokens_delete` clears the user's push subscriptions + refresh + verification tokens
  // in one guarded call.
  deleteUserTokens: async (userId: string) => {
    await mockPrisma.oneSignalSubscription.deleteMany({ where: { userId } });
    await mockPrisma.refreshToken.deleteMany({ where: { userId } });
    await mockPrisma.verificationToken.deleteMany({ where: { userId } });
    return 0;
  },
  deleteUserPasskeys: async (userId: string) => {
    await mockPrisma.passkeyCredential.deleteMany({ where: { userId } });
    return 0;
  },
  insertAuditLog: (e: { action: string; storeId?: string | null; details?: unknown }) =>
    mockPrisma.auditLog.create({
      data: { action: e.action, storeId: e.storeId ?? null, details: e.details },
    }),
}));

import { AuthService } from '@api/services/auth.service';

const CUSTOMER = { id: 'user-erase-1', storeId: 'store-1', role: 'customer', avatar: null };

describe('AuthService.eraseAccount: webhook delivery-log redaction order', () => {
  const events: string[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    mockPrisma.user.findUnique.mockResolvedValue(CUSTOMER);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
    mockPrisma.oneSignalSubscription.findMany.mockResolvedValue([]);
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customerWallet.findMany.mockResolvedValue([]);
    sendMock.mockResolvedValue({ ids: ['evt-1'] });
    mockPrisma.order.findMany.mockResolvedValue([
      { id: 'o1', buyerKey: null, createdAt: new Date() },
    ]);
    mockPrisma.$executeRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('UPDATE webhook_deliveries')) events.push('redact-webhooks');
      return 0;
    }) as never);
    mockPrisma.order.updateMany.mockImplementation((async (a: { data?: { customerId?: null } }) => {
      if (a?.data && 'customerId' in a.data) events.push('unlink-orders');
      return { count: 1 };
    }) as never);
  });

  it('redacts the webhook delivery log before the orders lose their customer link', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);
    expect(events).toContain('redact-webhooks');
    expect(events).toContain('unlink-orders');
    expect(events.indexOf('redact-webhooks')).toBeLessThan(events.indexOf('unlink-orders'));
  });
});
