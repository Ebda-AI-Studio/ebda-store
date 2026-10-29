import { MoneyError, type SyncSql } from './sync-sql';

/**
 * General ledger on the StoreDO (INFRA-CF-1 PR D2b-3, Ruling CF-LEDGER-1). Port of
 * apps/api/src/services/accounting/journal.service.ts (`postEntry`, `reverseEntry`), `sequence.service.ts` (`nextSequence`)
 * and `posting/order-posting.ts` + `posting/refund-posting.ts`. Pure synchronous functions over `SyncSql`; every query is
 * scoped by `store_id`; integers only (piastres).
 *
 * Idempotency is in the data: `(store_id, source, source_id)` is the entry's identity (the same partial unique index the
 * Postgres twin has), so a replay returns the existing entry and posts nothing. A reversal is keyed `<sourceId>:reversal`
 * and marks the original `reversed`; reversing twice is a no-op.
 *
 * Differences kept on purpose, each stated in CF-LEDGER-1:
 *   - a missing system account is `ACCOUNT_NOT_FOUND` (409), not self-healed from `COA_TEMPLATE` (the template lives in the
 *     API package; the import carries the store's accounts across);
 *   - the wallet tender is journaled as in Ruling WALLET-GL-1: DR 2150 for `wallet_amount`, DR cash for the rest; wallet
 *     movements (`postWalletMovementJournal`) self-heal 2150 / 4100 / 5950 like the Postgres twin;
 *   - partial-return adjustments (`postPartialReturnJournal`) are NOT ported: the Worker refuses them for a DO store (501).
 */

export const PROVIDER_TO_CASH_CODE: Record<string, string> = {
  paymob: '1000',
  kashier: '1010',
  fawry: '1000',
  geidea: '1010',
  cod: '1020',
  instapay: '1000',
};

export interface JournalLine {
  accountId: string;
  debit: number;
  credit: number;
  lineMemo?: string;
  refTable?: string;
  refId?: string;
}
export interface JournalEntryRow {
  id: string;
  entryNumber: string;
  status: string;
}

const err = (code: string, message: string, status = 409) => new MoneyError(code, message, status);

/** `JE-<year>-<6 digits>`: one statement claims the number, like the Postgres upsert. */
export function nextJournalNumber(db: SyncSql, storeId: string, now: number): string {
  db.run(
    `INSERT INTO sequences (store_id, kind, next, updated_at) VALUES (?1, 'journal', 2, ?2)
     ON CONFLICT (store_id, kind) DO UPDATE SET next = sequences.next + 1, updated_at = ?2`,
    [storeId, now]
  );
  const n = db.all("SELECT next - 1 AS n FROM sequences WHERE store_id = ? AND kind = 'journal'", [
    storeId,
  ])[0].n as number;
  return `JE-${new Date(now).getUTCFullYear()}-${String(n).padStart(6, '0')}`;
}

export function systemAccountId(db: SyncSql, storeId: string, code: string): string {
  const r = db.all('SELECT id FROM accounts WHERE store_id = ? AND code = ?', [storeId, code])[0];
  if (!r)
    throw err(
      'ACCOUNT_NOT_FOUND',
      `System account ${code} not found for this store - seed the chart of accounts`
    );
  return r.id as string;
}

