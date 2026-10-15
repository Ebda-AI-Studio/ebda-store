import { withStore } from '@ebda/database';
import { BRAND } from '@ebda/shared';
import { config } from '../config';

export interface StoreContactTarget {
  /** The store's public contact email, else its owner's account email when that account is active; null when neither exists. */
  to: string | null;
  isDemo: boolean;
  slug: string;
}

/**
 * Where a shopper's storefront contact message goes (Ruling FU46-1): the address the store shows
 * on its contact page (`stores.email`), else the owner's account email. Read in the store's own
 * scope: the owner's `users` row is visible there (strict RLS policy on `users`, owner EXISTS
 * clause). Null when the store no longer exists or is soft-deleted.
 */
export async function storeContactTarget(storeId: string): Promise<StoreContactTarget | null> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: {
        email: true,
        isDemo: true,
        slug: true,
        deletedAt: true,
        owner: { select: { email: true, status: true, deletedAt: true } },
      },
    })
  );
  if (!store || store.deletedAt) return null;
  const ownerActive = store.owner?.status === 'active' && !store.owner.deletedAt;
  const candidate = store.email?.trim() || (ownerActive ? store.owner?.email?.trim() : '') || null;
  // An address equal to the platform sender / no-reply would loop mail back to Ebda: fall through.
  const platform = new Set(
    [config.smtpFromEmail, BRAND.noReplyEmail].map(a => a?.trim().toLowerCase())
  );
  const to = candidate && !platform.has(candidate.toLowerCase()) ? candidate : null;
  return { to, isDemo: store.isDemo, slug: store.slug };
}
