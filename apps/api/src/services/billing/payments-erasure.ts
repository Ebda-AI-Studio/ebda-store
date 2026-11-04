/**
 * NEON-ZERO-1 (N-27, Ruling NZ-10D-5): merchant erasure of the payer PII held in the PLATFORM payments tables
 * (`instapay_receipts`, `manual_payment_claims`), wherever the family lives (D1 after the cutover, Postgres before).
 *
 * ANONYMISE, never delete (tax): amounts, dates, statuses, flags, the transfer reference key and the ledger link stay.
 *   receipts: payer name / address / mobile / bank, receiver name / handle / mobile, note, the AI-read `extracted`
 *             JSON, reviewer id -> NULL, `personal_scrubbed_at` stamped
 *   claims:   `payer_reference` -> `erased:<request>:<claim id>` (unique per claim: the (method, payer_reference) index
 *             stays valid), reviewer id -> NULL
 * Runs only after the store-do money gate passed (cf/erasure/job.ts orders the `store-do` surface first and stops on a
 * refusal). Idempotent: a second run finds nothing left to change. `remaining` = rows still holding a payer value.
 */
import { prisma, withStore } from '@ebda/database';
import { SCRUBBED_PERSONAL_FIELDS } from '../payment-providers/instapay-receipt.service';
import { platformFamilyOnD1 } from '../platform/cutover';
import type { PaymentsErasurePort } from '../../cf/erasure/surfaces';

const PREFIX = 'erased:';

async function inScope<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (await platformFamilyOnD1('payments')) return fn();
  return withStore(storeId, fn);
}

const holdsPayerValue = (storeId: string) => ({
  OR: [
    { payerName: { not: null } },
    { payerAddress: { not: null } },
    { payerMobile: { not: null } },
    { payerBank: { not: null } },
    { receiverName: { not: null } },
    { receiverHandle: { not: null } },
    { receiverMobile: { not: null } },
    { note: { not: null } },
    { reviewedBy: { not: null } },
  ].map(c => ({ ...c, storeId })),
});

export const paymentsErasurePort: PaymentsErasurePort = {
  async scrub(storeIds, requestId, now = new Date()) {
    let erased = 0;
    for (const storeId of storeIds) {
      await inScope(storeId, async () => {
        const r = await prisma.instapayReceipt.updateMany({
          where: { storeId, personalScrubbedAt: null },
          data: { ...SCRUBBED_PERSONAL_FIELDS(now), reviewedBy: null },
        });
        erased += r.count;
        // receipts scrubbed earlier by the retention sweep may still carry a reviewer id
        await prisma.instapayReceipt.updateMany({
          where: { storeId, reviewedBy: { not: null } },
          data: { reviewedBy: null },
        });
        const claims = await prisma.manualPaymentClaim.findMany({
          where: { storeId, NOT: { payerReference: { startsWith: PREFIX } } },
          select: { id: true },
        });
        for (const c of claims) {
          const u = await prisma.manualPaymentClaim.updateMany({
            where: { id: c.id, storeId, NOT: { payerReference: { startsWith: PREFIX } } },
            data: { payerReference: `${PREFIX}${requestId}:${c.id}`, reviewedBy: null },
          });
          erased += u.count;
        }
        const left = await prisma.manualPaymentClaim.updateMany({
          where: { storeId, reviewedBy: { not: null } },
          data: { reviewedBy: null },
        });
        erased += left.count;
      });
    }
    return { erased };
  },
  async remaining(storeIds) {
    let n = 0;
    for (const storeId of storeIds) {
      n += await inScope(storeId, async () => {
        const [a, b, c] = await Promise.all([
          prisma.instapayReceipt.count({ where: holdsPayerValue(storeId) }),
          prisma.instapayReceipt.count({
            where: { storeId, extractionStatus: 'done', personalScrubbedAt: null },
          }),
          prisma.manualPaymentClaim.count({
            where: {
              storeId,
              OR: [
                { NOT: { payerReference: { startsWith: PREFIX } } },
                { reviewedBy: { not: null } },
              ],
            },
          }),
        ]);
        return a + b + c;
      });
    }
    return n;
  },
};
