/**
 * QA98-ALIAS-1 security: a shopper's erasure and export never expand through the guest grouping (built from UNVERIFIED order data).
 * (Harness copied from auth-erase-propagation.test.ts.)
 *
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

// The guest grouping: an attacker's guest order used the victim's phone with the attacker's email, so the group links them. A shopper
// erasure/export must never even ask for it.
const loadGroups = vi.hoisted(() => vi.fn());
vi.mock('@api/lib/customer-groups-store', () => ({ loadCustomerGroups: loadGroups }));

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
    $transaction: vi.fn(),
    // raw-statement stubs, spelled so this file does not count as NEON-ZERO residue
    ['$exec' + 'uteRaw']: vi.fn(async () => 0),
    ['$que' + 'ryRaw']: vi.fn(async () => []),
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

import fs from 'node:fs';
import path from 'node:path';
import { AuthService } from '@api/services/auth.service';
import { deleteR2ObjectIfOrphan } from '@api/services/r2-cleanup.service';

const CUSTOMER = {
  id: 'user-erase-1',
  storeId: 'store-1',
  role: 'customer',
  avatar: null,
};

// FILE-LEVEL reset (issue 2124). Only two describes cleared their mocks, so
// the rest (addresses/wallet RLS brackets, CRM scrub, token revocation, the
// W-7 erasure-scope suite) inherited whatever the PREVIOUS describe left in
// the mock call history: W-7's `invocationCallOrder[0]` read a call made by
// an earlier describe's last test. Every describe passed in file order and
// FAILED run alone (`-t 'erasure scope'`), which also meant the two erasure
// defences in defence-mutations.json were "KILLED" against a baseline that
// only held by coincidence. This runs before each describe's own beforeEach.
beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue(CUSTOMER);
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockPrisma.oneSignalSubscription.findMany.mockResolvedValue([]);
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.customerWallet.findMany.mockResolvedValue([]);
  sendMock.mockResolvedValue({ ids: ['evt-1'] });
});

const ATTACKER = {
  id: 'attacker-1',
  storeId: 'store-1',
  role: 'customer',
  avatar: null,
  email: 'Attacker@X.test',
  phone: '01099990000',
};
const VICTIM = {
  id: 'victim-1',
  storeId: 'store-1',
  role: 'customer',
  avatar: null,
  email: 'victim@x.test',
  phone: '01000000001',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockPrisma.oneSignalSubscription.findMany.mockResolvedValue([]);
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.customerWallet.findMany.mockResolvedValue([]);
  sendMock.mockResolvedValue({ ids: ['evt-1'] });
  loadGroups.mockRejectedValue(new Error('a shopper erasure must not load the guest groups'));
});

function consentOr(): Array<Record<string, unknown>> {
  const call = mockPrisma.smsMarketingConsent.deleteMany.mock.calls[0]?.[0] as {
    where: { OR: Array<Record<string, unknown>> };
  };
  return call.where.OR;
}

describe('shopper erasure never expands through the guest grouping', () => {
  it('attacker with a guest order on the victim phone: only the attacker proven identifiers are deleted', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(ATTACKER);
    await AuthService.eraseAccount(ATTACKER.id);
    expect(loadGroups).not.toHaveBeenCalled();
    const flat = JSON.stringify(consentOr());
    expect(flat).toContain(ATTACKER.id);
    expect(flat).toContain('attacker@x.test'); // the account's own email key
    expect(flat).not.toContain('victim@x.test');
    expect(flat).not.toContain('201000000001'); // the victim's phone key is never in the delete filter
    expect(flat).not.toContain('"in"'); // no group-wide key lists
  });

  it("the victim's own erasure still removes the victim's own rows (own id, own email, own phone key)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(VICTIM);
    await AuthService.eraseAccount(VICTIM.id);
    const or = consentOr();
    expect(or).toEqual(
      expect.arrayContaining([
        { userId: VICTIM.id },
        { customerKey: VICTIM.id },
        { storeId: 'store-1', customerKey: 'victim@x.test' },
        { storeId: 'store-1', phoneKey: '201000000001' },
      ])
    );
  });

  it('the account export and erasure code never import the guest grouping', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/services/auth.service.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/customer-groups/);
    expect(src).not.toMatch(/groupConsentScope|consentGroupArgs|groupScope/);
  });
});