/** Idempotent post. Validates DR = CR and at least one line. */
export function postEntry(
  db: SyncSql,
  a: {
    storeId: string;
    source: string;
    sourceId?: string;
    memo?: string;
    memoAr?: string;
    postedAt?: number;
    lines: JournalLine[];
    now?: number;
  }
): { entry: JournalEntryRow; created: boolean } {
  const now = a.now ?? Date.now();
  if (a.lines.length === 0)
    throw err('JOURNAL_EMPTY', 'Journal entry requires at least one line', 400);
  for (const l of a.lines)
    if (
      !Number.isSafeInteger(l.debit) ||
      !Number.isSafeInteger(l.credit) ||
      l.debit < 0 ||
      l.credit < 0
    )
      throw err('JOURNAL_BAD_AMOUNT', 'journal amounts are non-negative integers of piastres', 400);
  const dr = a.lines.reduce((s, l) => s + l.debit, 0);
  const cr = a.lines.reduce((s, l) => s + l.credit, 0);
  if (dr !== cr)
    throw err('JOURNAL_UNBALANCED', `Journal lines unbalanced: DR=${dr} CR=${cr}`, 400);
  return db.transactionSync(() => {
    if (a.sourceId) {
      const have = db.all(
        'SELECT id, entry_number, status FROM journal_entries WHERE store_id = ? AND source = ? AND source_id = ?',
        [a.storeId, a.source, a.sourceId]
      )[0];
      if (have)
        return {
          entry: {
            id: have.id as string,
            entryNumber: have.entry_number as string,
            status: have.status as string,
          },
          created: false,
        };
    }
    const id = crypto.randomUUID();
    const entryNumber = nextJournalNumber(db, a.storeId, now);
    db.run(
      `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, memo, memo_ar, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?)`,
      [
        id,
        a.storeId,
        entryNumber,
        a.postedAt ?? now,
        a.source,
        a.sourceId ?? null,
        a.memo ?? null,
        a.memoAr ?? null,
        now,
      ]
    );
    for (const l of a.lines)
      db.run(
        `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, line_memo, ref_table, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          l.accountId,
          l.debit,
          l.credit,
          l.lineMemo ?? null,
          l.refTable ?? null,
          l.refId ?? null,
          now,
        ]
      );
    return { entry: { id, entryNumber, status: 'posted' }, created: true };
  });
}

/** Mirror an entry (debits become credits) and mark the original `reversed`. Reversing an already reversed entry is a no-op. */
export function reverseEntry(
  db: SyncSql,
  a: { storeId: string; entryId: string; reason?: string; now?: number }
): { reversed: boolean; reversalId: string | null } {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const o = db.all(
      'SELECT id, entry_number, source, source_id, status FROM journal_entries WHERE id = ? AND store_id = ?',
      [a.entryId, a.storeId]
    )[0];
    if (!o) throw err('JOURNAL_NOT_FOUND', `JournalEntry ${a.entryId} not found`, 404);
    if (o.status === 'reversed') return { reversed: false, reversalId: null };
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, memo, memo_ar, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?)`,
      [
        id,
        a.storeId,
        nextJournalNumber(db, a.storeId, now),
        now,
        o.source,
        o.source_id ? `${o.source_id as string}:reversal` : null,
        a.reason ?? `Reversal of ${o.entry_number as string}`,
        a.reason ?? `إلغاء قيد ${o.entry_number as string}`,
        now,
      ]
    );
    for (const l of db.all(
      'SELECT account_id, debit, credit, line_memo, line_memo_ar, ref_table, ref_id FROM journal_lines WHERE entry_id = ?',
      [a.entryId]
    ))
      db.run(
        `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, line_memo, line_memo_ar, ref_table, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          l.account_id,
          l.credit,
          l.debit,
          l.line_memo,
          l.line_memo_ar,
          l.ref_table,
          l.ref_id,
          now,
        ]
      );
    db.run(
      "UPDATE journal_entries SET status = 'reversed', reversed_by_id = ? WHERE id = ? AND store_id = ?",
      [id, a.entryId, a.storeId]
    );
    return { reversed: true, reversalId: id };
  });
}

/**
 * The GL for an order that is paid: the sale entry (`sourceId = orderId`) and the COGS entry (`<orderId>:cogs`).
 * Returns why nothing was posted instead of throwing for a state the Postgres twin skips quietly.
 */
export function postOrderSaleJournal(
  db: SyncSql,
  a: { storeId: string; orderId: string; now?: number }
): { posted: boolean; skipped?: string; entries: number } {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const o = db.all(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.subtotal, o.discount, o.tax, o.shipping, o.total,
              o.tax_included_in_price, o.wallet_amount, o.coupon_code, pr.name AS promotion_name
         FROM orders o LEFT JOIN promotions pr ON pr.id = o.applied_promotion_id AND pr.store_id = o.store_id
        WHERE o.id = ? AND o.store_id = ? AND o.deleted_at IS NULL`,
      [a.orderId, a.storeId]
    )[0];
    if (!o) return { posted: false, skipped: 'order_not_found', entries: 0 };
    if (o.payment_status !== 'paid') return { posted: false, skipped: 'not_paid', entries: 0 };
    if (o.status === 'cancelled' || o.status === 'refunded')
      return { posted: false, skipped: 'order_reversed', entries: 0 };
    const cfg = db.all('SELECT accounting_enabled FROM store_config WHERE store_id = ?', [
      a.storeId,
    ])[0];
    if (!cfg || !cfg.accounting_enabled)
      return { posted: false, skipped: 'accounting_disabled', entries: 0 };

    const provider =
      (db.all(
        "SELECT provider FROM payments WHERE order_id = ? AND status = 'completed' ORDER BY created_at LIMIT 1",
        [a.orderId]
      )[0]?.provider as string | undefined) ?? 'cod';
    const cash = systemAccountId(db, a.storeId, PROVIDER_TO_CASH_CODE[provider] ?? '1000');
    const revenue = systemAccountId(db, a.storeId, '4000');
    const taxPayable = systemAccountId(db, a.storeId, '2100');
    const shippingIncome = systemAccountId(db, a.storeId, '4010');
    const cogsAcc = systemAccountId(db, a.storeId, '5000');
    const inventoryAcc = systemAccountId(db, a.storeId, '1200');

    const total = o.total as number;
    const tax = o.tax as number;
    const wallet = (o.wallet_amount as number) ?? 0;
    const netRevenue =
      (o.subtotal as number) - (o.discount as number) - (o.tax_included_in_price ? tax : 0);
    const lever = o.coupon_code
      ? `coupon ${o.coupon_code as string}`
      : o.promotion_name
        ? `promotion "${o.promotion_name as string}"`
        : null;
    const ref = { refTable: 'orders', refId: o.id as string };
    const lines: JournalLine[] = [];
    // WALLET-GL-1: the wallet part is a tender like the others; no zero-value cash line for a wallet-only order
    if (wallet > 0)
      lines.push({
        accountId: systemAccountId(db, a.storeId, '2150'),
        debit: wallet,
        credit: 0,
        lineMemo: `Order ${o.order_number as string} paid with store credit`,
        ...ref,
      });
    if (total - wallet > 0)
      lines.push({
        accountId: cash,
        debit: total - wallet,
        credit: 0,
        lineMemo: `Order ${o.order_number as string} payment`,
        ...ref,
      });
    if (netRevenue > 0)
      lines.push({
        accountId: revenue,
        debit: 0,
        credit: netRevenue,
        lineMemo:
          (o.discount as number) > 0 && lever
            ? `Sales revenue (net of discount — ${lever})`
            : 'Sales revenue (net of discount)',
        ...ref,
      });
    if (tax > 0)
      lines.push({
        accountId: taxPayable,
        debit: 0,
        credit: tax,
        lineMemo: 'Tax collected',
        ...ref,
      });
    if ((o.shipping as number) > 0)
      lines.push({
        accountId: shippingIncome,
        debit: 0,
        credit: o.shipping as number,
        lineMemo: 'Shipping fee',
        ...ref,
      });
    let entries = 0;
    if (
      postEntry(db, {
        storeId: a.storeId,
        source: 'order',
        sourceId: o.id as string,
        memo: `Sale — Order ${o.order_number as string}`,
        memoAr: `بيع — طلب ${o.order_number as string}`,
        lines,
        now,
      }).created
    )
      entries++;

    let totalCogs = 0;
    const cogsLines: JournalLine[] = [];
    for (const it of db.all(
      'SELECT id, product_name, quantity, cost_price FROM order_items WHERE order_id = ? ORDER BY id',
      [a.orderId]
    )) {
      const cost = it.cost_price as number | null;
      if (!cost || cost <= 0) continue;
      const c = cost * (it.quantity as number);
      totalCogs += c;
      cogsLines.push(
        {
          accountId: cogsAcc,
          debit: c,
          credit: 0,
          lineMemo: `COGS — ${it.product_name as string} × ${it.quantity as number}`,
          refTable: 'order_items',
          refId: it.id as string,
        },
        {
          accountId: inventoryAcc,
          debit: 0,
          credit: c,
          lineMemo: `Inventory out — ${it.product_name as string} × ${it.quantity as number}`,
          refTable: 'order_items',
          refId: it.id as string,
        }
      );
    }
    if (
      totalCogs > 0 &&
      postEntry(db, {
        storeId: a.storeId,
        source: 'order',
        sourceId: `${o.id as string}:cogs`,
        memo: `COGS — Order ${o.order_number as string}`,
        memoAr: `تكلفة البضاعة — طلب ${o.order_number as string}`,
        lines: cogsLines,
        now,
      }).created
    )
      entries++;
    return { posted: true, entries };
  });
}

