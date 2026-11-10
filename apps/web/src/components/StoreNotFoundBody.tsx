'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from './StoreLink';
import { useRouter } from 'next/navigation';
import { api, type Category } from '../lib/api';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreUrl } from '../contexts/StoreContext';
import { openSearch } from '../lib/search-term-state';
import { findSurpriseSlug } from '../lib/surprise-product';
import { SearchAutocomplete } from './SearchAutocomplete';

const MAX_CATEGORIES = 8;

/**
 * The interactive half of a store's 404 (the merchant's own theme and brand, never Ebda's): the store's
 * own typeahead, its top categories, home / cart, and a playful "Surprise me" that opens a random
 * in-stock product of THIS store. Everything is tenant-scoped by the Host through the storefront API.
 */
export function StoreNotFoundBody() {
  const { t, isRtl } = useLanguage();
  const storeUrl = useStoreUrl();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [surprising, setSurprising] = useState(false);
  const [surpriseNone, setSurpriseNone] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getCategories()
      .then(res => {
        if (!live || !res.success || !res.data) return;
        setCategories(
          (res.data.categories ?? [])
            .filter(c => c.slug !== 'best-sellers')
            .slice(0, MAX_CATEGORIES)
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = query.trim();
    // The term never goes in the URL (Ruling SEARCH-URL-1): it is handed to /search out of band.
    if (term) openSearch(term, storeUrl('/search'), url => router.push(url));
  };

  const surprise = async () => {
    setSurprising(true);
    setSurpriseNone(false);
    try {
      const slug = await findSurpriseSlug(async (page, limit) => {
        const res = await api.getProducts({ page: String(page), limit: String(limit) });
        if (!res.success || !res.data) return null;
        return { products: res.data.products ?? [], total: res.data.meta?.total ?? 0 };
      });
      if (slug) router.push(storeUrl(`/products/${slug}`));
      else setSurpriseNone(true);
    } catch {
      setSurpriseNone(true);
    } finally {
      setSurprising(false);
    }
  };

  const button =
    'inline-flex h-12 items-center justify-center gap-2 rounded-xl px-6 text-base font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 active:opacity-90';

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8 text-start">
      <div className="space-y-3 text-center">
        <h1 className="text-balance text-2xl font-semibold leading-snug sm:text-3xl">
          {t("The page you're looking for can't be found.", 'الصفحة اللي بتدوّر عليها مش موجودة.')}
        </h1>
        <p className="text-sm text-foreground/70">
          {t(
            'Search for what you meant, or pick from below.',
            'دوّر على اللي كنت تقصده، أو اختار من تحت.'
          )}
        </p>
      </div>

      <form onSubmit={submit} role="search" className="relative">
        <label htmlFor="store-404-search" className="sr-only">
          {t('Search the store', 'دوّر في المتجر')}
        </label>
        <input
          id="store-404-search"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('Search the store', 'دوّر في المتجر')}
          enterKeyHint="search"
          className="h-12 w-full rounded-xl border border-input bg-background px-4 text-base text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <SearchAutocomplete query={query} onSelect={() => setQuery('')} />
      </form>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href={storeUrl('/')} className={`${button} bg-primary text-primary-foreground`}>
          {t('Back to store', 'ارجع للمتجر')}
        </Link>
        <Link
          href={storeUrl('/cart')}
          className={`${button} border border-input bg-background text-foreground`}
        >
          {t('Cart', 'السلة')}
        </Link>
        <button
          type="button"
          onClick={surprise}
          disabled={surprising}
          aria-busy={surprising}
          className={`${button} border border-primary bg-background text-primary disabled:opacity-60`}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5 motion-safe:group-hover:rotate-12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M17.7 6.3l-2.4 2.4M8.7 15.3l-2.4 2.4" />
          </svg>
          {surprising ? t('Picking…', 'بنختار…') : t('Surprise me', 'فاجئني')}
        </button>
      </div>
      <p role="status" aria-live="polite" className="-mt-4 text-center text-sm text-foreground/70">
        {surpriseNone
          ? t('Nothing in stock to suggest right now.', 'مفيش منتج متاح نقترحه دلوقتي.')
          : ''}
      </p>

      {categories.length > 0 && (
        <nav aria-label={t('Categories', 'الفئات')} className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground/70">{t('Categories', 'الفئات')}</h2>
          <ul className="flex flex-wrap gap-2">
            {categories.map(c => (
              <li key={c.id}>
                <Link
                  href={storeUrl(`/products?category=${encodeURIComponent(c.slug)}`)}
                  prefetch={false}
                  className="inline-flex min-h-11 items-center rounded-full border border-input px-4 text-sm text-foreground hover:border-primary hover:text-primary"
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
