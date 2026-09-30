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

const { setUserTokenVersion } = vi.hoisted(() => ({
  setUserTokenVersion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: vi.fn().mockReturnValue(false), getClient: vi.fn(), setUserTokenVersion },
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
    // Customer wallet (D1): erasure scrubs ledger notes and forfeits any
    // balance. No wallet here — the forfeit path itself is covered against a
    // real DB in tests/integration/customer-wallet.test.ts.
    walletTransaction: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    customerWallet: { findMany: vi.fn().mockResolvedValue([]) },
    customer: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    customerAddress: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    newsletterSubscriber: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    campaignRecipient: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn(),
    // `SET LOCAL app.bypass_rls` brackets the addresses delete — see the
    // rls-bypass test below for why removing it silently under-erases.
    $executeRaw: vi.fn().mockResolvedValue(0),
    // withScopedRlsBypass reads the prior GUC before switching it on.
    $queryRaw: vi.fn().mockResolvedValue([{ v: null }]),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return { sendMock, mockPrisma };
});

vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: sendMock },
}));

vi.mock('@force/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
  // These tests cover the context-less callers (self-service /auth/me/erase,
  // the retention cron), which take the `withMoneyTx` branch. The ambient
  // tenant-transaction branch is covered against a real DB + RLS in
  // tests/integration/customer-privacy-cross-tenant.test.ts.
  hasTenantContext: () => false,
  // Delegates to the mocked $transaction, invoking the callback with the
  // same mock prisma object (tx.* === prisma.* here, which is fine — the
  // real distinction only matters for RLS/isolation, not this test).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRlsBypass: (fn: any) => fn(mockPrisma),
}));

import { AuthService, eraseNeedsCrmReview } from '@api/services/auth.service';

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

    await expect(AuthService.eraseAccount(CUSTOMER.id)).resolves.toBeDefined();

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

/**
 * `addresses` is the ONE erasure target carrying a USER-scoped RLS policy
 * (`rls_addresses_user`: `user_id = current_user_id()`). On the merchant path
 * `app.current_user_id` is the MERCHANT — `tenantContext` sets it from
 * `req.user?.userId` — so without a bypass the delete matches ZERO rows and
 * returns `{count: 0}` with no error: the shopper's name, phone and street
 * survive an "erased" account while the audit row claims success. Inert today
 * (prod connects as neondb_owner, BYPASSRLS), live the day force_app cuts over.
 *
 * A count assertion cannot catch this — the mock returns `{count: 0}` either
 * way, exactly as Postgres would. The only observable difference is that the
 * delete is BRACKETED by the bypass, so that is what is pinned.
 */
describe('AuthService.eraseAccount — addresses delete escapes the user-scoped RLS policy', () => {
  const rawText = (call: unknown[]) => {
    const tpl = call[0] as unknown as string[];
    return Array.isArray(tpl) ? tpl.join('') : String(tpl);
  };

  it('brackets the addresses delete with SET LOCAL app.bypass_rls true then false', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    const raws = mockPrisma.$executeRaw.mock.calls.map(rawText);
    const on = raws.findIndex(t => /app\.bypass_rls\s*=\s*'true'/.test(t));
    const off = raws.findIndex(t => /app\.bypass_rls\s*=\s*'false'/.test(t));

    expect(on, 'no SET LOCAL app.bypass_rls = true was issued').toBeGreaterThanOrEqual(0);
    expect(off, 'the bypass is never switched back off').toBeGreaterThan(on);

    // Ordering, not just presence: the bypass must be ON when the delete runs
    // and OFF again afterwards, or it either does nothing or silently widens
    // every remaining delete in the erasure.
    const onOrder = mockPrisma.$executeRaw.mock.invocationCallOrder[on];
    const offOrder = mockPrisma.$executeRaw.mock.invocationCallOrder[off];
    const delOrder = mockPrisma.address.deleteMany.mock.invocationCallOrder[0];

    expect(mockPrisma.address.deleteMany).toHaveBeenCalledWith({
      where: { userId: CUSTOMER.id },
    });
    expect(onOrder).toBeLessThan(delOrder);
    expect(offOrder).toBeGreaterThan(delOrder);
  });

  it('does not leave the bypass on for the rest of the erasure', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    const raws = mockPrisma.$executeRaw.mock.calls.map(rawText);
    const offOrder =
      mockPrisma.$executeRaw.mock.invocationCallOrder[
        raws.findIndex(t => /app\.bypass_rls\s*=\s*'false'/.test(t))
      ];
    // refreshToken is deleted after addresses; it must run under normal RLS.
    const laterDelete = mockPrisma.refreshToken.deleteMany.mock.invocationCallOrder[0];

    expect(offOrder).toBeLessThan(laterDelete);
  });
});

/**
 * #1957 — the wallet scrub/forfeit is account-wide, but `customer_wallets` and
 * `wallet_transactions` are store-scoped under RLS. On the merchant-initiated
 * path the ambient tx carries the ERASING store's GUC, so without its own
 * scoped bypass a legacy multi-store shopper's other-store note and balance
 * survive the erasure under force_app. Same pinning shape as the addresses
 * test above: the wallet statements must run INSIDE a bypass bracket, and the
 * bracket must be closed before the merchant-CRM scrub that follows.
 */