/** Reverse the sale, the COGS and any partial-return adjustment entries of an order (postRefundJournal). Idempotent. */
export function postRefundJournal(
  db: SyncSql,
  a: { storeId: string; orderId: string; reason?: string; now?: number }
): { reversed: number } {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    let reversed = 0;
    for (const e of db.all(
      `SELECT id, status FROM journal_entries
        WHERE store_id = ?1 AND source = 'order'
          AND (source_id IN (?2, ?3) OR (source_id LIKE ?4 AND source_id NOT LIKE '%:reversal'))
        ORDER BY created_at, id`,
      [a.storeId, a.orderId, `${a.orderId}:cogs`, `${a.orderId}:partial:%`]
    )) {
      if (e.status === 'reversed') continue;
      if (
        reverseEntry(db, {
          storeId: a.storeId,
          entryId: e.id as string,
          reason: a.reason ?? 'refund applied',
          now,
        }).reversed
      )
        reversed++;
    }
    return { reversed };
  });
}

export interface TrialBalanceRow {
  code: string;
  debit: number;
  credit: number;
}
/** Per-account debit / credit totals over the POSTED lines (a reversed entry and its mirror both count: they net to zero). */
export function trialBalance(
  db: SyncSql,
  storeId: string
): { rows: TrialBalanceRow[]; debit: number; credit: number; balanced: boolean } {
  const rows = db
    .all(
      `SELECT a.code AS code, COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.store_id = ?1
         JOIN accounts a ON a.id = l.account_id AND a.store_id = ?1
        GROUP BY a.code ORDER BY a.code`,
      [storeId]
    )
    .map(r => ({ code: r.code as string, debit: r.debit as number, credit: r.credit as number }));
  const debit = rows.reduce((s, r) => s + r.debit, 0);
  const credit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, debit, credit, balanced: debit === credit };
}

