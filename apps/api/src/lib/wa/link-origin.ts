import { storefrontOrigin } from '@ebda/shared';
import { withStoreDb } from '../jobs/store-db';

/** `{ storefrontOrigin }` for a store (custom domain, else <slug>.ebda.app), or `{}` when it cannot be read: the field is optional on the wire. */
export async function storefrontOriginOf(storeId: string): Promise<{ storefrontOrigin?: string }> {
  const store = await withStoreDb(storeId, db =>
    db.store.findUnique({ where: { id: storeId }, select: { slug: true, domain: true } })
  ).catch(() => null);
  return store
    ? { storefrontOrigin: storefrontOrigin({ slug: store.slug, domain: store.domain ?? null }) }
    : {};
}
