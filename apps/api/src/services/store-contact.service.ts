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
 * on its contact page (`stores.email`), else the owner's account email (each skipped when it is one of Ebda's own addresses). Read in the store's own
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
  // An address that is one of Ebda's own (sender, no-reply, support) would mail the platform: it
  // is skipped and the NEXT candidate is tried (FU46 M-5), never the platform itself.
  const to =
    [store.email, ownerActive ? store.owner?.email : null]
      .map(a => a?.trim())
      .find(a => a && !isPlatformAddress(a)) || null;
  return { to, isDemo: store.isDemo, slug: store.slug };
}

/** Ebda's own mail domain, taken from the brand's no-reply address (e.g. `ebda.app`). */
const PLATFORM_DOMAIN = BRAND.noReplyEmail.split('@')[1]!.toLowerCase();

/**
 * True for any address that would mail Ebda itself: the configured sender, or ANY mailbox on
 * Ebda's domain or a subdomain of it (FU46 M-5, N-2) — not just the three named addresses.
 */
export function isPlatformAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (config.smtpFromEmail && a === config.smtpFromEmail.trim().toLowerCase()) return true;
  const domain = a.split('@')[1] ?? '';
  return domain === PLATFORM_DOMAIN || domain.endsWith(`.${PLATFORM_DOMAIN}`);
}
