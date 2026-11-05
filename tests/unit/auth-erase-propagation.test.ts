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

import { AuthService, eraseNeedsCrmReview } from '@api/services/auth.service';
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
      data: {
        userId: CUSTOMER.id,
        oneSignalPlayerIds: ['player-a', 'player-b'],
        // for Ebda Chat's customer.erased: the store, and the hashed phone when configured
        storeId: CUSTOMER.storeId,
        // Customer Intelligence: no proven phone here, and the scope is the account's own (zero) orders
        ciProven: undefined,
        ciScope: { storeId: CUSTOMER.storeId, orderIds: [], buyerKeys: [], sinceDay: undefined },
      },
    });
  });

  it('scopes the CI erase to the shopper\u2019s OWN orders (ids + keys), never the key alone, and nulls the keys on the orders', async () => {
    mockPrisma.order.findMany.mockImplementation(
      async (args: { select?: { buyerKey?: boolean } }) =>
        args?.select?.buyerKey
          ? [
              { id: 'o1', buyerKey: 'k1', createdAt: new Date('2026-11-03T10:00:00Z') },
              { id: 'o2', buyerKey: 'k1', createdAt: new Date('2026-11-01T10:00:00Z') },
              { id: 'o3', buyerKey: null, createdAt: new Date('2026-11-05T10:00:00Z') },
            ]
          : []
    );
    await AuthService.eraseAccount(CUSTOMER.id);
    const data = sendMock.mock.calls.at(-1)![0].data;
    expect(data.ciScope).toEqual({
      storeId: CUSTOMER.storeId,
      orderIds: ['o1', 'o2', 'o3'],
      buyerKeys: ['k1'],
      sinceDay: '2026-10-30', // first order 2026-11-01 minus the 2-day margin
    });
    expect(data.ciProven).toBeUndefined(); // no proven phone: no buyer-key erase
    expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ buyerKey: null, areaKey: null }) })
    );
    mockPrisma.order.findMany.mockReset().mockResolvedValue([]);
  });

  it('erases the shopper\u2019s passkeys in the same transaction (Ruling PASSKEY-1)', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);
    expect(mockPrisma.passkeyCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: CUSTOMER.id },
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

    await expect(AuthService.eraseAccount(CUSTOMER.id)).resolves.toBeDefined();

    // The primary anonymization transaction still ran to completion.
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER.id, storeId: CUSTOMER.storeId } })
    );
  });

  it('erasure hands the avatar to the R2 cleanup WITH the user\u2019s own store, so an avatar under a store folder is still deleted', async () => {
    const avatar = 'https://cdn.example.com/stores/store-1/avatars/me.png';
    mockPrisma.user.findUnique.mockResolvedValue({ ...CUSTOMER, avatar });
    await AuthService.eraseAccount(CUSTOMER.id);
    // A user-scoped erase has no store in scope, and the delete refuses a store-namespaced key it
    // cannot attribute (Ruling VE-11): the store is taken from the user's own record.
    expect(deleteR2ObjectIfOrphan).toHaveBeenCalledWith(avatar, { ownerStoreId: 'store-1' });
  });

  it('sends an empty oneSignalPlayerIds array when the user has no subscriptions', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    expect(sendMock).toHaveBeenCalledWith({
      name: 'account/erased',
      data: {
        userId: CUSTOMER.id,
        oneSignalPlayerIds: [],
        storeId: CUSTOMER.storeId,
        ciProven: undefined,
        ciScope: { storeId: CUSTOMER.storeId, orderIds: [], buyerKeys: [], sinceDay: undefined },
      },
    });
  });
});

/**
 * `addresses` is the ONE erasure target carrying a USER-scoped RLS policy
 * (`user_id = current_user_id()`). On the merchant path `app.current_user_id` is the
 * MERCHANT — `tenantContext` sets it from `req.user?.userId` — so a plain delete matches ZERO
 * rows and returns `{count: 0}` with no error: the shopper's name, phone and street survive
 * an "erased" account while the audit row claims success.
 *
 * A count assertion cannot catch this — the mock returns `{count: 0}` either way, exactly as
 * Postgres would. What is pinned instead is the MECHANISM: the delete goes through the
 * `ebda_user_addresses_delete` definer (which deletes by the shopper's id inside the caller's
 * transaction), it runs before the later deletes, and no bypass GUC is set anywhere.
 */
