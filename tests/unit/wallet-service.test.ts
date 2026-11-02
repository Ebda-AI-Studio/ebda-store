/**
 * WalletService.applyEntry — the money guards (D1, customer wallet).
 *
 * Pure unit test over an in-memory fake transaction client, so it pins the
 * service's OWN control flow: the no-negative-balance guard, idempotent replay,
 * key-reuse refusal, lock-before-read ordering and the cross-store customer
 * refusal. The real-Postgres half (FOR UPDATE actually serialising two
 * concurrent debits, the DB CHECK backstop) is
 * tests/integration/customer-wallet.test.ts.
 *
 * Two of these tests are the named guards in docs/security/defence-mutations.json
 * (`money-wallet-no-negative-balance`, `money-wallet-idempotent-replay`):
 * deleting the guard in wallet.service.ts must turn them red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const glPost = vi.hoisted(() => vi.fn(async () => ({ posted: true })));
vi.mock('@api/services/accounting/posting/wallet-posting', () => ({
  postWalletMovementJournal: glPost,
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  hasTenantContext: () => false,
}));

import { WalletService } from '@api/services/wallet.service';

const STORE = 'store-1';
const CUSTOMER = 'cust-1';

interface Wallet {
  id: string;
  storeId: string;
  customerId: string;
  balance: number;
}
interface Entry {
  id: string;
  storeId: string;
  walletId: string;
  customerId: string;
  amount: number;
  balanceAfter: number;
  type: string;
  idempotencyKey: string;
  orderId: string | null;
  returnId: string | null;
  actorId: string | null;
  note: string | null;
  createdAt: Date;
}

/** Minimal fake of the Prisma calls applyEntry makes, with a call log. */
function makeClient(opts: { customers?: Array<{ id: string; storeId: string }> } = {}) {
  const wallets: Wallet[] = [];
  const entries: Entry[] = [];
  const calls: string[] = [];
  const customers = opts.customers ?? [{ id: CUSTOMER, storeId: STORE }];
  let n = 0;

  const client = {
    customerWallet: {
      findUnique: vi.fn(async ({ where }: any) => {
        calls.push('wallet.findUnique');
        const k = where.storeId_customerId;
        const w = wallets.find(x => x.storeId === k.storeId && x.customerId === k.customerId);
        return w ? { id: w.id } : null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        calls.push('wallet.update');
        const w = wallets.find(x => x.id === where.id)!;
        w.balance = data.balance;
        return w;
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: any) => {
        calls.push('user.findFirst');
        // storeCustomerWhere: { id, role, storeId } — the store-scoped branch.
        const storeId = where.storeId;
        return customers.find(c => c.id === where.id && c.storeId === storeId) ?? null;
      }),
    },
    walletTransaction: {
      // reverseOrderPayment nets the wallet shares of split gateway refunds
      // (#1956) out of the whole-order reversal.
      aggregate: vi.fn(async ({ where }: any) => ({
        _sum: {
          amount:
            entries
              .filter(
                e =>
                  e.storeId === where.storeId &&
                  e.orderId === where.orderId &&
                  e.type === where.type &&
                  e.idempotencyKey.startsWith(where.idempotencyKey.startsWith)
              )
              .reduce((sum, e) => sum + e.amount, 0) || null,
        },
      })),
      findUnique: vi.fn(async ({ where }: any) => {
        calls.push('entry.findUnique');
        const k = where.storeId_idempotencyKey;
        return (
          entries.find(e => e.storeId === k.storeId && e.idempotencyKey === k.idempotencyKey) ??
          null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        calls.push('entry.create');
        const e: Entry = { id: `e${++n}`, createdAt: new Date(), ...data };
        entries.push(e);
        return e;
      }),
    },
    $executeRaw: vi.fn(
      async (_s: TemplateStringsArray, id: string, storeId: string, customerId: string) => {
        calls.push('wallet.insertOnConflict');
        if (!wallets.some(w => w.storeId === storeId && w.customerId === customerId)) {
          wallets.push({ id, storeId, customerId, balance: 0 });
        }
        return 1;
      }
    ),
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, storeId: string, customerId: string) => {
      calls.push('wallet.lockForUpdate');
      return wallets
        .filter(w => w.storeId === storeId && w.customerId === customerId)
        .map(w => ({ id: w.id, balance: w.balance }));
    }),
  };
  return { client: client as any, wallets, entries, calls };
}

function credit(amount: number, key: string, customerId = CUSTOMER) {
  return {
    storeId: STORE,
    customerId,
    amount,
    type: 'admin_adjust' as const,
    idempotencyKey: key,
  };
}