// ---------------------------------------------------------------- wallet movements (Ruling WALLET-GL-1, port of posting/wallet-posting.ts)

/** Chart rows the Postgres twin self-heals from COA_TEMPLATE (`getSystemAccountIdByCode`); the DO keeps only the ones a wallet movement can need. */
const HEALABLE_ACCOUNTS: Record<string, { nameEn: string; nameAr: string; type: string }> = {
  '2150': {
    nameEn: 'Customer Wallet Liability',
    nameAr: 'التزامات رصيد العملاء',
    type: 'liability',
  },
  '4100': { nameEn: 'Unused Store Credit', nameAr: 'رصيد متجر غير مستخدم', type: 'revenue' },
  '5950': { nameEn: 'Customer Goodwill', nameAr: 'مجاملة العملاء', type: 'expense' },
};

function walletAccountId(db: SyncSql, storeId: string, code: string, now: number): string {
  const h = HEALABLE_ACCOUNTS[code];
  if (h)
    db.run(
      `INSERT INTO accounts (id, store_id, code, name_en, name_ar, type, is_system, is_active, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7, ?7) ON CONFLICT (store_id, code) DO NOTHING`,
      [crypto.randomUUID(), storeId, code, h.nameEn, h.nameAr, h.type, now]
    );
  return systemAccountId(db, storeId, code);
}

/**
 * The GL half of one wallet ledger row, called by `applyWalletEntry` in the same section that wrote it. `admin_adjust` /
 * `credit` / `debit` land on 5950 Customer Goodwill, `expire` on 4100 Unused Store Credit, always against 2150; the other
 * types are journaled by the posting that owns them (sale, refund, partial return) and are never booked twice here.
 * Idempotent per wallet row (`source 'manual'`, `sourceId wallet:<id>`); a store with accounting off posts nothing.
 */
export function postWalletMovementJournal(
  db: SyncSql,
  a: { storeId: string; entryId: string; type: string; amount: number; now?: number }
): { posted: boolean } {
  const now = a.now ?? Date.now();
  const kind =
    a.type === 'admin_adjust' || a.type === 'credit' || a.type === 'debit'
      ? 'goodwill'
      : a.type === 'expire'
        ? 'forfeit'
        : null;
  if (!kind || a.amount === 0) return { posted: false };
  const cfg = db.all('SELECT accounting_enabled FROM store_config WHERE store_id = ?', [
    a.storeId,
  ])[0];
  if (!cfg || !cfg.accounting_enabled) return { posted: false };
  const liability = walletAccountId(db, a.storeId, '2150', now);
  const abs = Math.abs(a.amount);
  const ref = { refTable: 'wallet_transactions', refId: a.entryId };
  if (kind === 'goodwill') {
    const expense = walletAccountId(db, a.storeId, '5950', now);
    const issued = a.amount > 0;
    postEntry(db, {
      storeId: a.storeId,
      source: 'manual',
      sourceId: `wallet:${a.entryId}`,
      memo: issued ? 'Store credit issued (goodwill)' : 'Store credit reversed (goodwill)',
      memoAr: issued ? 'رصيد متجر ممنوح (مجاملة)' : 'عكس رصيد متجر ممنوح (مجاملة)',
      lines: [
        { accountId: issued ? expense : liability, debit: abs, credit: 0, ...ref },
        { accountId: issued ? liability : expense, debit: 0, credit: abs, ...ref },
      ],
      now,
    });
    return { posted: true };
  }
  const income = walletAccountId(db, a.storeId, '4100', now);
  postEntry(db, {
    storeId: a.storeId,
    source: 'manual',
    sourceId: `wallet:${a.entryId}`,
    memo: 'Unused store credit written off',
    memoAr: 'رصيد متجر غير مستخدم تم شطبه',
    lines: [
      { accountId: liability, debit: abs, credit: 0, ...ref },
      { accountId: income, debit: 0, credit: abs, ...ref },
    ],
    now,
  });
  return { posted: true };
}