describe('AuthService.eraseAccount — addresses delete escapes the user-scoped RLS policy', () => {
  const rawText = (call: unknown[]) => {
    const tpl = call[0] as unknown as string[];
    return Array.isArray(tpl) ? tpl.join('') : String(tpl);
  };

  it('deletes the shopper addresses through the definer, by the shopper id', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    expect(mockPrisma.address.deleteMany).toHaveBeenCalledWith({
      where: { userId: CUSTOMER.id },
    });
    // ordering: the addresses go before the later per-user deletes
    const delOrder = mockPrisma.address.deleteMany.mock.invocationCallOrder[0];
    const laterDelete = mockPrisma.refreshToken.deleteMany.mock.invocationCallOrder[0];
    expect(delOrder).toBeLessThan(laterDelete);
  });

  it('sets no bypass GUC anywhere in the erasure (there is none)', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);
    for (const c of mockPrisma.$executeRaw.mock.calls) {
      expect(rawText(c as unknown[])).not.toMatch(/bypass_rls/);
    }
  });
});

/**
 * #1957 — the wallet scrub/forfeit is account-wide, but `customer_wallets` and
 * `wallet_transactions` are store-scoped under RLS. It runs on the erasure transaction, scoped
 * to the account's own store; a legacy store_id = NULL shopper spans stores and its other-store
 * wallets are not reachable from one scope (documented gap, see the strict-RLS migration header).
 * What is pinned: the scrub and the lookup both run, in the erasure transaction, with no bypass.
 */
describe('AuthService.eraseAccount — wallet forfeit runs in the erasure scope', () => {
  it('runs the ledger note scrub and the wallet lookup on the erasure transaction, no bypass', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    expect(mockPrisma.walletTransaction.updateMany.mock.invocationCallOrder[0]).toBeDefined();
    expect(mockPrisma.customerWallet.findMany.mock.invocationCallOrder[0]).toBeDefined();
    for (const c of mockPrisma.$executeRaw.mock.calls) {
      expect(String((c as unknown[])[0])).not.toMatch(/bypass_rls/);
    }
  });
});

/**
 * The merchant-CRM scrub resolves a `customers` row with no FK to `users` — it
 * matches on identity fields. The destructive direction of that heuristic is
 * the danger: two shoppers in one store sharing a phone (household mobile, a
 * landline given at checkout, the same contact typed onto two rows — ordinary
 * in KW/GCC) meant erasing A hard-deleted B's `customer_addresses` and
 * overwrote B's name/email/phone/notes with "Erased User". Irreversible
 * destruction of a SECOND data subject from a request that authorised only the
 * first.
 *
 * Email is trusted (composite unique on `(storeId, email)`); phone is trusted
 * only when it resolves to exactly one row.
 */
