import { withStore } from '@ebda/database';
import { ownedStoreIds } from '../lib/definer';

/**
 * Subscription states that are (or are about to be) billed. `comped` is a free grant and `canceled` has stopped,
 * so neither makes closing the owner's account a billing problem.
 */
export const BILLED_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'trialing'] as const;

/**
 * The live stores `ownerId` owns whose subscription is still billed (OFFBOARD-1, Ruling OFFBOARD-1). Closing an
 * owner account with one of these would leave a paying store with no owner to cancel, pay or receive its invoices.
 * Shared by `DELETE /auth/me` and the merchant account-closure trigger so both refuse on the same predicate.
 */
export async function liveBilledStoresOf(ownerId: string): Promise<string[]> {
  const owned = await ownedStoreIds(ownerId);
  const billed: string[] = [];
  for (const storeId of owned) {
    const sub = await withStore(storeId, tx =>
      tx.storeSubscription.findUnique({ where: { storeId }, select: { status: true } })
    );
    if (sub && (BILLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) {
      billed.push(storeId);
    }
  }
  return billed;
}

export const OWNER_HAS_BILLED_STORE_MESSAGE_AR =
  'مش هينفع تقفل حسابك دلوقتي لأنك مالك متجر شغال وعليه اشتراك مدفوع. الغي الاشتراك من صفحة الفوترة أو انقل ملكية المتجر لحد تاني، وبعدها اقفل حسابك.';
