import { currentStoreId } from '@ebda/database';
import { withScopedToOrderStore } from './order-scope';
import type { Prisma } from '@prisma/client';
import { getSystemAccountIdByCode } from '../account.service';
import { postEntry, type JournalLineInput } from '../journal.service';
import { PROVIDER_TO_CASH_CODE } from './order-posting';
import logger from '../../../lib/logger';
import { storeMoney } from '../../../lib/repo-factory';
import { allocatePartialReturn } from './partial-return-allocation';
import { loadPriorReversedQty } from './prior-reversed-qty';
import { isGatewayRefundMethod, RETURN_WALLET_SHARE_KEY_PREFIX } from '../../../lib/refund-methods';

export interface PartialReturnJournalArgs {
  orderId: string;
  /**
   * Idempotency key for this item-level reversal — the Return id (set by
   * ReturnService.complete) or `backorder:<lineId>` (set by cancelBackorder,
   * ruling AP-5). One adjustment entry set per refundKey; a redelivered event
   * no-ops. The Return row / backorder cancel marker it names also supplies
   * the memo's merchant-entered reason.
   */
  refundKey: string;
  items: Array<{ orderItemId: string; quantity: number }>;
  /**
   * The event's storeId, when the caller has one. Cross-checked against the
   * order row: this function runs under withRlsBypass, so RLS provides no
   * backstop if a hand-crafted or replayed event carries a mismatched
   * (orderId, storeId) pair — a mismatch is refused, never re-scoped.
   */
  storeId?: string;
  tx?: Prisma.TransactionClient;
}

/**
 * Post the pro-rata GL adjustment for a PARTIAL return.
 *
 * A full refund mirrors the whole sale journal (see refund-posting). A
 * partial return must reverse ONLY the returned lines, so instead of
 * reversing the originals this posts new adjustment entries that mirror the
 * original entries' account selection and sign conventions:
 *
 *   1. Revenue adjustment  (sourceId = `${orderId}:partial:${refundKey}`)
 *      DR Sales Revenue   returned gross − pro-rata discount share
 *      DR Tax Payable     pro-rata tax share
 *      CR Cash[provider]  sum of the above
 *      For a completed RETURN the credit follows the refund method and the
 *      amount actually refunded (resolveReturnRefundLegs, owner decision
 *      2026-10-01): card/gateway → the sale's cash account, wallet → 2150,
 *      off-platform store credit → 2160; the sales-return debit is that
 *      amount net of the pro-rata tax share.
 *      (Shipping Income is NOT reversed — the order shipped and the customer
 *      kept part of it; a whole-order cancel goes down the full-reversal
 *      path, which does reverse it.)
 *
 *   2. COGS adjustment     (sourceId = `${orderId}:partial:${refundKey}:cogs`)
 *      DR Inventory       line costPrice × qty returned, per line
 *      CR COGS            same amounts
 *
 * All amounts are integer minor units (piastres) — no float arithmetic. The
 * per-line revenue/COGS amounts are exact (price × qty). The order-level
 * discount and tax are allocated pro-rata by returned gross over subtotal
 * using CUMULATIVE floor allocation across this order's partial returns:
 * each return posts `entitled(cumulative gross) − entitled(prior gross)`,
 * so the deltas telescope — the rounding remainder lands deterministically
 * on the return that completes each threshold, the totals never exceed the
 * order's discount/tax, and when every unit has come back the sale (minus
 * shipping) is reversed EXACTLY. Prior returned quantities come from the
 * order's COMPLETED Return rows (excluding this refundKey): the return
 * domain's canonical record of what came back, committed by
 * ReturnService.complete BEFORE it fires `order/refunded`, so it is always
 * visible to this consumer regardless of fanout ordering — unlike the
 * inventory fanout's `partial_return_restored` orderEvent marker, which is
 * written by a different Inngest function this module does not own, can
 * lag, dead-letter, or be skipped entirely (`restoreInventory:false`), and
 * whose absence would silently disable both the allocation and the clamp
 * (audit issue 1189). Exchange-type returns are excluded — they never fire
 * refund effects and post no GL.
 *
 * Idempotent: one entry set per (order, refundKey) via a fast-path lookup
 * plus postEntry's (source, sourceId) unique. Quantities are clamped to the
 * line's un-returned remainder so an over-claimed or redelivered payload can
 * never reverse more than was sold.
 *
 * Interplay with a later FULL refund: refund-posting reverses the original
 * entries AND these partial adjustment entries, so the ledger nets to zero
 * instead of double-reversing the already-adjusted portion. Conversely, if
 * the sale is already fully reversed (original status='reversed') this
 * no-ops — there is nothing left to adjust.
 *
 * Runs inside the caller's transaction when provided; otherwise wraps itself
 * in withRlsBypass so both entries commit atomically and the reads are not
 * silently filtered by FORCE RLS in tenant-context-less Inngest jobs (see
 * journal.service.postEntry's escape-hatch comment).
 */
