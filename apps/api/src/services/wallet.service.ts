import crypto from 'crypto';
import {
  currentStoreId,
  prisma,
  Prisma,
  withMoneyTx,
  hasTenantContext,
  type WalletTransactionType,
} from '@ebda/database';
import { storeMoney } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';
import logger from '../lib/logger';
import { insertAuditLog } from '../lib/definer';
import { RETURN_WALLET_SHARE_KEY_PREFIX, returnWalletShareKey } from '../lib/refund-methods';
import { postWalletMovementJournal } from './accounting/posting/wallet-posting';

/**
 * Customer wallet (store credit) — the ONLY writer of `customer_wallets` and
 * `wallet_transactions`. Design + invariants: docs/plans/2026-09-25-customer-wallet.md.
 *
 * Every money movement is one call to `applyEntry`, which:
 *   1. makes sure a wallet row exists (credits only — a debit against a
 *      customer with no wallet is simply an insufficient balance),
 *   2. takes the wallet row lock (`SELECT … FOR UPDATE`),
 *   3. UNDER THE LOCK re-checks the idempotency key and the balance,
 *   4. appends the ledger row and writes the cached balance.
 *
 * Steps 2-4 are why two concurrent debits cannot both pass and why a
 * redelivered event cannot move money twice: every writer for one wallet
 * queues on the same row lock, and whoever runs second sees what the first
 * committed. The DB CHECKs (balance >= 0, balance_after >= 0) are the
 * backstop if a future write path ever bypasses this function.
 *
 * Transactions: pass the caller's `tx` (order create, rollback, erasure). With
 * no `client`, it runs on the ambient request transaction when there is one
 * (`tenantContext` — so a return completion and its credit commit or roll back
 * together), and otherwise opens its own `withMoneyTx`. It never opens a
 * nested `$transaction` under a tenant context — see `hasTenantContext` in
 * packages/database/src/index.ts for why that is wrong on this codebase.
 */

export type WalletClient = Prisma.TransactionClient;

/** Largest single movement accepted: 1,000,000 EGP in piastres (a sanity bound, well inside int32). */
export const WALLET_MAX_ENTRY_FILS = 100_000_000;

export interface ApplyEntryInput {
  storeId: string;
  customerId: string;
  /** Signed piastres. Positive credits the wallet, negative spends it. Never 0. */
  amount: number;
  type: WalletTransactionType;
  /** Makes the write idempotent. Unique per store. */
  idempotencyKey: string;
  orderId?: string | null;
  returnId?: string | null;
  actorId?: string | null;
  note?: string | null;
}

const ENTRY_SELECT = {
  id: true,
  storeId: true,
  walletId: true,
  customerId: true,
  amount: true,
  balanceAfter: true,
  type: true,
  orderId: true,
  returnId: true,
  idempotencyKey: true,
  actorId: true,
  note: true,
  createdAt: true,
} as const satisfies Prisma.WalletTransactionSelect;

export type WalletEntry = Prisma.WalletTransactionGetPayload<{ select: typeof ENTRY_SELECT }>;

export interface ApplyEntryResult {
  entry: WalletEntry;
  /** Wallet balance after this call (unchanged on a replay). */
  balance: number;
  /** True when the idempotency key had already been applied — no money moved. */
  replayed: boolean;
}

async function onClient<T>(
  client: WalletClient | undefined,
  fn: (c: WalletClient) => Promise<T>
): Promise<T> {
  if (client) return fn(client);
  if (hasTenantContext()) return fn(prisma as unknown as WalletClient);
  return withMoneyTx(prisma, fn);
}

/**
 * Prisma `where` for "this user is a customer of this store". Customer
 * accounts are store-scoped (`users.store_id`). Never matches an admin/staff
 * row, and never matches another store's shopper.
 */
