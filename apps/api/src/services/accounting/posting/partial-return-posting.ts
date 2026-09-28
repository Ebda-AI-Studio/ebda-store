import { withRlsBypass } from '@force/database';
import type { Prisma } from '@prisma/client';
import { getSystemAccountIdByCode } from '../account.service';
import { postEntry, type JournalLineInput } from '../journal.service';
import { PROVIDER_TO_CASH_CODE } from './order-posting';
import logger from '../../../lib/logger';
import { allocatePartialReturn } from './partial-return-allocation';

export interface PartialReturnJournalArgs {
  orderId: string;
  /**
   * Idempotency key for this partial return — the Return id (every partial
   * `order/refunded` producer sets it from ReturnService.complete). One
   * adjustment entry set per refundKey; a redelivered event no-ops. The
   * Return row it names also supplies the memo's merchant-entered reason.
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
 *      (Shipping Income is NOT reversed — the order shipped and the customer
 *      kept part of it; a whole-order cancel goes down the full-reversal
 *      path, which does reverse it.)
 *
 *   2. COGS adjustment     (sourceId = `${orderId}:partial:${refundKey}:cogs`)
 *      DR Inventory       line costPrice × qty returned, per line
 *      CR COGS            same amounts
 *
 * All amounts are integer minor units (fils) — no float arithmetic. The
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
  if (!args.tx) {
    return withRlsBypass(tx => postPartialReturnJournal({ ...args, tx }));
  }
  const { orderId, refundKey, items, tx } = args;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      // NOT `status: 'completed'` alone. ReturnService.complete calls
      // PaymentService.refund FIRST, which atomically claims the payment as
      // 'partially_refunded' and commits that BEFORE order/refunded fires — so
      // by the time this consumer runs, a 'completed'-only filter matches
      // nothing, `provider` falls back to 'cod' and the entry credits 1020
      // (COD Clearing) instead of the real gateway account. The entry still
      // balances, so the trial balance and every direct-call test pass while
      // KNET stays permanently overstated.
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
    where: { id: cashOriginal.id },
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

  // Quantities already returned by PRIOR returns, read from the return
  // domain's own COMPLETED rows (see the docblock — deliberately NOT the
  // inventory fanout's marker). ReturnService.complete flips the row to
  // 'completed' before firing order/refunded, so prior returns are always
  // visible here; THIS return (id === refundKey) is excluded — it is
  // already 'completed' too by the time its event arrives. The same query
  // also supplies this return's merchant-entered reason for the memo
  // (issue 1191 — the event payload carries no reason field).
  const completedReturns = await tx.return.findMany({
    where: { storeId, orderId, status: 'completed', type: { in: ['return', 'refund'] } },
    select: {
      id: true,
      reason: true,
      items: { select: { orderItemId: true, quantity: true } },
    },
  });
  const returnReason = completedReturns.find(r => r.id === refundKey)?.reason;
  const prevQty = new Map<string, number>();
  for (const ret of completedReturns) {
    if (ret.id === refundKey) continue;
    for (const it of ret.items) {
      prevQty.set(it.orderItemId, (prevQty.get(it.orderItemId) ?? 0) + it.quantity);
    }
  }

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
  });
  const { curGross, discountThis, taxThis, revenueDebit, cashCredit, returnedLines } = alloc;

  if (returnedLines.length === 0) {
    logger.info({ orderId, refundKey }, 'postPartialReturnJournal: nothing left to adjust');
    return { posted: 0, skipped: 'nothing-to-adjust' };
  }

  let posted = 0;

  // --- Revenue/tax/cash adjustment (mirror of the sale entry, signs flipped) ---
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

    const lines: JournalLineInput[] = [];
    if (revenueDebit > 0) {
      lines.push({
        accountId: revenueAccountId,
        debit: revenueDebit,
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
    lines.push({
      accountId: cashAccountId,
      debit: 0,
      credit: cashCredit,
      lineMemo: `Order ${order.orderNumber} partial refund`,
      refTable: 'orders',
      refId: order.id,
    });

    await postEntry({
      storeId,
      source: 'order',
      sourceId: baseSourceId,
      memo: returnReason
        ? `Partial return — Order ${order.orderNumber} (${returnReason})`
        : `Partial return — Order ${order.orderNumber}`,
      memoAr: `مرتجع جزئي — طلب ${order.orderNumber}`,
      lines,
      tx,
    });
    posted += 1;
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
