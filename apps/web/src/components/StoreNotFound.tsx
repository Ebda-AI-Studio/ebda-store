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
const LOGO_CLASS =
  'h-14 max-h-14 w-auto max-w-[150px] object-contain md:h-20 md:max-h-20 md:max-w-[210px]';

export function StoreNotFound({ store }: { store: ResolvedStore }) {
  // Every store has its own host, so its home is simply `/`.
  const homeHref = '/';
  const logo = store.logo || store.logoAr;
  const storeName = store.nameAr || store.name;

  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center gap-8 bg-background px-6 py-20 text-center text-foreground">
      <Link href={homeHref} className="inline-flex items-center" aria-label={storeName}>
        {logo ? (
          <>
            {/* PREMIUM-11: both logos when the store has both; the page direction (set from the
                language) shows the right one, as the header does. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={store.logo || logo}
              alt={storeName}
              className={`${LOGO_CLASS} ${store.logo && store.logoAr ? 'rtl:hidden' : ''}`}
            />
            {store.logo && store.logoAr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={store.logoAr}
                alt={storeName}
                className={`${LOGO_CLASS} hidden rtl:block`}
              />
            )}
          </>
        ) : (
          <span className="text-2xl font-bold">{storeName}</span>
        )}
      </Link>

      <StoreNotFoundBody />
    </main>
  );
}