export function storeCustomerWhere(storeId: string, customerId: string): Prisma.UserWhereInput {
  return {
    id: customerId,
    role: 'customer',
    // Top-level `storeId` (the tenant guard refuses an `OR`). A legacy customer row with
    // `store_id` NULL is invisible from any store scope under RLS, so it never matched here.
    storeId,
  };
}

function assertValidInput(input: ApplyEntryInput): void {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new AppError(
      400,
      'INVALID_WALLET_AMOUNT',
      'Amount must be a non-zero whole number of piastres'
    );
  }
  if (Math.abs(input.amount) > WALLET_MAX_ENTRY_FILS) {
    throw new AppError(400, 'INVALID_WALLET_AMOUNT', 'Amount exceeds the maximum single movement');
  }
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'A wallet write needs an idempotency key');
  }
}

/**
 * The note the erasure forfeit itself writes. System text, no PII — excluded
 * from the erasure's own note scrub so a re-run does not find "a note to
 * scrub" it wrote last time and append another audit row (PR 2279 audit).
 */
const ERASURE_FORFEIT_NOTE = 'Forfeited on account erasure';

/** The `expire` entry `forfeitOnErasure` writes — and only that one (issue 2126). */
export function isErasureWriteOff(t: { type: string; note: string | null }): boolean {
  return t.type === 'expire' && t.note === ERASURE_FORFEIT_NOTE;
}

