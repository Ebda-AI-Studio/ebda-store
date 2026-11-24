/**
 * A held add-on payment that a person resolves must also close the merchant's InstaPay CLAIM behind it. After a 409
 * `ADDON_PAYMENT_HELD` the claim stays `pending` with a reviewer (approve refuses: the ledger row is held; reject refuses: the claim is
 * taken), so without this the merchant reads "waiting for payment" for ever and the claim's transfer reference stays used.
 *
 *   refunded / not_ours -> the claim is `rejected` with the person's note, its reference is freed for re-filing, its receipt is rejected.
 *   credited            -> `confirmed` ONLY when that add-on is actually granted (an active term of the same sku exists, i.e. the person
 *                          really granted it); otherwise `rejected` with a note saying the credit was not found, so the merchant is never
 *                          told it was granted when it was not.
 * Idempotent (acts only on a still-pending claim), so a retried resolve repeats it safely. Runs in the store's scope (`tx`).
 * Kept out of subscription-billing.service on purpose: account.service imports that file, so it is loaded lazily from the resolve.
 */
import type { Prisma } from '@ebda/database';
import { InstapayReceiptService } from '../payment-providers/instapay-receipt.service';
import { activeAddons } from './addon-grant';
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
    const sku = skuOfPlanCode(row.planCode);
    const term = sku
      ? (await activeAddons(tx, a.storeId, new Date())).find(t => t.sku === sku)
      : undefined;
    grantedEventId = term?.eventId ?? null;
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
          payerReference: freedReference(claim.payerReference, claim.id, 'rejected'),
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
      confirm ? { status: 'approved' } : { status: 'rejected', note },
      a.actorId
    );
  return confirm ? 'confirmed' : 'rejected';
}
