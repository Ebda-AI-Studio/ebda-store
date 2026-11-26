import { withStore } from '@ebda/database';
import { BRAND } from '@ebda/shared';
import { storeDb } from '../lib/repo-factory';
import { getAccountsBrief } from '../lib/identity-client';
import { config } from '../config';

export interface StoreContactTarget {
  /** The store's public contact email, else its owner's account email when that account is active; null when neither exists. */
  to: string | null;
  isDemo: boolean;
  slug: string;
}

/**
 * Where a shopper's storefront contact message goes (Ruling FU46-1): the address the store shows
 * on its contact page (`stores.email`), else the owner's account email (each skipped when it is one of Ebda's own addresses).
 * The store record is read through the store's own backend (a Durable Object store's record is its DO; the Prisma read threw
 * POSTGRES_REMOVED on the Worker) and the owner's account through the identity service (accounts live there, not in the store):
 * an owner who is suspended, or erased (absent from the identity answer), is never mailed. Null when the store no longer
 * exists or is soft-deleted.
 */
export async function storeContactTarget(storeId: string): Promise<StoreContactTarget | null> {
  const store = await withStore(storeId, async () =>
    (await storeDb(storeId)).store.findUnique({
      where: { id: storeId },
      select: { email: true, isDemo: true, slug: true, deletedAt: true, ownerId: true },
    })
  );
  if (!store || store.deletedAt) return null;
  // An address that is one of Ebda's own (sender, no-reply, support) would mail the platform: it
  // is skipped and the NEXT candidate is tried (FU46 M-5), never the platform itself.
  const usable = (a: string | null | undefined) => {
    const t = a?.trim();
    return t && !isPlatformAddress(t) ? t : null;
  };
  let to = usable(store.email);
  if (!to && store.ownerId) {
    const owner = (await getAccountsBrief([store.ownerId])).find(a => a.id === store.ownerId);
    if (owner?.status === 'active') to = usable(owner.email);
  }
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