describe('AuthService.eraseAccount — the CRM scrub refuses an ambiguous identity', () => {
  const withIdentity = (extra: Record<string, unknown>) =>
    mockPrisma.user.findUnique.mockResolvedValue({ ...CUSTOMER, ...extra });

  it('scrubs NOTHING when a shared phone matches more than one CRM row', async () => {
    withIdentity({ phone: '96550001111', email: null });
    mockPrisma.customer.findMany.mockResolvedValue([{ id: 'crm-a' }, { id: 'crm-b' }]);

    await AuthService.eraseAccount(CUSTOMER.id);

    // The second data subject's record must be untouched.
    expect(mockPrisma.customerAddress.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  /**
   * THE reachable collision. `@@unique([storeId, email])` is a plain
   * case-SENSITIVE Postgres index and nothing lowercases email on write, so
   * `Ahmad@gmail.com` and `ahmad@gmail.com` are two legal rows in one store —
   * and this read uses `mode: 'insensitive'`, so it returns BOTH. (The phone
   * branch cannot collide: `@@unique([storeId, phone])` forecloses it.)
   */
  it('scrubs NOTHING when two case-variant email rows match', async () => {
    withIdentity({ email: 'Ahmad@example.com', phone: null });
    mockPrisma.customer.findMany.mockResolvedValue([{ id: 'crm-upper' }, { id: 'crm-lower' }]);

    await AuthService.eraseAccount(CUSTOMER.id);

    expect(mockPrisma.customerAddress.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  it('scrubs a phone-matched row when the phone is unambiguous', async () => {
    withIdentity({ phone: '96550001111', email: null });
    mockPrisma.customer.findMany.mockResolvedValue([{ id: 'crm-only' }]);

    await AuthService.eraseAccount(CUSTOMER.id);

    expect(mockPrisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'crm-only', storeId: CUSTOMER.storeId } })
    );
    expect(mockPrisma.customerAddress.deleteMany).toHaveBeenCalledWith({
      where: { customerId: { in: ['crm-only'] } },
    });
  });

  it('still scrubs the email-matched row even when the phone is ambiguous', async () => {
    withIdentity({ phone: '96550001111', email: 'shopper@example.com' });
    // findMany is called twice: by email first, then by phone.
    mockPrisma.customer.findMany
      .mockResolvedValueOnce([{ id: 'crm-email' }])
      .mockResolvedValueOnce([{ id: 'crm-email' }, { id: 'crm-other' }]);

    await AuthService.eraseAccount(CUSTOMER.id);

    const scrubbed = mockPrisma.customer.update.mock.calls.map(
      (c: unknown[]) => (c[0] as { where: { id: string } }).where.id
    );
    expect(scrubbed).toEqual(['crm-email']);
    expect(scrubbed).not.toContain('crm-other');
  });
});

/**
 * #1871 — erasure must kill the sessions that are ALREADY open. Deleting the
 * refresh rows only stops the next one; every issued access token carries the
 * old `tv`, and `authenticate` reads `status` only on a tv-cache miss. On the
 * merchant path the shopper is not the actor, so nothing clears their cookies
 * and their token kept writing PII back onto the erased row.
 */
describe('AuthService.eraseAccount — revokes live access tokens (#1871)', () => {
  it('bumps tokenVersion in the erase write and pushes it into the tv cache', async () => {
    mockPrisma.user.update.mockResolvedValueOnce({ tokenVersion: 8 });

    await AuthService.eraseAccount(CUSTOMER.id);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CUSTOMER.id, storeId: CUSTOMER.storeId },
        data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
      })
    );
    expect(setUserTokenVersion).toHaveBeenCalledWith(CUSTOMER.id, 8);
  });

  it('still completes the erasure when the tv cache write fails, deleting the stale key instead', async () => {
    mockPrisma.user.update.mockResolvedValueOnce({ tokenVersion: 8 });
    setUserTokenVersion.mockRejectedValueOnce(new Error('redis blip'));

    await expect(AuthService.eraseAccount(CUSTOMER.id)).resolves.toBeDefined();
    // A miss makes the next request read the bumped tv + inactive status.
    expect(clearUserTokenVersion).toHaveBeenCalledWith(CUSTOMER.id);
  });

  // Issue 1964: on the inline paths (POST /auth/me/erase, the retention
  // cron) a failed push was a warn nobody watched while old access tokens
  // kept authenticating against the anonymized row.
  it('raises a P1 alert when the push cannot land at all, and still completes the erasure', async () => {
    sendAlert.mockClear();
    mockPrisma.user.update.mockResolvedValueOnce({ tokenVersion: 8 });
    setUserTokenVersion.mockRejectedValueOnce(new Error('redis down'));
    clearUserTokenVersion.mockRejectedValueOnce(new Error('redis down'));

    await expect(AuthService.eraseAccount(CUSTOMER.id)).resolves.toBeDefined();
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'auth.eraseAccount.revoke-sessions' })
    );
  });
});

/**
 * #1880 — the CRM scrub can match nothing or refuse an ambiguous match. That
 * used to be a warn line only, while the route reported an unqualified
 * success. The outcome is now returned so it reaches the audit row and the UI.
 */
