/**
 * A held add-on payment that a person resolves must also close the merchant's InstaPay CLAIM behind it. After a 409
 * `ADDON_PAYMENT_HELD` the claim stays `pending` with a reviewer (approve refuses: the ledger row is held; reject refuses: the claim is
 * taken), so without this the merchant reads "waiting for payment" for ever and the claim's transfer reference stays used.
 *
 *   refunded            -> `rejected` with the note; the transfer reference stays USED (the money went back: it must not be filed again).
 *   not_ours            -> `rejected` with the note, the reference is freed for re-filing, the receipt is rejected.
 *   credited            -> `confirmed` ONLY against a term of the same sku that THIS credit created (a ledger row newer than the held row);
 *                          a term the merchant already had running never counts. Otherwise `rejected` with a note saying the credit was not found, so the merchant is never
 *                          told it was granted when it was not.
 * Idempotent (acts only on a still-pending claim), so a retried resolve repeats it safely. Runs in the store's scope (`tx`).
 * Kept out of subscription-billing.service on purpose: account.service imports that file, so it is loaded lazily from the resolve.
 */
import type { Prisma } from '@ebda/database';
import { InstapayReceiptService } from '../payment-providers/instapay-receipt.service';
import { ADDON_PLAN_PREFIX, skuOfPlanCode } from './addon-catalog';
import { freedReference } from './account.service';

type Tx = Prisma.TransactionClient;

const ADDON_CLAIM_KEY_PREFIX = 'addon-instapay:';

export async function closeAddonClaimForResolvedHold(
  tx: Tx,
  a: {
    storeId: string;
    row: { id: string; planCode: string | null; idempotencyKey: string | null };
    action: 'credited' | 'refunded' | 'not_ours';
    note: string;
    actorId: string;
  }
): Promise<'none' | 'confirmed' | 'rejected'> {
  const { row } = a;
  if (
    !row.planCode?.startsWith(ADDON_PLAN_PREFIX) ||
    !row.idempotencyKey?.startsWith(ADDON_CLAIM_KEY_PREFIX)
  )
    return 'none';
  const claimId = row.idempotencyKey.slice(ADDON_CLAIM_KEY_PREFIX.length);
  const claim = await tx.manualPaymentClaim.findFirst({
    where: { id: claimId, storeId: a.storeId, status: 'pending' },
  });
  if (!claim) return 'none';
  let grantedEventId: string | null = null;
  if (a.action === 'credited') {
    // Only a term created AFTER the held row opened, by something other than that row, can be this credit's grant: a term the
    // merchant already had running (an earlier card purchase) must never confirm a held claim it did not pay for.
    const held = await tx.billingEvent.findFirst({
      where: { id: row.id, storeId: a.storeId },
      select: { createdAt: true },
    });
    const sku = skuOfPlanCode(row.planCode);
    const term =
      sku && held
        ? (
            await tx.billingEvent.findMany({
              where: {
                storeId: a.storeId,
                type: 'upgrade',
                status: 'succeeded',
                planCode: row.planCode,
                id: { not: row.id },
                createdAt: { gt: held.createdAt },
                forPeriodEnd: { gt: new Date() },
              },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            })
          )[0]
        : undefined;
    grantedEventId = term?.id ?? null;
  }
  const confirm = a.action === 'credited' && grantedEventId !== null;
  const note = confirm
    ? a.note
    : a.action === 'credited'
      ? `Credited by hand, but no active add-on of this kind was found: ${a.note}`
      : a.note;
  const done = await tx.manualPaymentClaim.updateMany({
    where: { id: claim.id, storeId: a.storeId, status: 'pending' },
    data: confirm
      ? {
          status: 'confirmed',
          billingEventId: grantedEventId,
          reviewNote: note.slice(0, 500),
          reviewedBy: a.actorId,
          reviewedAt: new Date(),
        }
      : {
          status: 'rejected',
          // refunded: the transfer was returned to the merchant, so its reference stays USED (a refunded transfer must not be
          // filed and approved again); not_ours / a credit nobody granted free it for re-filing
          ...(a.action === 'refunded'
            ? {}
            : { payerReference: freedReference(claim.payerReference, claim.id, 'rejected') }),
          reviewNote: note.slice(0, 500),
          reviewedBy: a.actorId,
          reviewedAt: new Date(),
        },
  });
  if (done.count === 0) return 'none';
  const receipt = await tx.instapayReceipt.findFirst({
    where: { storeId: a.storeId, claimId: claim.id },
    select: { id: true },
  });
  if (receipt)
    await InstapayReceiptService.markReviewed(
      a.storeId,
      receipt.id,
      confirm
        ? { status: 'approved' }
        : { status: 'rejected', note, keepReference: a.action === 'refunded' },
      a.actorId
    );
  return confirm ? 'confirmed' : 'rejected';
}