describe('AuthService.eraseAccount — wallet forfeit escapes the store-scoped RLS policy', () => {
  const rawText = (call: unknown[]) => {
    const tpl = call[0] as unknown as string[];
    return Array.isArray(tpl) ? tpl.join('') : String(tpl);
  };
  const bypassOrders = (value: 'true' | 'false') => {
    const re = new RegExp(`app\\.bypass_rls\\s*=\\s*'${value}'`);
    return mockPrisma.$executeRaw.mock.calls
      .map((c, i) =>
        re.test(rawText(c)) ? mockPrisma.$executeRaw.mock.invocationCallOrder[i] : -1
      )
      .filter(o => o >= 0);
  };

  it('runs the ledger note scrub and the wallet lookup with the bypass ON, then turns it OFF', async () => {
    await AuthService.eraseAccount(CUSTOMER.id);

    const scrub = mockPrisma.walletTransaction.updateMany.mock.invocationCallOrder[0];
    const lookup = mockPrisma.customerWallet.findMany.mock.invocationCallOrder[0];
    expect(scrub, 'wallet note scrub never ran').toBeDefined();
    expect(lookup, 'wallet lookup never ran').toBeDefined();

    const onBefore = bypassOrders('true').filter(o => o < scrub);
    const offBetween = bypassOrders('false').filter(o => o < scrub && o > Math.max(...onBefore));
    expect(onBefore.length, 'no bypass ON precedes the wallet scrub').toBeGreaterThan(0);
    expect(offBetween, 'the bypass was switched OFF again before the wallet scrub').toEqual([]);

    const offAfter = bypassOrders('false').filter(o => o > lookup);
    expect(offAfter.length, 'the bypass is left ON after the wallet forfeit').toBeGreaterThan(0);
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
      expect.objectContaining({ where: { id: 'crm-only' } })
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
        where: { id: CUSTOMER.id },
        data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
      })
    );
    expect(setUserTokenVersion).toHaveBeenCalledWith(CUSTOMER.id, 8);
  });

  it('still completes the erasure when the tv cache write fails (fail-open)', async () => {
    mockPrisma.user.update.mockResolvedValueOnce({ tokenVersion: 8 });
    setUserTokenVersion.mockRejectedValueOnce(new Error('redis down'));

    await expect(AuthService.eraseAccount(CUSTOMER.id)).resolves.toBeDefined();
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

  it('merchant-scoped: wallet statements are filtered to that store and run WITHOUT a bypass', async () => {
    await AuthService.eraseAccount(CUSTOMER.id, { scopeStoreId: 'store-1', actorId: 'merchant-1' });

    expect(mockPrisma.walletTransaction.updateMany).toHaveBeenCalledWith({
      where: { customerId: CUSTOMER.id, storeId: 'store-1', note: { not: null } },
      data: { note: null },
    });
    expect(mockPrisma.customerWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: CUSTOMER.id, storeId: 'store-1' } })
    );
    // The only bypass bracket is the addresses delete, closed before the wallet scrub.
    const scrub = mockPrisma.walletTransaction.updateMany.mock.invocationCallOrder[0];
    const lastOn = Math.max(
      ...mockPrisma.$executeRaw.mock.calls
        .map((c, i) =>
          /bypass_rls\s*=\s*'true'/.test(rawText(c))
            ? mockPrisma.$executeRaw.mock.invocationCallOrder[i]
            : -1
        )
        .filter(o => o >= 0)
    );
    const offAfterOn = mockPrisma.$executeRaw.mock.calls.some(
      (c, i) =>
        /bypass_rls\s*=\s*'false'/.test(rawText(c)) &&
        mockPrisma.$executeRaw.mock.invocationCallOrder[i] > lastOn &&
        mockPrisma.$executeRaw.mock.invocationCallOrder[i] < scrub
    );
    expect(offAfterOn, 'bypass still ON when the merchant-scoped wallet scrub runs').toBe(true);
    // No cross-store audit rows on the merchant path (the route writes its own).
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("merchant-scoped: refuses an account that is not that store's own customer", async () => {
    await expect(
      AuthService.eraseAccount(CUSTOMER.id, { scopeStoreId: 'store-OTHER', actorId: 'merchant-1' })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('unscoped (self / cron): one audit row per affected store, and the ledger entry names the actor', async () => {
    mockPrisma.customerWallet.findMany.mockResolvedValueOnce([
      { id: 'w-a', storeId: 'store-a', balance: 0 },
      { id: 'w-b', storeId: 'store-b', balance: 0 },
    ]);

    await AuthService.eraseAccount(CUSTOMER.id, { actorId: 'system' });

    const rows = mockPrisma.auditLog.create.mock.calls.map(
      c => (c[0] as { data: { storeId: string; userId: string | null; action: string } }).data
    );
    expect(rows.map(r => r.storeId).sort()).toEqual(['store-a', 'store-b']);
    for (const r of rows) {
      expect(r.action).toBe('customer.wallet.erased');
      expect(r.userId).toBeNull(); // 'system' is not a user row
    }
  });
});