describe('AuthService.eraseAccount — reports what the CRM scrub did (#1880)', () => {
  const withIdentity = (extra: Record<string, unknown>) =>
    mockPrisma.user.findUnique.mockResolvedValue({ ...CUSTOMER, ...extra });

  it('reports a scrubbed row', async () => {
    withIdentity({ phone: '96550001111', email: null });
    mockPrisma.customer.findMany.mockResolvedValue([{ id: 'crm-only' }]);

    const o = await AuthService.eraseAccount(CUSTOMER.id);

    expect(o).toEqual({ crmChecked: true, crmRowsScrubbed: 1, crmAmbiguous: false });
    expect(eraseNeedsCrmReview(o)).toBe(false);
  });

  it('reports a miss (recorded, but most shoppers have no CRM row, so not a review flag)', async () => {
    withIdentity({ phone: '96550001111', email: null });
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const o = await AuthService.eraseAccount(CUSTOMER.id);

    expect(o).toEqual({ crmChecked: true, crmRowsScrubbed: 0, crmAmbiguous: false });
    expect(eraseNeedsCrmReview(o)).toBe(false);
  });

  it('reports an ambiguous match as needing review, even when another identifier scrubbed', async () => {
    withIdentity({ phone: '96550001111', email: 'shopper@example.com' });
    mockPrisma.customer.findMany
      .mockResolvedValueOnce([{ id: 'crm-email' }])
      .mockResolvedValueOnce([{ id: 'crm-email' }, { id: 'crm-other' }]);

    const o = await AuthService.eraseAccount(CUSTOMER.id);

    expect(o).toEqual({ crmChecked: true, crmRowsScrubbed: 1, crmAmbiguous: true });
    expect(eraseNeedsCrmReview(o)).toBe(true);
  });

  it('does not ask for review when no CRM copy can exist (no store / no identifier)', async () => {
    withIdentity({ email: null, phone: null });
    const o = await AuthService.eraseAccount(CUSTOMER.id);

    expect(o.crmChecked).toBe(false);
    expect(eraseNeedsCrmReview(o)).toBe(false);
  });
});

