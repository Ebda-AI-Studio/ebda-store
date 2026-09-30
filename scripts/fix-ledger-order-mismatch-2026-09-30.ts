/**
 * ONE-OFF, NOT YET RUN — awaiting Ahmad's approval.
 *
 * Corrects the two production orders whose general ledger disagrees with the
 * order's state (audit 2026-09-30, finding 4 — wady-aljuz). A read-only scan
 * of all three prod stores on 2026-09-30 found exactly these two:
 *
 *   A. ORD-1781512189610-9972A710 (f47343b8-…) — delivered + paid, but its
 *      sale entry JE-2026-000015 (9.500 KWD) was reversed by JE-2026-000020
 *      "refund applied". Cause: on 2026-07-09 a delivered→refunded status
 *      change ran in a request transaction that timed out and rolled back
 *      (the order stayed `delivered`), while the refund side effects had
 *      committed on their own transaction and `order/refunded` had been sent;
 *      the GL poster reversed the sale. No refund was paid (the payment row is
 *      still `completed`, no refund id, no payment event).
 *      FIX: reverse the erroneous reversal JE-2026-000020 with the standard
 *      `reverseEntry` — a mirror entry re-books the sale. Nothing is deleted.
 *      OPTIONAL (--fix-stock): the same rollback left +1 unit of phantom
 *      stock on each of the order's three lines (return_stock rows at
 *      2026-07-09 16:32:04, goods were delivered). Only apply after the
 *      merchant confirms the counts; it writes an `adjustment` history row.
 *
 *   B. ORD-1778670342233-50212B65 (f64fd62c-…) — refunded (by status, May 16;
 *      paymentStatus was left at 'paid'), but JE-2026-000018 (5.000 KWD) books
 *      its sale with no reversal. Cause: the 2026-07-09 order-created stuck
 *      sweep re-fired `order/created` for it, and the fanout posted the sale
 *      of an already-refunded order.
 *      FIX: run the standard refund reversal (`postRefundJournal`).
 *
 * Every precondition below is re-checked against the live rows first; if ANY
 * differs from what the audit saw, the script refuses and changes nothing.
 *
 * Usage (from the repo root, DATABASE_URL = the prod DB — owner role):
 *   npx tsx scripts/fix-ledger-order-mismatch-2026-09-30.ts             # dry run (default)
 *   npx tsx scripts/fix-ledger-order-mismatch-2026-09-30.ts --execute   # apply A + B
 *   npx tsx scripts/fix-ledger-order-mismatch-2026-09-30.ts --execute --fix-stock
 */
import { prisma, withRlsBypass, type Prisma } from '@force/database';
import { reverseEntry } from '../apps/api/src/services/accounting/journal.service';
import { postRefundJournal } from '../apps/api/src/services/accounting/posting/refund-posting';

const EXECUTE = process.argv.includes('--execute');
const FIX_STOCK = process.argv.includes('--fix-stock');

const STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506'; // wady-aljuz

const CASE_A = {
  orderId: 'f47343b8-fa0f-4273-9430-be0d4c1ed0d2',
  orderNumber: 'ORD-1781512189610-9972A710',
  saleEntryNumber: 'JE-2026-000015',
  wrongReversalEntryNumber: 'JE-2026-000020',
  amount: 9500,
  phantomStock: [
    { productId: '59be70d9-e5ad-460d-a4c9-e3441e0b688b', name: 'Makdous', qty: 1 },
    { productId: '939eede2-9d80-46cc-8f5e-486de3acffa2', name: 'cranberry', qty: 1 },
    { productId: 'd8d35b8f-812f-4d03-8e61-426eb8dc44bd', name: 'Dry mint', qty: 1 },
  ],
};

const CASE_B = {
  orderId: 'f64fd62c-3ac4-43c5-a741-e2c3c1a55d1b',
  orderNumber: 'ORD-1778670342233-50212B65',
  saleEntryNumber: 'JE-2026-000018',
  amount: 5000,
};

function refuse(msg: string): never {
  throw new Error(`REFUSED — state differs from the 2026-09-30 audit, nothing changed: ${msg}`);
}

async function entryTotals(entryId: string) {
  const lines = await withRlsBypass(tx => tx.journalLine.findMany({ where: { entryId } }));
  return {
    debit: lines.reduce((s, l) => s + l.debit, 0),
    credit: lines.reduce((s, l) => s + l.credit, 0),
  };
}