export class WalletService {
  /**
   * Apply one signed ledger entry. See the file header for the locking and
   * idempotency contract. Throws `INSUFFICIENT_WALLET_BALANCE` (409) when the
   * entry would take the balance below zero, and `IDEMPOTENCY_KEY_REUSED`
   * (409) when the key was already used for a DIFFERENT movement.
   */
  static async applyEntry(
    input: ApplyEntryInput,
    client?: WalletClient
  ): Promise<ApplyEntryResult> {
    assertValidInput(input);
    const { storeId, customerId, amount, idempotencyKey } = input;

    // Store on its Durable Object (Ruling WALLET-GL-1 / CF-MONEY-1): ledger row, balance and GL half in one section.
    // Inside a Postgres transaction too (Ruling WALLET-DO-TX-2): every caller keys the movement on the entity it belongs to
    // (`admin-adjust:<request key>`, `order-payment:<order>`, `erasure-forfeit:<wallet>:<position>`), so a request that
    // rolls back after the DO write and is retried REPLAYS the same entry instead of crediting again. The one caller whose
    // retry used to mint a fresh key, the return completion with a store-credit refund, no longer reaches this method for a
    // DO store: `returnFinish` writes the credit in the same DO section as the completion (Ruling CF-RETURNS-1).
    {
      const money = await storeMoney(storeId);
      if (money) {
        const r = await money.walletEntry({
          customerId,
          amount,
          type: input.type,
          idempotencyKey,
          orderId: input.orderId ?? null,
          returnId: input.returnId ?? null,
          actorId: input.actorId ?? null,
          note: input.note ?? null,
        });
        const e = r.entry as Record<string, any>;
        return {
          entry: {
            id: e.id,
            storeId: e.store_id,
            walletId: e.wallet_id,
            customerId: e.customer_id,
            amount: e.amount,
            balanceAfter: e.balance_after,
            type: e.type,
            orderId: e.order_id ?? null,
            returnId: e.return_id ?? null,
            idempotencyKey: e.idempotency_key,
            actorId: input.actorId ?? e.actor_id ?? null,
            note: e.note ?? null,
            createdAt: new Date(e.created_at),
          } as WalletEntry,
          balance: r.balance,
          replayed: r.replayed,
        };
      }
    }

    return onClient(client, async c => {
      if (amount > 0) {
        const existing = await c.customerWallet.findUnique({
          where: { storeId_customerId: { storeId, customerId } },
          select: { id: true },
        });
        if (!existing) {
          // First credit creates the wallet. The customer must be a customer
          // account OF THIS STORE — customer accounts are store-scoped users,
          // and a store must never be able to mint a wallet row against
          // another store's shopper.
          const customer = await c.user.findFirst({
            where: storeCustomerWhere(storeId, customerId),
            select: { id: true },
          });
          if (!customer) {
            throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found in this store');
          }
          // ON CONFLICT DO NOTHING, not a Prisma create: a concurrent first
          // credit must not raise a unique violation, which would abort the
          // whole request transaction (25P02) rather than just this insert.
          const now = new Date();
          await c.$executeRaw`
            INSERT INTO public.customer_wallets (id, store_id, customer_id, balance, created_at, updated_at)
            VALUES (${crypto.randomUUID()}, ${storeId}, ${customerId}, 0, ${now}, ${now})
            ON CONFLICT (store_id, customer_id) DO NOTHING`;
        }
      }

      // The lock. Everything below runs with this wallet serialised.
      const locked = await c.$queryRaw<Array<{ id: string; balance: number }>>`
        SELECT id, balance FROM public.customer_wallets
        WHERE store_id = ${storeId} AND customer_id = ${customerId}
        FOR UPDATE`;
      const wallet = locked[0];

      // Idempotency — checked UNDER the lock, so a second delivery of the same
      // key that raced the first sees the first's committed row here.
      const prior = await c.walletTransaction.findUnique({
        where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
        select: ENTRY_SELECT,
      });
      if (prior) {
        if (
          prior.customerId !== customerId ||
          prior.amount !== amount ||
          prior.type !== input.type
        ) {
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key was already used for a different wallet movement'
          );
        }
        return { entry: prior, balance: wallet?.balance ?? prior.balanceAfter, replayed: true };
      }

      const balance = wallet?.balance ?? 0;
      const newBalance = balance + amount;
      if (!wallet || newBalance < 0) {
        throw new AppError(
          409,
          'INSUFFICIENT_WALLET_BALANCE',
          'The wallet balance is not enough for this amount',
          { balance, requested: -amount }
        );
      }

      const entry = await c.walletTransaction.create({
        data: {
          storeId,
          walletId: wallet.id,
          customerId,
          amount,
          balanceAfter: newBalance,
          type: input.type,
          orderId: input.orderId ?? null,
          returnId: input.returnId ?? null,
          idempotencyKey,
          actorId: input.actorId ?? null,
          note: input.note ?? null,
        },
        select: ENTRY_SELECT,
      });
      await c.customerWallet.update({
        where: { id: wallet.id, storeId },
        data: { balance: newBalance },
      });
      // Ruling WALLET-GL-1: the GL movement commits or rolls back with the wallet row it
      // mirrors (same transaction), so 2150 cannot drift from the balances. Replays returned
      // above and never reach here.
      await postWalletMovementJournal({ entry, tx: c });

      return { entry, balance: newBalance, replayed: false };
    });
  }

  // ==========================================
  // Reads
  // ==========================================

  static async getBalance(storeId: string, customerId: string): Promise<number> {
    const wallet = await prisma.customerWallet.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
      select: { balance: true },
    });
    return wallet?.balance ?? 0;
  }

  /** Customer ledger, newest first, cursor-paginated on the entry id. */
  static async listTransactions(
    storeId: string,
    customerId: string,
    options: { cursor?: string; limit?: number } = {}
  ) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const rows = await prisma.walletTransaction.findMany({
      where: { storeId, customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      select: {
        ...ENTRY_SELECT,
        order: { select: { id: true, orderNumber: true } },
        return: { select: { id: true, returnNumber: true } },
      },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      // `erasureWriteOff` (owner decision 2026-10-01, issue 2126): the balance
      // written off because the customer deleted their account. The merchant
      // sees one narrow line for it on this history — not the audit log.
      transactions: page.map(t => ({
        ...t,
        erasureWriteOff: isErasureWriteOff(t),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** Store wallet page: customers holding a balance, largest first. */
  static async listWallets(storeId: string, options: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const [rows, summary] = await Promise.all([
      prisma.customerWallet.findMany({
        where: { storeId, balance: { gt: 0 } },
        orderBy: [{ balance: 'desc' }, { id: 'asc' }],
        take: limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          customerId: true,
          balance: true,
          updatedAt: true,
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
      }),
      prisma.customerWallet.aggregate({
        where: { storeId, balance: { gt: 0 } },
        _sum: { balance: true },
        _count: { _all: true },
      }),
    ]);
    const hasMore = rows.length > limit;
    const wallets = hasMore ? rows.slice(0, limit) : rows;
    return {
      wallets,
      nextCursor: hasMore ? wallets[wallets.length - 1].id : null,
      summary: {
        outstandingTotal: summary._sum.balance ?? 0,
        walletsWithBalance: summary._count._all,
      },
    };
  }

  /**
   * Whether customers of this store can spend their wallet at checkout, and
   * if not, why. Both feature keys must be on. Accounting no longer matters:
   * every movement is journaled on 2150 (Ruling WALLET-GL-1, which retired the
   * W-3 refusal).
   */
  static async getCheckoutAvailability(storeId: string): Promise<{
    available: boolean;
    reason: 'feature_off' | 'checkout_feature_off' | null;
  }> {
    const [walletOn, checkoutOn] = await Promise.all([
      featureService.isFeatureEnabled(storeId, 'customer_wallet'),
      featureService.isFeatureEnabled(storeId, 'customer_wallet_checkout'),
    ]);
    if (!walletOn) return { available: false, reason: 'feature_off' };
    if (!checkoutOn) return { available: false, reason: 'checkout_feature_off' };
    return { available: true, reason: null };
  }

  // ==========================================
  // Write paths
  // ==========================================

  /** Merchant manual credit (+) or debit (−). Note is required at the API. */
  static async adminAdjust(
    args: {
      storeId: string;
      customerId: string;
      amount: number;
      note: string;
      actorId: string;
      requestKey: string;
    },
    client?: WalletClient
  ): Promise<ApplyEntryResult> {
    return this.applyEntry(
      {
        storeId: args.storeId,
        customerId: args.customerId,
        amount: args.amount,
        type: 'admin_adjust',
        idempotencyKey: `admin-adjust:${args.requestKey}`,
        actorId: args.actorId,
        note: args.note,
      },
      client
    );
  }

  /** A return completed with the `store_credit` refund method. */
  static async creditForReturn(
    args: {
      storeId: string;
      customerId: string;
      returnId: string;
      orderId: string;
      amount: number;
    },
    client?: WalletClient
  ): Promise<ApplyEntryResult> {
    return this.applyEntry(
      {
        storeId: args.storeId,
        customerId: args.customerId,
        amount: args.amount,
        type: 'refund_credit',
        idempotencyKey: `return-credit:${args.returnId}`,
        orderId: args.orderId,
        returnId: args.returnId,
      },
      client
    );
  }

  /**
   * The wallet's part of a gateway refund on an order paid partly from the
   * wallet (owner decision 2026-10-01, #1956): the refund goes back the way the
   * order was paid, pro-rata, and this is the wallet half. Its own key, so it
   * can never replay into a store-credit completion of the same return.
   */
  static async creditReturnWalletShare(
    args: {
      storeId: string;
      customerId: string;
      returnId: string;
      orderId: string;
      amount: number;
    },
    client?: WalletClient
  ): Promise<ApplyEntryResult> {
    return this.applyEntry(
      {
        storeId: args.storeId,
        customerId: args.customerId,
        amount: args.amount,
        type: 'refund_credit',
        idempotencyKey: returnWalletShareKey(args.returnId),
        orderId: args.orderId,
        returnId: args.returnId,
      },
      client
    );
  }

  /** Spend at checkout, inside the order-create transaction. */
  static async debitForOrder(
    args: { storeId: string; customerId: string; orderId: string; amount: number },
    client: WalletClient
  ): Promise<ApplyEntryResult> {
    return this.applyEntry(
      {
        storeId: args.storeId,
        customerId: args.customerId,
        amount: -args.amount,
        type: 'order_payment',
        idempotencyKey: `order-payment:${args.orderId}`,
        orderId: args.orderId,
      },
      client
    );
  }

  /**
   * Put an order's checkout wallet spend back, exactly once. Reads the
   * original `order_payment` entry (NOT `Order.walletAmount`/`customerId`,
   * which erasure may have nulled) so the credit lands on the wallet that
   * paid. No-op (null) when the order never spent from a wallet, or when
   * partial gateway returns already gave every piastres of it back.
   */
  static async reverseOrderPayment(
    args: { storeId: string; orderId: string },
    client?: WalletClient
  ): Promise<ApplyEntryResult | null> {
    return onClient(client, async c => {
      const spend = await c.walletTransaction.findFirst({
        where: { storeId: args.storeId, orderId: args.orderId, type: 'order_payment' },
        select: { customerId: true, amount: true },
      });
      if (!spend || spend.amount >= 0) return null;
      // Partial returns refunded through the gateway already put the wallet's
      // pro-rata share of their lines back (creditReturnWalletShare, #1956).
      // The whole-order reversal returns only what is left of the spend, or
      // the customer would get those shares twice.
      const alreadyReturned = await c.walletTransaction.aggregate({
        where: {
          storeId: args.storeId,
          orderId: args.orderId,
          type: 'refund_credit',
          idempotencyKey: { startsWith: RETURN_WALLET_SHARE_KEY_PREFIX },
        },
        _sum: { amount: true },
      });
      const remaining = -spend.amount - (alreadyReturned._sum.amount ?? 0);
      if (remaining <= 0) return null;
      return this.applyEntry(
        {
          storeId: args.storeId,
          customerId: spend.customerId,
          amount: remaining,
          type: 'order_payment_reversal',
          idempotencyKey: `order-payment-reversal:${args.orderId}`,
          orderId: args.orderId,
        },
        c
      );
    });
  }

  /**
   * Erasure (Ruling W-4): the ledger is a financial record and is KEPT, but
   * its only free-text field is scrubbed, and any remaining balance is
   * written off with an `expire` entry — the account can no longer sign in to
   * spend it, and leaving it would overstate the merchant's liability forever.
   * Runs on the erasure transaction so it commits or rolls back with it.
   *
   * SCOPE (owner decision 2026-09-26, Ruling W-7): a store deletes ONLY its
   * own data.
   *   - `scope.storeId` set (merchant-initiated erase): only THAT store's
   *     wallet and ledger rows are touched. The ambient tenant GUC already names
   *     that store, and the explicit `storeId` filter keeps it true on an
   *     owner-role connection too.
   *   - `scope.storeId` null (the shopper's own account erasure, the retention
   *     cron): every wallet the customer holds that the transaction can see.
   *     The erasure runs under the shopper's own store scope (a customer
   *     account belongs to exactly one store), and each store whose balance
   *     this run forfeited gets its OWN `audit_logs` row naming the actor,
   *     written through the append-only audit definer. A store with nothing to
   *     forfeit, or a re-run, writes no row. NOTE (issue 2126): the only
   *     audit-log viewer is the super-admin `/audit-logs` page, so today that
   *     row explains the change to the PLATFORM, not to the store — no
   *     merchant-facing surface shows it (the wallet drops off the store's
   *     wallet list at 0 balance). Whether store_admins get a store-scoped
   *     audit view is an open owner question; see Ruling W-7.
   * The `expire` entries carry `scope.actorId` (a user id, or 'system').
   */
  static async forfeitOnErasure(
    customerId: string,
    client: WalletClient,
    scope: { storeId: string | null; actorId: string }
  ): Promise<void> {
    const storeFilter = { storeId: scope.storeId ?? currentStoreId() };
    const run = async () => {
      // Which stores' ledgers this run is about to scrub (PR 2279 audit): a
      // store whose balance was 0 still has merchant-authored notes nulled,
      // and must see why. A re-run finds no non-null note and adds nothing.
      const scrubbedRows = await client.walletTransaction.findMany({
        where: {
          customerId,
          ...storeFilter,
          note: { not: null },
          NOT: { note: ERASURE_FORFEIT_NOTE },
        },
        select: { storeId: true },
        distinct: ['storeId'],
      });
      const notesScrubbedStores = new Set(scrubbedRows.map(r => r.storeId));
      await client.walletTransaction.updateMany({
        where: {
          customerId,
          ...storeFilter,
          note: { not: null },
          NOT: { note: ERASURE_FORFEIT_NOTE },
        },
        data: { note: null },
      });
      const wallets = await client.customerWallet.findMany({
        where: { customerId, ...storeFilter },
        select: { id: true, storeId: true, balance: true },
      });
      const forfeited = new Map<string, number>();
      for (const w of wallets.filter(x => x.balance > 0)) {
        // Keyed to the ledger position being zeroed, not just the wallet: a
        // re-run of an erasure (it is documented as idempotent) that finds a
        // balance again — e.g. an order reversal credited after the first run —
        // must write a NEW forfeit, not trip IDEMPOTENCY_KEY_REUSED on the old
        // key and fail the whole erasure. A plain re-run finds balance 0 and
        // never reaches here.
        const latest = await client.walletTransaction.findFirst({
          where: { storeId: w.storeId, walletId: w.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        const result = await this.applyEntry(
          {
            storeId: w.storeId,
            customerId,
            amount: -w.balance,
            type: 'expire',
            idempotencyKey: `erasure-forfeit:${w.id}:${latest?.id ?? 'none'}`,
            note: ERASURE_FORFEIT_NOTE,
            actorId: scope.actorId,
          },
          client
        );
        // Only money THIS run moved counts as forfeited: a replayed entry was
        // already written (and audited) by the run that created it (issue 2122).
        if (!result.replayed) {
          forfeited.set(w.storeId, (forfeited.get(w.storeId) ?? 0) + w.balance);
        }
        logger.info(
          { storeId: w.storeId, walletId: w.id, forfeited: w.balance, replayed: result.replayed },
          '[WalletService] balance forfeited on account erasure'
        );
      }
      return { forfeited, notesScrubbedStores };
    };

    if (scope.storeId) {
      await run();
      return;
    }

    {
      const { forfeited, notesScrubbedStores } = await run();
      // One row per store whose liability THIS run changed, written with THAT
      // store's id (issues 2122 / 2125). Driven by `forfeited`, not by every
      // wallet: a zero-balance store's liability did not change, and a re-run
      // of an already-erased account (retention cron retries, a double-submit)
      // finds every balance at 0 and writes nothing — the erasure stays
      // idempotent for the audit trail as well as for the ledger.
      const actorIsUser = scope.actorId !== 'system';
      const touched = new Set<string>([...forfeited.keys(), ...notesScrubbedStores]);
      for (const storeId of touched) {
        const forfeitedFils = forfeited.get(storeId) ?? 0;
        // Through the append-only audit definer: the row carries ITS store's id,
        // which may differ from the transaction's store scope.
        await insertAuditLog({
          action: 'customer.wallet.erased',
          userId: actorIsUser ? scope.actorId : null,
          storeId,
          resourceType: 'user',
          resourceId: customerId,
          details: {
            actor: scope.actorId,
            reason: 'account_erasure',
            forfeitedFils,
            notesScrubbed: notesScrubbedStores.has(storeId),
          },
        });
      }
    }
  }
}