describe('WalletService.applyEntry', () => {
  let db: ReturnType<typeof makeClient>;
  beforeEach(() => {
    db = makeClient();
  });

  it('first credit creates the wallet, appends a ledger row and caches the balance', async () => {
    const r = await WalletService.applyEntry(credit(5000, 'k1'), db.client);
    expect(r.replayed).toBe(false);
    expect(r.balance).toBe(5000);
    expect(db.wallets[0].balance).toBe(5000);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0]).toMatchObject({ amount: 5000, balanceAfter: 5000 });
  });

  it('journals every NEW movement on the GL in the same transaction (WALLET-GL-1), a replay never', async () => {
    glPost.mockClear();
    const first = await WalletService.applyEntry(credit(2000, 'gl-1'), db.client);
    expect(glPost).toHaveBeenCalledTimes(1);
    expect(glPost).toHaveBeenCalledWith({ entry: first.entry, tx: db.client });
    await WalletService.applyEntry(credit(2000, 'gl-1'), db.client);
    expect(glPost).toHaveBeenCalledTimes(1);
  });
  it('a refused debit journals nothing', async () => {
    glPost.mockClear();
    await expect(WalletService.applyEntry(credit(-1, 'gl-2'), db.client)).rejects.toBeTruthy();
    expect(glPost).not.toHaveBeenCalled();
  });
  it('refuses a debit that would take the balance below zero, and writes NOTHING', async () => {
    await WalletService.applyEntry(credit(3000, 'k1'), db.client);
    await expect(WalletService.applyEntry(credit(-3001, 'k2'), db.client)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_WALLET_BALANCE',
    });
    expect(db.entries).toHaveLength(1);
    expect(db.wallets[0].balance).toBe(3000);
  });

  it('allows a debit that takes the balance to exactly zero', async () => {
    await WalletService.applyEntry(credit(3000, 'k1'), db.client);
    const r = await WalletService.applyEntry(credit(-3000, 'k2'), db.client);
    expect(r.balance).toBe(0);
    expect(db.entries.map(e => e.balanceAfter)).toEqual([3000, 0]);
  });

  it('a debit against a customer with no wallet is an insufficient balance, not a new wallet', async () => {
    await expect(WalletService.applyEntry(credit(-1, 'k1'), db.client)).rejects.toMatchObject({
      code: 'INSUFFICIENT_WALLET_BALANCE',
    });
    expect(db.wallets).toHaveLength(0);
    expect(db.client.$executeRaw).not.toHaveBeenCalled();
  });

  it('replaying the same idempotency key moves no money and returns the original entry', async () => {
    const first = await WalletService.applyEntry(credit(2000, 'return-credit:r1'), db.client);
    const again = await WalletService.applyEntry(credit(2000, 'return-credit:r1'), db.client);
    expect(again.replayed).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect(db.entries).toHaveLength(1);
    expect(db.wallets[0].balance).toBe(2000);
  });

  it('refuses the same key for a DIFFERENT movement instead of silently replaying it', async () => {
    await WalletService.applyEntry(credit(2000, 'k1'), db.client);
    await expect(WalletService.applyEntry(credit(2500, 'k1'), db.client)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(db.entries).toHaveLength(1);
  });

  it('takes the wallet row lock BEFORE the idempotency read and the balance check', async () => {
    await WalletService.applyEntry(credit(1000, 'k1'), db.client);
    db.calls.length = 0;
    await WalletService.applyEntry(credit(-400, 'k2'), db.client);
    const lock = db.calls.indexOf('wallet.lockForUpdate');
    const idem = db.calls.indexOf('entry.findUnique');
    const write = db.calls.indexOf('entry.create');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(idem);
    expect(idem).toBeLessThan(write);
  });

  it('refuses to create a wallet for a customer who does not belong to the store', async () => {
    const other = makeClient({ customers: [{ id: CUSTOMER, storeId: 'another-store' }] });
    await expect(WalletService.applyEntry(credit(1000, 'k1'), other.client)).rejects.toMatchObject({
      statusCode: 404,
      code: 'CUSTOMER_NOT_FOUND',
    });
    expect(other.wallets).toHaveLength(0);
  });

  it.each([0, 1.5, Number.NaN, 100_000_001, -100_000_001])(
    'rejects an invalid amount (%s) before touching the database',
    async amount => {
      await expect(WalletService.applyEntry(credit(amount, 'k1'), db.client)).rejects.toMatchObject(
        { code: 'INVALID_WALLET_AMOUNT' }
      );
      expect(db.calls).toEqual([]);
    }
  );

  it('keeps balance == SUM(ledger) and every balanceAfter as the running sum', async () => {
    const moves = [5000, -1200, 300, -4100, 700];
    for (const [i, m] of moves.entries()) {
      await WalletService.applyEntry(credit(m, `k${i}`), db.client);
    }
    const sum = db.entries.reduce((s, e) => s + e.amount, 0);
    expect(db.wallets[0].balance).toBe(sum);
    let running = 0;
    for (const e of db.entries) {
      running += e.amount;
      expect(e.balanceAfter).toBe(running);
    }
  });
});

describe('WalletService.reverseOrderPayment', () => {
  it('credits back exactly the checkout spend, once, to the wallet that paid', async () => {
    const db = makeClient();
    await WalletService.applyEntry(credit(5000, 'seed'), db.client);
    await WalletService.debitForOrder(
      { storeId: STORE, customerId: CUSTOMER, orderId: 'o1', amount: 3500 },
      db.client
    );
    // reverseOrderPayment finds the spend with findFirst — extend the fake.
    db.client.walletTransaction.findFirst = vi.fn(
      async ({ where }: any) =>
        db.entries.find(
          e => e.storeId === where.storeId && e.orderId === where.orderId && e.type === where.type
        ) ?? null
    );

    const first = await WalletService.reverseOrderPayment(
      { storeId: STORE, orderId: 'o1' },
      db.client
    );
    const second = await WalletService.reverseOrderPayment(
      { storeId: STORE, orderId: 'o1' },
      db.client
    );
    expect(first?.replayed).toBe(false);
    expect(second?.replayed).toBe(true);
    expect(db.wallets[0].balance).toBe(5000);
    expect(db.entries.filter(e => e.type === 'order_payment_reversal')).toHaveLength(1);
  });

  it('is a no-op for an order that never spent from a wallet', async () => {
    const db = makeClient();
    db.client.walletTransaction.findFirst = vi.fn(async () => null);
    await expect(
      WalletService.reverseOrderPayment({ storeId: STORE, orderId: 'o-none' }, db.client)
    ).resolves.toBeNull();
    expect(db.entries).toHaveLength(0);
  });
});