export async function postPartialReturnJournal(
  args: PartialReturnJournalArgs
): Promise<{ posted: number; skipped?: string }> {
  // A store on its Durable Object books the adjustment in one section there (Ruling CF-RETURNS-1); idempotent per refundKey.
  if (args.storeId) {
    const money = await storeMoney(args.storeId);
    if (money)
      return money.journalPartialReturn({
        orderId: args.orderId,
        refundKey: args.refundKey,
        items: args.items,
      });
  }
  if (!args.tx) {
    return withScopedToOrderStore(args, tx => postPartialReturnJournal({ ...args, tx }), {
      posted: 0,
      skipped: 'order-not-found',
    });
  }
  const { orderId, refundKey, items, tx } = args;

  const order = await tx.order.findUnique({
    where: { id: orderId, storeId: args.storeId ?? currentStoreId() },
    include: {
      items: true,
      // NOT `status: 'completed'` alone. ReturnService.complete calls
      // PaymentService.refund FIRST, which atomically claims the payment as
      // 'partially_refunded' and commits that BEFORE order/refunded fires — so
      // by the time this consumer runs, a 'completed'-only filter matches
      // nothing, `provider` falls back to 'cod' and the entry credits 1020
      // (COD Clearing) instead of the real gateway account. The entry still
      // balances, so the trial balance and every direct-call test pass while
      // the card/online account stays permanently overstated.
      payments: {
        where: { status: { in: ['completed', 'partially_refunded', 'refunded'] } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!order) {
    logger.warn({ orderId, refundKey }, 'postPartialReturnJournal: order not found');
    return { posted: 0, skipped: 'order-not-found' };
  }
  if (args.storeId && order.storeId !== args.storeId) {
    // Under withRlsBypass RLS cannot catch this — refuse rather than post
    // one tenant's adjustment from another tenant's event (issue 1190).
    logger.error(
      { orderId, refundKey, eventStoreId: args.storeId, orderStoreId: order.storeId },
      'postPartialReturnJournal: event storeId does not match order — refusing'
    );
    return { posted: 0, skipped: 'store-mismatch' };
  }
  const storeId = order.storeId;
  const baseSourceId = `${orderId}:partial:${refundKey}`;

  // Idempotency fast-path — one adjustment per refundKey. postEntry's
  // (source, sourceId) unique is the race-safe backstop.
  const existing = await tx.journalEntry.findFirst({
    where: {
      storeId,
      source: 'order',
      sourceId: { in: [baseSourceId, `${baseSourceId}:cogs`] },
    },
    select: { id: true },
  });
  if (existing) return { posted: 0, skipped: 'already-posted' };

  // The adjustment only makes sense against a still-standing sale journal.
  const cashOriginal = await tx.journalEntry.findFirst({
    where: { storeId, source: 'order', sourceId: orderId },
    // `lines` so the adjustment can credit the SAME cash account the sale
    // debited, instead of re-deriving the provider and hoping the two agree.
    // order-posting builds the cash line as the entry's only debit line.
    select: { id: true, status: true, lines: { select: { accountId: true, debit: true } } },
  });
  if (!cashOriginal) {
    // Order was never posted as paid (or accounting was off at sale time).
    logger.info({ orderId, refundKey }, 'postPartialReturnJournal: no original sale entry');
    return { posted: 0, skipped: 'no-original-entry' };
  }
  // Serialize against a concurrent full-refund reversal of the same sale,
  // then re-read the status under the lock (reverseEntry updates this row).
  // BOTH sides contend on this row: postRefundJournal takes the same
  // FOR UPDATE before snapshotting its candidate set (issue 1187), so a
  // full reversal can never snapshot past an in-flight partial posting and
  // a partial can never post against a sale mid-reversal.
  await tx.$queryRaw`SELECT id FROM public.journal_entries WHERE id = ${cashOriginal.id} FOR UPDATE`;
  const cashStatus = await tx.journalEntry.findUnique({
    where: { id: cashOriginal.id, storeId },
    select: { status: true },
  });
  if (cashStatus?.status === 'reversed') {
    // Full refund already reversed the whole sale — nothing left to adjust,
    // and posting here would double-reverse the returned lines.
    logger.info({ orderId, refundKey }, 'postPartialReturnJournal: sale already fully reversed');
    return { posted: 0, skipped: 'original-reversed' };
  }
  const cogsOriginal = await tx.journalEntry.findFirst({
    where: { storeId, source: 'order', sourceId: `${orderId}:cogs` },
    select: { id: true, status: true },
  });

  // Quantities already taken back by PRIOR item-level reversals, read from
  // the return domain's own COMPLETED rows (see the docblock — deliberately
  // NOT the inventory fanout's marker) plus single-line backorder
  // cancellations (their `backorder_line_cancelled` marker, committed with the
  // cancel before the event fires). ReturnService.complete flips the row to
  // 'completed' before firing order/refunded, so prior returns are always
  // visible here; THIS reversal (refundKey) is excluded — it is already
  // committed too by the time its event arrives. The same read supplies this
  // reversal's merchant-entered reason for the memo (issue 1191 — the event
  // payload carries no reason field).
  const { prevQty, reasons, prevAdjustment } = await loadPriorReversedQty(tx, {
    storeId,
    orderId,
    excludeKey: refundKey,
  });
  const returnReason = reasons.get(refundKey) ?? undefined;
  const isBackorderCancel = refundKey.startsWith('backorder:');

  // Prior gross across the whole order, this return's lines clamped to each
  // line's un-returned remainder, and the cumulative discount/tax allocation.
  // Shared with ReturnService.complete via partial-return-allocation.ts so the
  // amount refunded at the provider is the same number this entry credits to
  // cash — see that module's docblock.
  const alloc = allocatePartialReturn({
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    taxIncludedInPrice: order.taxIncludedInPrice,
    lines: order.items,
    prevQty,
    requested: items,
    // B2B Task 8b: the tier adjustments persisted on the return items (this one's, and the earlier ones' via the loader).
    prevAdjustment,
    thisAdjustment: isBackorderCancel
      ? 0
      : ((
          await tx.returnItem.aggregate({
            where: { returnId: refundKey, return: { storeId } },
            _sum: { tierAdjustment: true },
          })
        )._sum.tierAdjustment ?? 0),
  });
  const { curGross, discountThis, taxThis, revenueDebit, cashCredit, returnedLines } = alloc;

  if (returnedLines.length === 0) {
    logger.info({ orderId, refundKey }, 'postPartialReturnJournal: nothing left to adjust');
    return { posted: 0, skipped: 'nothing-to-adjust' };
  }

  let posted = 0;

  // --- Revenue/tax/credit adjustment (mirror of the sale entry, signs flipped) ---
  if (cashCredit > 0) {
    // Mirror the ORIGINAL sale entry's own cash account. Re-deriving it from
    // the payment row is a second, independent decision that can disagree with
    // the first — and does, whenever the payment's status has moved on, or an
    // order carries more than one completed payment from different providers
    // (a retried checkout completing on a fallback gateway). Disagreement
    // leaves two cash accounts misstated in opposite directions with the trial
    // balance still balancing, so nothing surfaces it. The full-refund path
    // cannot drift this way because reverseEntry mirrors the original's lines;
    // this path is the first that has to reproduce a sale-time decision, so it
    // reads that decision rather than recomputing it.
    const originalCashLine = cashOriginal.lines.find(l => l.debit > 0);
    const provider = order.payments[0]?.provider ?? 'cod';
    const cashCode = PROVIDER_TO_CASH_CODE[provider] ?? '1000';
    const cashAccountId =
      originalCashLine?.accountId ?? (await getSystemAccountIdByCode(storeId, cashCode, tx));
    const revenueAccountId = await getSystemAccountIdByCode(storeId, '4000', tx);

    // WHERE the money went and HOW MUCH actually went (owner decision
    // 2026-10-01, #1207 / #1351 — ruling M1-8 resolved). A completed return
    // records its method and the amount the customer actually got; the credit
    // follows those, not the pro-rata figure. Backorder cancels and any
    // method the decision does not cover keep the previous shape.
    const legs = isBackorderCancel
      ? null
      : await resolveReturnRefundLegs(tx, { storeId, orderId, returnId: refundKey });
    const creditLines: JournalLineInput[] = [];
    let creditTotal = cashCredit;
    if (legs) {
      creditTotal = legs.gateway + legs.wallet + legs.storeCredit;
      const legLine = (accountId: string, amount: number, lineMemo: string) => {
        if (amount > 0) {
          creditLines.push({
            accountId,
            debit: 0,
            credit: amount,
            lineMemo,
            refTable: 'orders',
            refId: order.id,
          });
        }
      };
      legLine(cashAccountId, legs.gateway, `Order ${order.orderNumber} partial refund`);
      if (legs.wallet > 0) {
        legLine(
          await getSystemAccountIdByCode(storeId, '2150', tx),
          legs.wallet,
          `Order ${order.orderNumber} partial refund to customer wallet`
        );
      }
      if (legs.storeCredit > 0) {
        legLine(
          await getSystemAccountIdByCode(storeId, '2160', tx),
          legs.storeCredit,
          `Order ${order.orderNumber} partial refund as store credit`
        );
      }
    } else {
      creditLines.push({
        accountId: cashAccountId,
        debit: 0,
        credit: cashCredit,
        lineMemo: `Order ${order.orderNumber} partial refund`,
        refTable: 'orders',
        refId: order.id,
      });
    }

    // The tax share stays pro-rata (it is what the sale booked for these
    // lines); the sales-return debit is what the customer actually got back
    // net of it, so any difference between the recorded refund and the
    // allocation re-computed here (two returns whose events are processed out
    // of order — ruling AP-5b(4)) moves revenue, never cash or tax.
    const salesReturnDebit = legs ? creditTotal - taxThis : revenueDebit;
    if (legs && salesReturnDebit !== revenueDebit) {
      logger.warn(
        { orderId, refundKey, recorded: creditTotal, allocated: cashCredit },
        'postPartialReturnJournal: recorded refund differs from the re-computed allocation — the difference is booked to sales returns'
      );
    }
    if (salesReturnDebit < 0) {
      throw new Error(
        `postPartialReturnJournal: refund ${refundKey} on order ${orderId} recorded ${creditTotal} piastres, less than its tax share ${taxThis}`
      );
    }

    const lines: JournalLineInput[] = [];
    if (salesReturnDebit > 0) {
      lines.push({
        accountId: revenueAccountId,
        debit: salesReturnDebit,
        credit: 0,
        lineMemo: order.discount > 0 ? 'Sales return (net of pro-rata discount)' : 'Sales return',
        refTable: 'orders',
        refId: order.id,
      });
    }
    if (taxThis > 0) {
      const taxPayableAccountId = await getSystemAccountIdByCode(storeId, '2100', tx);
      lines.push({
        accountId: taxPayableAccountId,
        debit: taxThis,
        credit: 0,
        lineMemo: 'Tax reversed (pro-rata)',
        refTable: 'orders',
        refId: order.id,
      });
    }
    lines.push(...creditLines);

    if (creditTotal > 0) {
      await postEntry({
        storeId,
        source: 'order',
        sourceId: baseSourceId,
        memo: `${isBackorderCancel ? 'Backorder line cancelled' : 'Partial return'} — Order ${order.orderNumber}${returnReason ? ` (${returnReason})` : ''}`,
        memoAr: isBackorderCancel
          ? `إلغاء بند طلب مسبق — طلب ${order.orderNumber}`
          : `مرتجع جزئي — طلب ${order.orderNumber}`,
        lines,
        tx,
      });
      posted += 1;
    }
  }

  // --- COGS adjustment (mirror of the sale COGS entry, signs flipped) ---
  // Only when the sale actually booked COGS and that entry still stands —
  // never "reverse" cost that was never posted or is already reversed.
  if (cogsOriginal && cogsOriginal.status !== 'reversed') {
    const cogsEligible = returnedLines.filter(({ line }) => line.costPrice && line.costPrice > 0);
    const cogsLines: JournalLineInput[] = [];
    let totalCogs = 0;
    if (cogsEligible.length > 0) {
      const inventoryAccountId = await getSystemAccountIdByCode(storeId, '1200', tx);
      const cogsAccountId = await getSystemAccountIdByCode(storeId, '5000', tx);
      for (const { line, qty } of cogsEligible) {
        const itemCogs = line.costPrice! * qty;
        totalCogs += itemCogs;
        cogsLines.push({
          accountId: inventoryAccountId,
          debit: itemCogs,
          credit: 0,
          lineMemo: `Inventory back — ${line.productName} × ${qty}`,
          refTable: 'order_items',
          refId: line.id,
        });
        cogsLines.push({
          accountId: cogsAccountId,
          debit: 0,
          credit: itemCogs,
          lineMemo: `COGS reversed — ${line.productName} × ${qty}`,
          refTable: 'order_items',
          refId: line.id,
        });
      }
    }
    if (totalCogs > 0) {
      await postEntry({
        storeId,
        source: 'order',
        sourceId: `${baseSourceId}:cogs`,
        memo: `COGS reversal (partial return) — Order ${order.orderNumber}`,
        memoAr: `عكس تكلفة البضاعة (مرتجع جزئي) — طلب ${order.orderNumber}`,
        lines: cogsLines,
        tx,
      });
      posted += 1;
    }
  }

  logger.info(
    { orderId, storeId, refundKey, posted, revenueDebit, taxThis, cashCredit },
    'postPartialReturnJournal: done'
  );
  return { posted };
}

/**
 * Where a completed partial return's money actually went, per the owner's
 * account choice (2026-10-01, ruling M1-8 resolved):
 *
 *   - card / gateway (`original`…) → the sale's cash/gateway clearing
 *     account, for what the provider was actually sent. On an order paid
 *     partly from the customer wallet, the wallet part of the refund (#1956)
 *     goes back to the wallet and is credited to 2150 instead.
 *   - `store_credit` that landed in the customer wallet → 2150 Customer
 *     Wallet Liability, for the wallet ledger's own amount.
 *   - `store_credit` with the wallet off (credit handed out off-platform) →
 *     2160 Store Credit Liability, for the amount recorded on the return.
 *
 * Every figure is read from what the completion COMMITTED — the Return row
 * (`refundMethod`, `refundAmount`) and the wallet ledger rows carrying its
 * id — never from the event payload, so a redelivered or replayed event books
 * the same thing. `null` = not a return, not completed, or a method the
 * decision does not cover (`bank_transfer`, `cash`, `manual`): the caller
 * keeps the previous treatment (the sale's cash account, pro-rata).
 */
export async function resolveReturnRefundLegs(
  tx: Prisma.TransactionClient,
  args: { storeId: string; orderId: string; returnId: string }
): Promise<{ gateway: number; wallet: number; storeCredit: number } | null> {
  const ret = await tx.return.findFirst({
    where: { id: args.returnId, storeId: args.storeId, orderId: args.orderId, status: 'completed' },
    select: { refundMethod: true, refundAmount: true },
  });
  if (!ret) return null;
  const walletRows = await tx.walletTransaction.findMany({
    where: { storeId: args.storeId, returnId: args.returnId, type: 'refund_credit' },
    select: { amount: true, idempotencyKey: true },
  });
  const walletFor = (prefix: string) =>
    walletRows
      .filter(r => r.idempotencyKey.startsWith(prefix))
      .reduce((sum, r) => sum + r.amount, 0);

  if (isGatewayRefundMethod(ret.refundMethod)) {
    const wallet = walletFor(RETURN_WALLET_SHARE_KEY_PREFIX);
    const gateway = ret.refundAmount - wallet;
    if (gateway < 0 || ret.refundAmount <= 0) return null;
    return { gateway, wallet, storeCredit: 0 };
  }
  if (ret.refundMethod === 'store_credit') {
    const wallet = walletFor('return-credit:');
    if (wallet > 0) return { gateway: 0, wallet, storeCredit: 0 };
    if (ret.refundAmount <= 0) return null;
    return { gateway: 0, wallet: 0, storeCredit: ret.refundAmount };
  }
  return null;
}

/**
 * Book a partial refund made OUTSIDE a return — in the provider's dashboard
 * (arrives by webhook or a refund-status refresh) or the order page's
 * "refund via provider" with an amount — as a revenue refund for exactly that
 * amount (owner decision 2026-10-01, #1209 / #1455 — ruling M1-7 resolved):
 *
 *   sourceId `${orderId}:partial:refund:<providerRefundId>`
 *   DR 4090 Sales Returns   amount
 *   CR Cash[sale's account] amount
 *
 * No tax line and no COGS/inventory line: no goods came back and nothing says
 * which lines the money was for, so no stock moves.
 *
 * The `:partial:` infix is deliberate: `postRefundJournal` backs every
 * `${orderId}:partial:…` entry out when the order is later refunded in full,
 * so a dashboard partial followed by a full refund nets the ledger to zero,
 * exactly as partial returns do; and the tax report still resolves the order
 * from the id's first segment.
 *
 * Idempotent per provider refund id (fast-path lookup + postEntry's
 * (source, sourceId) unique), and it contends on the sale entry's row lock
 * like the partial-return posting, so it cannot post against a sale that a
 * concurrent full refund is reversing.
 */
export async function postAmountOnlyRefundJournal(args: {
  orderId: string;
  storeId?: string;
  /** `refund:<providerRefundId>` — see amountOnlyRefundKey (lib/refund-methods). */
  refundKey: string;
  /** Piastres actually refunded. */
  amount: number;
  tx?: Prisma.TransactionClient;
}): Promise<{ posted: number; skipped?: string }> {
  if (args.storeId) {
    const money = await storeMoney(args.storeId);
    if (money)
      return money.journalAmountOnlyRefund({
        orderId: args.orderId,
        refundKey: args.refundKey,
        amount: args.amount,
      });
  }
  if (!args.tx) {
    return withScopedToOrderStore(args, tx => postAmountOnlyRefundJournal({ ...args, tx }), {
      posted: 0,
      skipped: 'order-not-found',
    });
  }
  const { orderId, refundKey, amount, tx } = args;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    logger.error({ orderId, refundKey, amount }, 'postAmountOnlyRefundJournal: invalid amount');
    return { posted: 0, skipped: 'invalid-amount' };
  }
  const order = await tx.order.findUnique({
    where: { id: orderId, storeId: args.storeId ?? currentStoreId() },
    select: { id: true, storeId: true, orderNumber: true },
  });
  if (!order) return { posted: 0, skipped: 'order-not-found' };
  if (args.storeId && order.storeId !== args.storeId) {
    logger.error(
      { orderId, refundKey, eventStoreId: args.storeId, orderStoreId: order.storeId },
      'postAmountOnlyRefundJournal: event storeId does not match order — refusing'
    );
    return { posted: 0, skipped: 'store-mismatch' };
  }
  const storeId = order.storeId;
  const sourceId = `${orderId}:partial:${refundKey}`;

  const existing = await tx.journalEntry.findFirst({
    where: { storeId, source: 'order', sourceId },
    select: { id: true },
  });
  if (existing) {
    // Observable, not silent (issue 2310): a skip here means the SAME key was
    // booked before. If two paths ever disagree on the key for one refund,
    // the second books under a different key and this line never fires —
    // which is why the in-band path refuses to invent a key at all.
    logger.warn(
      { storeId, orderId, sourceId, amount },
      '[partial-return-posting] amount-only refund already booked under this key — skipped'
    );
    return { posted: 0, skipped: 'already-posted' };
  }

  const sale = await tx.journalEntry.findFirst({
    where: { storeId, source: 'order', sourceId: orderId },
    select: { id: true, lines: { select: { accountId: true, debit: true } } },
  });
  if (!sale) {
    logger.info({ orderId, refundKey }, 'postAmountOnlyRefundJournal: no original sale entry');
    return { posted: 0, skipped: 'no-original-entry' };
  }
  // Same lock as postPartialReturnJournal / postRefundJournal (issue 1187).
  await tx.$queryRaw`SELECT id FROM public.journal_entries WHERE id = ${sale.id} FOR UPDATE`;
  const saleStatus = await tx.journalEntry.findUnique({
    where: { id: sale.id, storeId },
    select: { status: true },
  });
  if (saleStatus?.status === 'reversed') {
    return { posted: 0, skipped: 'original-reversed' };
  }

  const cashAccountId = sale.lines.find(l => l.debit > 0)?.accountId;
  if (!cashAccountId) {
    throw new Error(`postAmountOnlyRefundJournal: sale entry for ${orderId} has no debit line`);
  }
  const salesReturnsAccountId = await getSystemAccountIdByCode(storeId, '4090', tx);
  await postEntry({
    storeId,
    source: 'order',
    sourceId,
    memo: `Refund outside a return — Order ${order.orderNumber}`,
    memoAr: `استرداد خارج المرتجعات — طلب ${order.orderNumber}`,
    lines: [
      {
        accountId: salesReturnsAccountId,
        debit: amount,
        credit: 0,
        lineMemo: 'Revenue refunded (no goods returned)',
        refTable: 'orders',
        refId: order.id,
      },
      {
        accountId: cashAccountId,
        debit: 0,
        credit: amount,
        lineMemo: `Order ${order.orderNumber} refund ${refundKey.slice('refund:'.length)}`,
        refTable: 'orders',
        refId: order.id,
      },
    ],
    tx,
  });
  logger.info({ orderId, storeId, refundKey, amount }, 'postAmountOnlyRefundJournal: posted');
  return { posted: 1 };
}
