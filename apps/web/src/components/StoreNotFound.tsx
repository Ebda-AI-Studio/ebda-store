import Link from './StoreLink';
import { StoreNotFoundBody } from './StoreNotFoundBody';
import type { ResolvedStore } from '../lib/store-resolver';

/**
 * Store-branded 404 — shown for unknown paths on a merchant's storefront
 * (its `<slug>.ebda.app` host or its custom domain).
 *
 * HARD multi-tenant rule: a store must NEVER show the Ebda platform
 * landing or link to `ebda.app` to its own customers. A bad URL on
 * `demo-shop.example` shows Demo Shop's OWN "page not available", not the
 * platform pitch (which also linked to competing merchants). Inherits the
 * store's theme CSS vars (set by the root layout) so it matches the brand.
 */
export function StoreNotFound({ store }: { store: ResolvedStore }) {
  // Every store has its own host, so its home is simply `/`.
  const homeHref = '/';
  const logo = store.logo || store.logoAr;
  const storeName = store.nameAr || store.name;

  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center gap-8 bg-background px-6 py-20 text-center text-foreground">
      <Link href={homeHref} className="inline-flex items-center" aria-label={storeName}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt={storeName}
            className="h-14 max-h-14 w-auto max-w-[150px] object-contain md:h-20 md:max-h-20 md:max-w-[210px]"
          />
        ) : (
          <span className="text-2xl font-bold">{storeName}</span>
        )}
      </Link>

      <StoreNotFoundBody />
    </main>
  );
}