async function checkCaseA() {
  const order = await withRlsBypass(tx =>
    tx.order.findFirst({
      where: { id: CASE_A.orderId, storeId: STORE_ID },
      include: { payments: true },
    })
  );
  if (!order) refuse('case A order not found');
  if (order.orderNumber !== CASE_A.orderNumber) refuse('case A order number');
  if (order.status !== 'delivered' || order.paymentStatus !== 'paid')
    refuse(`case A order is ${order.status}/${order.paymentStatus}, expected delivered/paid`);
  if (order.payments.some(p => p.status !== 'completed' || p.refundId))
    refuse('case A has a refunded payment — a real refund may exist; investigate first');

  const sale = await withRlsBypass(tx =>
    tx.journalEntry.findFirst({
      where: { storeId: STORE_ID, entryNumber: CASE_A.saleEntryNumber },
    })
  );
  const wrong = await withRlsBypass(tx =>
    tx.journalEntry.findFirst({
      where: { storeId: STORE_ID, entryNumber: CASE_A.wrongReversalEntryNumber },
    })
  );
  if (!sale || !wrong) refuse('case A entries not found');
  if (sale.sourceId !== CASE_A.orderId || sale.status !== 'reversed')
    refuse(`case A sale entry is ${sale.status} / ${sale.sourceId}`);
  if (sale.reversedById !== wrong.id) refuse('case A sale is not reversed by the expected entry');
  if (wrong.status !== 'posted' || wrong.sourceId !== `${CASE_A.orderId}:reversal`)
    refuse(`case A reversal is ${wrong.status} / ${wrong.sourceId}`);
  const t = await entryTotals(wrong.id);
  if (t.debit !== CASE_A.amount || t.credit !== CASE_A.amount)
    refuse(`case A reversal totals ${t.debit}/${t.credit}`);
  return { wrongReversalId: wrong.id };
}

async function checkCaseB() {
  const order = await withRlsBypass(tx =>
    tx.order.findFirst({ where: { id: CASE_B.orderId, storeId: STORE_ID } })
  );
  if (!order) refuse('case B order not found');
  if (order.orderNumber !== CASE_B.orderNumber) refuse('case B order number');
  if (order.status !== 'refunded') refuse(`case B order is ${order.status}, expected refunded`);

  const entries = await withRlsBypass(tx =>
    tx.journalEntry.findMany({
      where: { storeId: STORE_ID, source: 'order', sourceId: { startsWith: CASE_B.orderId } },
    })
  );
  if (entries.length !== 1) refuse(`case B has ${entries.length} entries, expected 1 (the sale)`);
  const sale = entries[0];
  if (sale.entryNumber !== CASE_B.saleEntryNumber || sale.status !== 'posted')
    refuse(`case B sale is ${sale.entryNumber} ${sale.status}`);
  const t = await entryTotals(sale.id);
  if (t.debit !== CASE_B.amount || t.credit !== CASE_B.amount)
    refuse(`case B sale totals ${t.debit}/${t.credit}`);
}

async function main() {
  console.log(
    `[fix-ledger] mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}${FIX_STOCK ? ' + stock' : ''}`
  );
  const a = await checkCaseA();
  await checkCaseB();
  console.log('[fix-ledger] preconditions hold for both cases.');
  console.log(
    `[fix-ledger] A: would reverse ${CASE_A.wrongReversalEntryNumber} (re-books the ${CASE_A.amount / 1000} KWD sale of ${CASE_A.orderNumber})`
  );
  console.log(
    `[fix-ledger] B: would reverse ${CASE_B.saleEntryNumber} (${CASE_B.amount / 1000} KWD sale of refunded ${CASE_B.orderNumber})`
  );
  if (FIX_STOCK) {
    for (const s of CASE_A.phantomStock)
      console.log(`[fix-ledger] A stock: would remove ${s.qty} phantom unit(s) of ${s.name}`);
  }
  if (!EXECUTE) {
    console.log('[fix-ledger] dry run — nothing written. Re-run with --execute to apply.');
    return;
  }

  // ONE transaction for everything (withRlsBypass = an interactive
  // transaction with the same maxWait/timeout as withMoneyTx, plus the RLS
  // bypass GUCs the journal tables need): either both corrections and the
  // optional stock fix land, or none do.
  await withRlsBypass(async tx => {
    const txc = tx as unknown as Prisma.TransactionClient;
    await reverseEntry(
      a.wrongReversalId,
      `Correction: ${CASE_A.wrongReversalEntryNumber} reversed a refund that never committed (order ${CASE_A.orderNumber} is delivered + paid) — audit 2026-09-30`,
      txc
    );
    console.log(`[fix-ledger] A: reversed ${CASE_A.wrongReversalEntryNumber}.`);

    const b = await postRefundJournal({
      orderId: CASE_B.orderId,
      storeId: STORE_ID,
      reason: `Correction: sale of refunded order ${CASE_B.orderNumber} was booked with no reversal — audit 2026-09-30`,
      tx: txc,
    });
    if (b.reversed !== 1) refuse(`case B reversed ${b.reversed} entries, expected 1`);
    console.log('[fix-ledger] B: reversed 1 entry.');

    if (FIX_STOCK) {
      for (const s of CASE_A.phantomStock) {
        const [p] = await tx.$queryRaw<Array<{ inventory: number }>>`
          SELECT inventory FROM public.products WHERE id = ${s.productId} AND store_id = ${STORE_ID} FOR UPDATE`;
        if (!p) refuse(`product ${s.name} not found`);
        await tx.product.update({
          where: { id: s.productId },
          data: { inventory: { decrement: s.qty } },
        });
        await tx.inventoryHistory.create({
          data: {
            productId: s.productId,
            storeId: STORE_ID,
            type: 'adjustment',
            quantity: -s.qty,
            previousStock: p.inventory,
            newStock: p.inventory - s.qty,
            reason: `Correction: phantom restock from rolled-back refund of ${CASE_A.orderNumber} (audit 2026-09-30)`,
            reference: CASE_A.orderId,
          },
        });
      }
      console.log(
        '[fix-ledger] A: phantom stock removed (storefront caches refresh on their TTL).'
      );
    }
  });
  console.log('[fix-ledger] done.');
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