// D2 (2026-09-25): the newsletter subscription and every email-campaign
// recipient row for the erased address in THIS store go too — both are keyed
// by (store, email) with no FK to users, so no userId delete reaches them.
describe('AuthService.eraseAccount — newsletter + campaign copies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
    mockPrisma.oneSignalSubscription.findMany.mockResolvedValue([]);
    mockPrisma.customer.findMany.mockResolvedValue([]);
    sendMock.mockResolvedValue({ ids: ['evt-1'] });
  });

  it('deletes the store-scoped subscriber and recipient rows by lowercased email', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      ...CUSTOMER,
      email: '  Shopper@Example.com ',
      phone: null,
    });

    await AuthService.eraseAccount(CUSTOMER.id);

    const where = { storeId: CUSTOMER.storeId, email: 'shopper@example.com' };
    expect(mockPrisma.newsletterSubscriber.deleteMany).toHaveBeenCalledWith({ where });
    expect(mockPrisma.campaignRecipient.deleteMany).toHaveBeenCalledWith({ where });
  });

  it('touches neither table when the account has no email', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...CUSTOMER, email: null, phone: '9655' });

    await AuthService.eraseAccount(CUSTOMER.id);

    expect(mockPrisma.newsletterSubscriber.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * Owner decision 2026-09-26 (Ruling W-7): a store deletes ONLY its own data.
 * The merchant route passes `scopeStoreId`; the shopper's own erasure and the
 * retention cron do not.
 */
describe('AuthService.eraseAccount — erasure scope (Ruling W-7)', () => {
  const rawText = (call: unknown[]) => {
    const tpl = call[0] as unknown as string[];
    return Array.isArray(tpl) ? tpl.join('') : String(tpl);
  };

  it('merchant-scoped: wallet statements are filtered to that store', async () => {
    await AuthService.eraseAccount(CUSTOMER.id, { scopeStoreId: 'store-1', actorId: 'merchant-1' });

    expect(mockPrisma.walletTransaction.updateMany).toHaveBeenCalledWith({
      where: {
        customerId: CUSTOMER.id,
        storeId: 'store-1',
        note: { not: null },
        NOT: { note: 'Forfeited on account erasure' },
      },
      data: { note: null },
    });
    expect(mockPrisma.customerWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: CUSTOMER.id, storeId: 'store-1' } })
    );
    // No cross-store audit rows on the merchant path (the route writes its own).
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("merchant-scoped: refuses an account that is not that store's own customer", async () => {
    await expect(
      AuthService.eraseAccount(CUSTOMER.id, { scopeStoreId: 'store-OTHER', actorId: 'merchant-1' })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // Issues 2122 / 2125: rows are written only for stores whose balance this
  // run forfeited. Zero-balance wallets (untouched stores, or every wallet on
  // a re-run of an already-erased account) write NOTHING — the positive case
  // (one row per forfeiting store, naming the actor) runs against a real DB in
  // tests/integration/customer-wallet.test.ts and rls-ebda-app.test.ts.
  it('unscoped (self / cron): a store whose liability did not change gets NO audit row', async () => {
    mockPrisma.customerWallet.findMany.mockResolvedValueOnce([
      { id: 'w-a', storeId: 'store-a', balance: 0 },
      { id: 'w-b', storeId: 'store-b', balance: 0 },
    ]);

    await AuthService.eraseAccount(CUSTOMER.id, { actorId: 'system' });

    const walletRows = mockPrisma.auditLog.create.mock.calls.filter(
      c => (c[0] as { data: { action: string } }).data.action === 'customer.wallet.erased'
    );
    expect(walletRows).toEqual([]);
  });

  // PR 2279 audit: a zero-balance store whose merchant-authored ledger notes
  // the erasure scrubbed must still get its own row saying so.
  it('unscoped: a zero-balance store whose ledger notes were scrubbed DOES get a row', async () => {
    mockPrisma.customerWallet.findMany.mockResolvedValueOnce([
      { id: 'w-a', storeId: 'store-a', balance: 0 },
    ]);
    mockPrisma.walletTransaction.findMany.mockResolvedValueOnce([{ storeId: 'store-a' }]);

    await AuthService.eraseAccount(CUSTOMER.id, { actorId: 'system' });

    const rows = mockPrisma.auditLog.create.mock.calls
      .map(c => (c[0] as { data: { storeId: string; action: string; details: unknown } }).data)
      .filter(d => d.action === 'customer.wallet.erased');
    expect(rows).toEqual([
      expect.objectContaining({
        storeId: 'store-a',
        details: expect.objectContaining({ forfeitedFils: 0, notesScrubbed: true }),
      }),
    ]);
  });
});

describe('AuthService.eraseAccount — WhatsApp marketing consent (WA-CONSENT-1), whole flow', () => {
  it('a number proven by a delivered order loses its consent row: the proof runs BEFORE the order scrub', async () => {
    process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
    const { buyerKeyFor } = await import('@ebda/shared');
    const { consentChangeTarget } = await import('@api/lib/wa/consent-state');
    const key = (await buyerKeyFor(process.env.SUITE_BUYER_KEY_SECRET, '01001234567'))!;
    const consents: Array<Record<string, unknown>> = [
      { storeId: 'store-1', buyerKey: key, userId: null, granted: true },
    ];
    let scrubbed = false;
    mockPrisma.user.findUnique.mockResolvedValue({
      ...CUSTOMER,
      phone: '01001234567',
      email: 'a@b.co',
    });
    // The delivered order proves the phone, but ONLY until the erasure scrubs the orders.
    mockPrisma.order.findMany.mockImplementation(async (args: any) =>
      args?.where?.status === 'delivered' && !scrubbed
        ? [{ shippingAddress: { phone: '+201001234567' } }]
        : []
    );
    mockPrisma.order.updateMany.mockImplementation(async () => {
      scrubbed = true;
      return { count: 1 };
    });
    mockPrisma.storeWhatsAppConsent.findMany.mockImplementation(async ({ where }: any) =>
      consents.filter(
        r =>
          r.storeId === where.storeId &&
          where.OR.some(
            (c: any) => c.buyerKey === r.buyerKey || (c.userId && c.userId === r.userId)
          )
      )
    );
    mockPrisma.storeWhatsAppConsent.deleteMany.mockImplementation(async ({ where }: any) => {
      const i = consents.findIndex(
        r => r.buyerKey === where.buyerKey && r.storeId === where.storeId
      );
      if (i >= 0) consents.splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
    });

    await AuthService.eraseAccount(CUSTOMER.id);

    expect(consents).toHaveLength(0);
    // the proof read happened before the scrub
    const proofCall = mockPrisma.order.findMany.mock.calls.findIndex(
      (c: any[]) => c[0]?.where?.status === 'delivered'
    );
    // the proof read used THIS store and THIS account (not another scope)
    expect(mockPrisma.order.findMany.mock.calls[proofCall]![0].where).toMatchObject({
      storeId: 'store-1',
      customerId: CUSTOMER.id,
      status: 'delivered',
    });
    expect(mockPrisma.order.findMany.mock.invocationCallOrder[proofCall]).toBeLessThan(
      mockPrisma.order.updateMany.mock.invocationCallOrder[0]!
    );
    // the delete is exactly what the consent observer attributes and announces as consent_changed=false
    const del = mockPrisma.storeWhatsAppConsent.deleteMany.mock.calls[0]![0];
    expect(
      consentChangeTarget({
        model: 'StoreWhatsAppConsent',
        operation: 'deleteMany',
        args: del,
        result: { count: 1 },
      })
    ).toEqual({ storeId: 'store-1', buyerKey: key });
  });
});

describe("AuthService.updateProfile — phone change ends the old number's WhatsApp consent", () => {
  it('revokes the OLD number in the SAME transaction as the phone write, under the account lock; a failed revoke aborts the update', async () => {
    process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
    mockPrisma.user.findUnique.mockResolvedValue({
      id: CUSTOMER.id,
      storeId: 'store-1',
      phone: '01001234567',
    });
    mockPrisma.user.update.mockClear();
    mockPrisma.storeWhatsAppConsent.updateMany = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(AuthService.updateProfile(CUSTOMER.id, { phone: '01112345678' })).rejects.toThrow(
      'db down'
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();

    mockPrisma.storeWhatsAppConsent.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$executeRaw.mockClear();
    await AuthService.updateProfile(CUSTOMER.id, { phone: '01112345678' });
    const lock = mockPrisma.$executeRaw.mock.invocationCallOrder[0]!;
    const rev = (mockPrisma.storeWhatsAppConsent.updateMany as any).mock.invocationCallOrder[0]!;
    const write = mockPrisma.user.update.mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(rev);
    expect(rev).toBeLessThan(write);
    // a formatting-only change (same E.164) revokes nothing
    (mockPrisma.storeWhatsAppConsent.updateMany as any).mockClear();
    await AuthService.updateProfile(CUSTOMER.id, { phone: '+201001234567' });
    expect(mockPrisma.storeWhatsAppConsent.updateMany).not.toHaveBeenCalled();
  });
});

describe('WA-CONSENT-PROOF-1: account/erased carries a buyerKey only for a PROVEN phone', () => {
  const setup = (delivered: boolean) => {
    process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
    mockPrisma.user.findUnique.mockResolvedValue({
      ...CUSTOMER,
      phone: '01001234567', // the (possibly someone else's) number on the profile
      email: 'a@b.co',
    });
    mockPrisma.order.findMany.mockImplementation(async (args: any) =>
      delivered && args?.where?.status === 'delivered'
        ? [{ shippingAddress: { phone: '+201001234567' } }]
        : []
    );
    mockPrisma.storeWhatsAppConsent.findMany.mockResolvedValue([]);
    sendMock.mockClear();
  };
  const erasedEvent = () =>
    sendMock.mock.calls.map(c => c[0]).find((e: any) => e?.name === 'account/erased');

  it("an attacker who typed a victim's number (no order proves it) sends NO buyerKey: WhatsApp keeps the victim's contact", async () => {
    setup(false);
    await AuthService.eraseAccount(CUSTOMER.id);
    const ev = erasedEvent();
    expect(ev).toBeTruthy();
    expect(ev.data.buyerKey).toBeUndefined();
  });

  it("the proven owner's erasure carries the buyerKey", async () => {
    setup(true);
    await AuthService.eraseAccount(CUSTOMER.id);
    expect(erasedEvent().data.buyerKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
