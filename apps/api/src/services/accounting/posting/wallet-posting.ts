import type { Prisma } from '@prisma/client';
import { getSystemAccountIdByCode } from '../account.service';
import { postEntry } from '../journal.service';

/**
 * GL journal for customer-wallet (store credit) movements — Ruling WALLET-GL-1.
 *
 * Account 2150 "Customer Wallet Liability" must equal the sum of the customers'
 * wallet balances. Every ledger movement therefore lands in the GL exactly once,
 * in the same transaction that wrote the wallet row:
 *
 *   admin_adjust / credit  (+)  DR 5950 Customer Goodwill        CR 2150
 *   admin_adjust / debit   (-)  DR 2150                           CR 5950   (mirror of a credit)
 *   expire (forfeit, expiry,    DR 2150                           CR 4100 Unused Store Credit
 *           erasure write-off)
 *
 * NOT journaled here, because another posting already owns them (journaling them
 * again would double-book):
 *   - order_payment           redemption at checkout: postOrderPaymentJournal books
 *                              DR 2150 beside the cash legs when the order is PAID.
 *   - order_payment_reversal  the whole-order refund reverses that sale entry (the
 *                              mirror lines, 2150 included); a spend reversed before
 *                              the order was paid never reached the GL at all.
 *   - refund_credit           postPartialReturnJournal credits 2150 for it.
 *
 * Idempotent per wallet-ledger row: source 'manual', sourceId `wallet:<entry id>`.
 * Returns null when accounting is off for the store or the movement type is owned
 * elsewhere.
 */
export const WALLET_GOODWILL_EXPENSE_CODE = '5950';
export const WALLET_UNUSED_CREDIT_INCOME_CODE = '4100';
export const WALLET_LIABILITY_CODE = '2150';

export type WalletGlEntry = {
  id: string;
  storeId: string;
  type: string;
  /** Signed piastres, as stored on the wallet ledger row. */
  amount: number;
  note?: string | null;
};

export async function postWalletMovementJournal(args: {
  entry: WalletGlEntry;
  tx: Prisma.TransactionClient;
}): Promise<{ posted: boolean }> {
  const { entry, tx } = args;
  const kind =
    entry.type === 'admin_adjust' || entry.type === 'credit' || entry.type === 'debit'
      ? 'goodwill'
      : entry.type === 'expire'
        ? 'forfeit'
        : null;
  if (!kind || entry.amount === 0) return { posted: false };

  const store = await tx.store.findUnique({
    where: { id: entry.storeId },
    select: { accountingEnabled: true },
  });
  if (!store?.accountingEnabled) return { posted: false };

  const liabilityId = await getSystemAccountIdByCode(entry.storeId, WALLET_LIABILITY_CODE, tx);
  const abs = Math.abs(entry.amount);
  const ref = { refTable: 'wallet_transactions', refId: entry.id };

  if (kind === 'goodwill') {
    const expenseId = await getSystemAccountIdByCode(
      entry.storeId,
      WALLET_GOODWILL_EXPENSE_CODE,
      tx
    );
    const issued = entry.amount > 0;
    await postEntry({
      storeId: entry.storeId,
      source: 'manual',
      sourceId: `wallet:${entry.id}`,
      memo: issued ? 'Store credit issued (goodwill)' : 'Store credit reversed (goodwill)',
      memoAr: issued ? 'رصيد متجر ممنوح (مجاملة)' : 'عكس رصيد متجر ممنوح (مجاملة)',
      lines: [
        { accountId: issued ? expenseId : liabilityId, debit: abs, credit: 0, ...ref },
        { accountId: issued ? liabilityId : expenseId, debit: 0, credit: abs, ...ref },
      ],
      tx,
    });
    return { posted: true };
  }

  const incomeId = await getSystemAccountIdByCode(
    entry.storeId,
    WALLET_UNUSED_CREDIT_INCOME_CODE,
    tx
  );
  // A forfeit/expiry only ever shrinks a balance (amount < 0).
  await postEntry({
    storeId: entry.storeId,
    source: 'manual',
    sourceId: `wallet:${entry.id}`,
    memo: 'Unused store credit written off',
    memoAr: 'رصيد متجر غير مستخدم تم شطبه',
    lines: [
      { accountId: liabilityId, debit: abs, credit: 0, ...ref },
      { accountId: incomeId, debit: 0, credit: abs, ...ref },
    ],
    tx,
  });
  return { posted: true };
}
