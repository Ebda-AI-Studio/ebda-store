'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from './StoreLink';
import { api, type Category } from '../lib/api';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreUrl } from '../contexts/StoreContext';
import { findSurpriseSlug } from '../lib/surprise-product';

/**
 * One empty state for guest wishlist, search with no hits, empty wishlist (audit 2026-11-03 #8,
 * Ruling PREMIUM-8), modelled on the store 404 (`StoreNotFoundBody`): a title and one calm line, then a
 * way out (this store's top categories, "browse all", a playful "surprise me"). Tenant-scoped through
 * the storefront API; never the platform's brand.
 */
export function EmptyStateKit({
  title,
  body,
  icon,
  children,
}: {
  title: string;
  body?: string;
  icon?: ReactNode;
  /** Extra actions (e.g. a sign-in link) rendered before the generic ones. */
  children?: ReactNode;
}) {
  const { t, isRtl } = useLanguage();
  const storeUrl = useStoreUrl();
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [busy, setBusy] = useState(false);
  const [none, setNone] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getCategories()
      .then(res => {
        if (!live || !res.success || !res.data) return;
        setCategories(
          (res.data.categories ?? []).filter(c => c.slug !== 'best-sellers').slice(0, 6)
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const surprise = async () => {
    setBusy(true);
    setNone(false);
    try {
      const slug = await findSurpriseSlug(async (page, limit) => {
        const res = await api.getProducts({ page: String(page), limit: String(limit) });
        if (!res.success || !res.data) return null;
        return { products: res.data.products ?? [], total: res.data.meta?.total ?? 0 };
      });
      if (slug) router.push(storeUrl(`/products/${slug}`));
      else setNone(true);
    } catch {
      setNone(true);
    } finally {
      setBusy(false);
    }
  };

  const btn =
    'inline-flex h-12 items-center justify-center rounded-[var(--radius)] px-6 text-base font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

  return (
    <div
      data-empty-state
      className="mx-auto flex max-w-xl flex-col items-center gap-6 py-12 text-center"
    >
      {icon}
      <div className="space-y-2">
        <h2 className="text-balance text-xl font-semibold leading-snug">{title}</h2>
        {body && <p className="text-sm text-foreground/70">{body}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {children}
        <Link href={storeUrl('/products')} className={`${btn} bg-primary text-primary-foreground`}>
          {t('Browse all products', 'تصفّح كل المنتجات')}
        </Link>
        <button
          type="button"
          onClick={surprise}
          disabled={busy}
          aria-busy={busy}
          className={`${btn} border border-primary bg-background text-primary disabled:opacity-60`}
        >
          {busy ? t('Picking…', 'بنختار…') : t('Surprise me', 'فاجئني')}
        </button>
      </div>
      <p role="status" aria-live="polite" className="-mt-3 min-h-5 text-sm text-foreground/70">
        {none ? t('Nothing in stock to suggest right now.', 'مفيش منتج متاح نقترحه دلوقتي.') : ''}
      </p>
      {categories.length > 0 && (
        <nav aria-label={t('Categories', 'الفئات')}>
          <ul className="flex flex-wrap justify-center gap-2">
            {categories.map(c => (
              <li key={c.id}>
                <Link
                  href={storeUrl(`/products?category=${encodeURIComponent(c.slug)}`)}
                  className="inline-flex min-h-11 items-center rounded-full border border-input px-4 text-sm hover:border-primary hover:text-primary"
                >
                  {isRtl ? c.nameAr || c.name : c.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
