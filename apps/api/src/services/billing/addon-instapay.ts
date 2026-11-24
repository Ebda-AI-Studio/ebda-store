/**
 * Add-on paid by InstaPay (Ruling ADDON-SS-6, Ahmad 2026-11-15): the merchant transfers the quoted total and uploads the
 * receipt, exactly as for a plan; that creates a `manual_payment_claims` row (planCode `addon:<sku>`), which IS the entry in
 * the existing super-admin approval queue. NOTHING is granted until a super admin approves; then the claim becomes a
 * ledger row settled through the same guarded pending -> succeeded transition as a card payment, so the term is granted
 * exactly once. Reject, or never approve = nothing is ever active. When InstaPay auto-confirm ships it calls
 * `approveAddonClaim` with the machine as the actor; nothing else changes.
 */
import { withStore } from '@ebda/database';
import type { InstapayReceiptFields } from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { InstapayReceiptService } from '../payment-providers/instapay-receipt.service';
import { instapayHandle, instapayQrUrl } from './manual-config';
import { newPaymentReference, submitSubscriptionReceipt } from './account.service';
import { vatOfPaidAmount, resolvePlatformVat } from './charge-amount';
import { claimEvent, settleApprovedPayment } from './subscription-billing.service';
import { planCodeOfSku, skuOfPlanCode } from './addon-catalog';
import { quoteAddon } from './addons.service';

/** What the merchant needs to pay: handle, QR, exact total (VAT included), the reference to put on the transfer. */
export async function addonInstapayInstructions(storeId: string, sku: string) {
  const handle = instapayHandle();
  if (!handle)
    throw new AppError(409, 'INSTAPAY_NOT_CONFIGURED', 'InstaPay is not available right now');
  const { item, amount } = await quoteAddon(storeId, sku, { card: false });
  const sub = await withStore(storeId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId }, select: { paymentReference: true } })
  );
  return {
    sku: item.sku,
    nameEn: item.nameEn,
    nameAr: item.nameAr,
    handle,
    qrUrl: instapayQrUrl(),
    reference: sub?.paymentReference ?? newPaymentReference(),
    amountMinor: amount.totalMinor,
    vatMinor: amount.vatMinor,
  };
}

/** The merchant's checked receipt fields: opens an approval-queue entry. Never grants anything. */
export async function submitAddonReceipt(a: {
  storeId: string;
  sku: string;
  receiptId: string;
  fields: InstapayReceiptFields;
}) {
  if (!instapayHandle())
    throw new AppError(409, 'INSTAPAY_NOT_CONFIGURED', 'InstaPay is not available right now');
  const { item, amount } = await quoteAddon(a.storeId, a.sku, { card: false });
  return submitSubscriptionReceipt({
    storeId: a.storeId,
    receiptId: a.receiptId,
    fields: a.fields,
    addon: { planCode: planCodeOfSku(item.sku), amountMinor: amount.totalMinor },
  });
}

/**
 * Super admin (or, later, the auto-confirm rule) approves a pending add-on claim. Idempotent end to end: the ledger row
 * key is the claim id, the settle is the guarded transition, the claim flip is guarded on `pending`.
 */
export async function approveAddonClaim(a: { storeId: string; claimId: string; actorId: string }) {
  const claim = await withStore(a.storeId, tx =>
    tx.manualPaymentClaim.findFirst({
      where: { id: a.claimId, storeId: a.storeId },
    })
  );
  if (!claim || !claim.planCode.startsWith('addon:'))
    throw new AppError(404, 'CLAIM_NOT_FOUND', 'No add-on claim with this id');
  if (claim.status === 'rejected')
    throw new AppError(409, 'CLAIM_NOT_PENDING', 'This claim was rejected');
  if (claim.status === 'pending' && !claim.reviewedBy && !skuOfPlanCode(claim.planCode))
    throw new AppError(409, 'ADDON_NOT_FOUND', 'This add-on is no longer sold: reject the claim');
  // Claim the approval FIRST, atomically (one compare-and-set), then grant. A concurrent reject only acts on a claim nobody has
  // taken (`reviewedBy` still empty), so it can never leave a granted add-on behind a rejected claim; and a reject that won the
  // race makes this CAS match nothing. A claim already taken (a half-finished approval, a retry, a double click) resumes: every
  // step after the CAS is idempotent.
  const taken = await withStore(a.storeId, tx =>
    tx.manualPaymentClaim.updateMany({
      where: { id: claim.id, storeId: a.storeId, status: 'pending', reviewedBy: null },
      data: { reviewedBy: a.actorId, reviewedAt: new Date() },
    })
  );
  if (taken.count === 0) {
    const now = await withStore(a.storeId, tx =>
      tx.manualPaymentClaim.findFirst({ where: { id: claim.id, storeId: a.storeId } })
    );
    if (!now || now.status === 'rejected')
      throw new AppError(409, 'CLAIM_NOT_PENDING', 'This claim was rejected');
    // pending with a reviewer = a half-finished approval; confirmed = finished: both resume below
  }
  const key = `addon-instapay:${claim.id}`;
  let eventId = await claimEvent({
    storeId: a.storeId,
    type: 'upgrade',
    planCode: claim.planCode,
    amountMinor: claim.amountMinor,
    charge: vatOfPaidAmount(claim.amountMinor, await resolvePlatformVat()),
    provider: 'instapay',
    idempotencyKey: key,
  });
  if (!eventId) {
    // Already claimed by an earlier (possibly half-finished) approval: resume it.
    const held = await withStore(a.storeId, tx =>
      tx.billingEvent.findFirst({
        where: { storeId: a.storeId, idempotencyKey: key },
        select: { id: true },
      })
    );
    if (!held) throw new AppError(409, 'APPROVAL_IN_PROGRESS', 'Try again in a moment');
    eventId = held.id;
  }
  await settleApprovedPayment(eventId, claim.payerReference, new Date());
  const receiptId = await withStore(a.storeId, async tx => {
    await tx.manualPaymentClaim.updateMany({
      where: { id: claim.id, storeId: a.storeId, status: 'pending' },
      data: {
        status: 'confirmed',
        reviewedBy: a.actorId,
        reviewedAt: new Date(),
        billingEventId: eventId,
      },
    });
    const r = await tx.instapayReceipt.findFirst({
      where: { storeId: a.storeId, claimId: claim.id },
      select: { id: true },
    });
    if (r)
      await InstapayReceiptService.markReviewed(a.storeId, r.id, { status: 'approved' }, a.actorId);
    return r?.id ?? null;
  });
  if (receiptId) await InstapayReceiptService.deleteImages(a.storeId, [receiptId]);
  return { billingEventId: eventId };
}
