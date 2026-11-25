/**
 * A held add-on payment that a person resolves must also close the merchant's InstaPay CLAIM behind it. After a 409
 * `ADDON_PAYMENT_HELD` the claim stays `pending` with a reviewer (approve refuses: the ledger row is held; reject refuses: the claim is
 * taken), so without this the merchant reads "waiting for payment" for ever and the claim's transfer reference stays used.
 *
 *   refunded -> `rejected` with the note; the transfer reference stays USED (the money went back: it must not be filed again).
 *   not_ours -> `rejected` with the note, the reference is freed for re-filing, the receipt is rejected.
 * `credited` is NOT an option for an add-on (Ruling ADDON-HELD-CREDIT-A): nothing can write a hand credit for one, so a credit could only
 * match a later card purchase (a double charge). `resolveHeldBillingWebhook` refuses it (409 HELD_ADDON_CREDIT_UNSUPPORTED) before any write.
 * Idempotent (acts only on a still-pending claim), so a retried resolve repeats it safely. Runs in the store's scope (`tx`).
 * Kept out of subscription-billing.service on purpose: account.service imports that file, so it is loaded lazily from the resolve.
 */
import type { Prisma } from '@ebda/database';
import { InstapayReceiptService } from '../payment-providers/instapay-receipt.service';
import { ADDON_PLAN_PREFIX } from './addon-catalog';
import { freedReference } from './account.service';

type Tx = Prisma.TransactionClient;

const ADDON_CLAIM_KEY_PREFIX = 'addon-instapay:';

export async function closeAddonClaimForResolvedHold(
  tx: Tx,
  a: {
    storeId: string;
    row: { id: string; planCode: string | null; idempotencyKey: string | null };
    /** only the two decisions that can end an add-on hold (Ruling ADDON-HELD-CREDIT-A: nothing writes a hand credit for an add-on) */
    action: 'refunded' | 'not_ours';
    note: string;
    actorId: string;
  }
): Promise<'none' | 'rejected'> {
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
  const done = await tx.manualPaymentClaim.updateMany({
    where: { id: claim.id, storeId: a.storeId, status: 'pending' },
    data: {
      status: 'rejected',
      // refunded: the transfer was returned to the merchant, so its reference stays USED (a refunded transfer must not be filed
      // and approved again); not_ours frees it for re-filing
      ...(a.action === 'refunded'
        ? {}
        : { payerReference: freedReference(claim.payerReference, claim.id, 'rejected') }),
      reviewNote: a.note.slice(0, 500),
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
      { status: 'rejected', note: a.note, keepReference: a.action === 'refunded' },
      a.actorId
    );
  return 'rejected';
}
