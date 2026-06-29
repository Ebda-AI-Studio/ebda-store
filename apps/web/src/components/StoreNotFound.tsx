import Link from 'next/link';
import type { ResolvedStore } from '../lib/store-resolver';

/**
 * Store-branded 404 — shown for unknown paths on a merchant's storefront
 * (custom domain OR the platform `/<slug>` path).
 *
 * HARD multi-tenant rule: a store must NEVER show the Force AI platform
 * landing or link to `store.force-ai.co` to its own customers. A bad URL on
 * `wadyaljuz.com` shows Wady Aljuz's OWN "page not available", not the
 * platform pitch (which also linked to competing merchants). Inherits the
 * store's theme CSS vars (set by the root layout) so it matches the brand.
 */
export function StoreNotFound({ store }: { store: ResolvedStore }) {
  // Custom domain → root; platform path → `/<slug>` (so we never link off the
  // store onto the platform host).
  const homeHref = store.domain ? '/' : `/${store.slug}`;
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

      <div className="space-y-3">
        <p className="text-6xl font-bold text-primary">404</p>
        <h1 className="text-xl font-semibold" dir="rtl">
          الصفحة غير متوفرة
        </h1>
        <p className="text-base font-medium text-foreground/70">This page isn’t available</p>
        <p className="mx-auto max-w-md text-sm text-foreground/60" dir="rtl">
          عذرًا، الصفحة التي تبحث عنها غير موجودة أو تم نقلها.
        </p>
      </div>

      <Link
        href={homeHref}
        className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-8 text-base font-semibold text-primary-foreground transition active:opacity-90"
      >
        <span dir="rtl">العودة إلى المتجر</span>
        <span aria-hidden>·</span>
        <span>Back to store</span>
      </Link>
    </main>
  );
}
