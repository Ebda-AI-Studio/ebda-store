/**
 * One-off: replay journal posting for existing PAID orders whose journals were
 * never created (E2 — Inngest was unregistered + CoA was empty when they paid).
 * Idempotent: postOrderPaymentJournal skips if a journal already exists, and
 * posts ONLY the journal — no emails/notifications re-fire.
 * Run by Ahmad post-CoA-seed: `npx tsx scripts/replay-order-journals.ts`
 */
import { prisma, withRlsBypass } from '@force/database';
import { postOrderPaymentJournal } from '../apps/api/src/services/accounting/posting/order-posting';

async function main() {
  const paid = await withRlsBypass(tx =>
    tx.order.findMany({ where: { paymentStatus: 'paid' }, select: { id: true, orderNumber: true } })
  );
  let ok = 0;
  for (const o of paid) {
    try {
      await postOrderPaymentJournal({ orderId: o.id });
      ok++;
      console.log(`[journal] ${o.orderNumber ?? o.id}: posted/exists`);
    } catch (e) {
      console.error(`[journal] ${o.orderNumber ?? o.id}: FAILED`, (e as Error).message);
    }
  }
  console.log(`[journal] done. ${ok}/${paid.length} paid orders processed.`);
}
main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
