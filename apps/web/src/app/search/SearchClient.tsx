'use client';

import { EmptyStateKit } from '../../components/EmptyStateKit';
import { useState, useEffect, useLayoutEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from '../../components/StoreLink';
import { api, type Category, type Product } from '@/lib/api';
import { Select } from '@ebda/ui';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useCart } from '../../contexts/CartContext';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { toTemplateProduct } from '../../templates/adapters';
import { trackSearch } from '../../components/MarketingPixels';
import { SearchAutocomplete } from '../../components/SearchAutocomplete';
import { countText, RESULTS } from '../../lib/plural';
import { displaySort, getSortOptions, sortProducts, type SortValue } from './search-sort';
import { darkLookListingBand } from '../../templates/shared/section-bg';
import {
  SEARCH_TERM_EVENT,
  commitSearchTerm,
  readSearchTermFromHistory,
  resolveSearchTerm,
} from '../../lib/search-term-state';

// Layout effect so a legacy `?q=` address is rewritten before any ad pixel can read it.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function SearchContent() {
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { t, language } = useLanguage();
  const { addItem, items: cartItems } = useCart();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const searchParams = useSearchParams();
  const isRtl = language === 'ar';
  const urlPrefix = storeUrl('');

  const cartQuantities: Record<string, number> = {};
  for (const item of cartItems) {
    cartQuantities[item.productId] = item.quantity;
  }

  const handleAddToCart = async (productId: string) => {
    const product = allProducts.find(p => p.id === productId);
    if (!product) return;
    await addItem(
      {
        id: product.id,
        name: product.name,
        nameAr: product.nameAr ?? undefined,
        price: product.price,
        slug: product.slug,
        image: product.images?.[0]?.url,
      },
      1
    );
  };

  // The term is NOT in the URL (Ruling SEARCH-URL-1, launch blocker 31): it lives in this history
  // entry's state, so back, forward and refresh restore it and no log, Referer or pixel sees it.
  // Category and sort are not personal data and stay in the URL.
  const [committedQuery, setCommittedQuery] = useState('');
  const committedCategory = searchParams?.get('category') || '';
  const committedSort = (searchParams?.get('sort') as SortValue | null) || 'relevance';

  const searchKey = searchParams?.toString() ?? '';
  useIsoLayoutEffect(() => {
    setCommittedQuery(resolveSearchTerm());
  }, [searchKey]);
  useEffect(() => {
    // Back / forward between two searches that share one address, and the header search box
    // while this page is already open.
    const sync = () => setCommittedQuery(readSearchTermFromHistory());
    window.addEventListener('popstate', sync);
    window.addEventListener(SEARCH_TERM_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(SEARCH_TERM_EVENT, sync);
    };
  }, []);

  const [searchTerm, setSearchTerm] = useState(committedQuery);
  const [categoryFilter, setCategoryFilter] = useState(committedCategory);
  const [sortBy, setSortBy] = useState<SortValue>(committedSort);

  const [allProducts, setAllProducts] = useState<Product[]>([]);
  // The server returned the list in relevance order (meta.ranked).
  const [ranked, setRanked] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Filters (category + sort) stay hidden behind the Filters button — they
  // only appear after the shopper opens them, once search results are up.
  // Start open when a category filter was deep-linked so it's visible.
  const [showFilters, setShowFilters] = useState(Boolean(committedCategory));

  // Fetch categories once on mount (non-critical)
  useEffect(() => {
    api
      .getCategories()
      .then(res => {
        if (res.success && res.data) setCategories(res.data.categories || []);
      })
      .catch(() => undefined);
  }, []);

  const performSearch = useCallback(async (term: string, category: string) => {
    if (!term.trim()) {
      setAllProducts([]);
      setRanked(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    // Fire Search pixel event whenever a search is performed
    trackSearch({ searchString: term });

    try {
      const params: Record<string, string> = { search: term };
      if (category) params.category = category;
      const response = await api.getProducts(params);
      if (response.success && response.data) {
        setAllProducts(response.data.products || []);
        setRanked(response.data.meta?.ranked === true);
      } else {
        setError(
          response.error?.message || t('Failed to search products', 'البحث عن المنتجات منفعش')
        );
      }
    } catch {
      setError(
        t(
          'Unable to search. Please check your connection and try again.',
          'معرفناش نبحث. اتأكد من اتصالك بالإنترنت وجرّب تاني.'
        )
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Re-run search when URL params change
  useEffect(() => {
    if (committedQuery) {
      setSearchTerm(committedQuery);
      setCategoryFilter(committedCategory);
      setSortBy(committedSort);
      performSearch(committedQuery, committedCategory);
    } else {
      setAllProducts([]);
      setRanked(false);
    }
  }, [committedQuery, committedCategory, committedSort, performSearch]);

  /** New history entry: category + sort in the URL, the term in the entry's state only. */
  function pushParams(term: string, category: string, sort: SortValue) {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (sort && sort !== 'relevance') params.set('sort', sort);
    const qs = params.toString();
    commitSearchTerm(term, `${storeUrl('/search')}${qs ? `?${qs}` : ''}`, 'push');
    setCommittedQuery(term.trim());
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    pushParams(searchTerm, categoryFilter, sortBy);
  }

  function handleCategoryChange(value: string) {
    setCategoryFilter(value);
    if (committedQuery) pushParams(committedQuery, value, sortBy);
  }

  function handleSortChange(value: SortValue) {
    setSortBy(value);
    if (committedQuery) pushParams(committedQuery, categoryFilter, value);
  }

  // Apply client-side sort; category filter already sent to API but also applied locally
  // so switching category without re-fetching gives instant feedback.
  const filtered = categoryFilter
    ? allProducts.filter(p =>
        p.categories?.some(
          c => c.category.id === categoryFilter || c.category.name === categoryFilter
        )
      )
    : allProducts;
  const effectiveSort = displaySort(sortBy, ranked);
  const products = sortProducts(filtered, effectiveSort);

  const displayQuery = committedQuery || searchTerm;

  return (
    <ShopChrome>
      {/* A dark look lists product photos on the inverse band, as /products does (I-3). */}
      <div className="flex-1" style={darkLookListingBand(store?.theme, store?.look, false)}>
        {/* Search results are still product listings — same typography
          zone as /products. */}
        <div
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8"
          data-zone="products"
        >
          <h1 className="text-3xl font-bold mb-6">
            {t(
              'Search Products',
              '\u0627\u0644\u0628\u062d\u062b \u0639\u0646 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
            )}
          </h1>

          {/* Search form */}
          <form onSubmit={handleSearch} role="search" className="mb-6">
            <div className="relative max-w-2xl mx-auto">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder={t(
                    'Search for products...',
                    '\u0627\u0644\u0628\u062d\u062b \u0639\u0646 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a...'
                  )}
                  className="min-w-0 flex-1 px-4 py-3 border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                />
                <button
                  type="submit"
                  className="px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
                >
                  {t('Search', translations['Search'])}
                </button>
              </div>
              {/* Live autocomplete suggestions — same component as theme headers.
                Absolutely positioned relative to this wrapper so it overlays
                the page content below the input. Selecting a suggestion
                navigates to the product page (handled inside the component);
                the on-page results list continues to be driven by searchTerm. */}
              <SearchAutocomplete
                query={searchTerm}
                committedQuery={committedQuery}
                onSelect={() => {}}
              />
            </div>
          </form>

          {/* Filter & Sort bar — uses the same stacked-with-inline-labels
            pattern as the /products toolbar (commit 33abdf6) so Arabic
            labels like "السعر: من الأعلى للأقل" can't truncate. Each filter
            occupies its own row at every breakpoint; min-w on each Select
            guards the Arabic label width. 2026-05-16 ahmad standing rule:
            'apply mobile's fix to desktop' — toolbar UX is identical
            regardless of viewport. */}
          {/* Filters toggle — only appears once a search has been run (results
            are up). Tapping it reveals the category + sort controls. */}
          {committedQuery && (
            <div className="mb-4 max-w-2xl mx-auto">
              <button
                type="button"
                onClick={() => setShowFilters(v => !v)}
                aria-expanded={showFilters}
                aria-controls="search-filters"
                className="flex h-11 w-full items-center justify-between rounded-xl border border-input bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <span className="inline-flex items-center gap-2">
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                    />
                  </svg>
                  {t('Filters', 'الفلاتر')}
                  {categoryFilter && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                      1
                    </span>
                  )}
                </span>
                <svg
                  className={`h-4 w-4 transition-transform duration-200 ${showFilters ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
            </div>
          )}

          {committedQuery && showFilters && (
            <div
              id="search-filters"
              className="mb-6 max-w-2xl mx-auto rounded-xl bg-muted/30 p-4 flex flex-col gap-3"
            >
              {categories.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {t('Category:', 'الفئة:')}
                  </span>
                  <Select
                    id="search-category"
                    value={categoryFilter}
                    onChange={e => handleCategoryChange(e.target.value)}
                    options={[
                      {
                        value: '',
                        label: t(
                          'All Categories',
                          '\u0643\u0644 \u0627\u0644\u0641\u0626\u0627\u062a'
                        ),
                      },
                      ...categories.map(cat => ({ value: cat.id, label: cat.name })),
                    ]}
                    className="flex-1 min-w-[14rem] h-11 rounded-lg border border-input bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 lg:h-10 lg:text-sm"
                  />
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="shrink-0 text-sm font-medium text-foreground">
                  {t('Sort by:', 'ترتيب حسب:')}
                </span>
                <Select
                  id="search-sort"
                  value={effectiveSort}
                  onChange={e => handleSortChange(e.target.value as SortValue)}
                  options={getSortOptions(t, ranked).map(opt => ({
                    value: opt.value,
                    label: opt.label,
                  }))}
                  className="flex-1 min-w-[12rem] h-11 rounded-lg border border-input bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 lg:h-10 lg:text-sm"
                />
              </div>
              {categoryFilter && (
                <button
                  onClick={() => handleCategoryChange('')}
                  className="self-start flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                >
                  {categories.find(c => c.id === categoryFilter)?.name ?? categoryFilter}
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              role="alert"
              className="mb-6 p-4 bg-destructive/10 border border-destructive/30 rounded-lg"
            >
              <div className="flex items-center gap-3">
                <svg
                  className="h-5 w-5 text-destructive-ink flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <p className="text-destructive-ink flex-1">{error}</p>
                <button
                  onClick={() => performSearch(committedQuery, categoryFilter)}
                  className="px-3 py-1 text-sm bg-destructive/20 text-destructive-ink rounded hover:bg-destructive/30 transition-colors"
                >
                  {t(
                    'Retry',
                    '\u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Loading skeletons */}
          {isLoading && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="bg-muted animate-pulse rounded-lg h-64" />
              ))}
            </div>
          )}

          {/* Results grid */}
          {!isLoading && !error && products.length > 0 && (
            <>
              <p className="text-muted-foreground mb-6 text-sm">
                {t(
                  countText('en', products.length, RESULTS),
                  countText('ar', products.length, RESULTS)
                )}{' '}
                {t('for', 'لـ')} &quot;
                {displayQuery}&quot;
                {categoryFilter && (
                  <>
                    {' '}
                    {t('in', 'في')}{' '}
                    <span className="font-medium text-foreground">
                      {categories.find(c => c.id === categoryFilter)?.name ?? categoryFilter}
                    </span>
                  </>
                )}
              </p>
              {T && !templateLoading ? (
                <T.ProductGrid
                  products={products.map(toTemplateProduct)}
                  isRtl={isRtl}
                  currency={store.currency}
                  columns={4}
                  cartQuantities={cartQuantities}
                  onAddToCart={handleAddToCart}
                  urlPrefix={urlPrefix}
                />
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                  {products.map(p => (
                    <div key={p.id} className="animate-pulse rounded-xl border bg-card">
                      <div className="aspect-square bg-muted rounded-t-xl" />
                      <div className="p-4 space-y-2">
                        <div className="h-4 w-3/4 bg-muted rounded" />
                        <div className="h-5 w-1/2 bg-muted rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* No results */}
          {!isLoading && !error && committedQuery && products.length === 0 && (
            <EmptyStateKit
              title={`${t('No products found for', 'ملقيناش منتجات لـ')} "${committedQuery}"${
                categoryFilter ? t(' in the selected category', ' في الفئة المحددة') : ''
              }`}
              body={t(
                'Check the spelling, try a shorter word, or pick from below.',
                'اتأكد من الكتابة، جرّب كلمة أقصر، أو اختار من تحت.'
              )}
            >
              {categoryFilter && (
                <button
                  onClick={() => handleCategoryChange('')}
                  className="inline-flex h-12 items-center rounded-[var(--radius)] border border-input px-6 text-base"
                >
                  {t('Clear category filter', 'مسح فلتر الفئة')}
                </button>
              )}
            </EmptyStateKit>
          )}

          {/* Empty state when no query entered yet */}
          {!isLoading && !error && !committedQuery && (
            <div className="text-center py-12">
              <svg
                className="mx-auto h-12 w-12 text-muted-foreground mb-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <p className="text-lg font-medium text-foreground mb-1">
                {t(
                  'Search our products',
                  '\u0627\u0628\u062d\u062b \u0641\u064a \u0645\u0646\u062a\u062c\u0627\u062a\u0646\u0627'
                )}
              </p>
              <p className="text-muted-foreground">
                {t(
                  'Enter a search term above to find products by name, description, or category.',
                  'اكتب كلمة بحث فوق عشان تلاقي المنتجات بالاسم أو الوصف أو الفئة.'
                )}
              </p>
              <Link
                href={storeUrl('/products')}
                className="mt-4 inline-block text-primary hover:underline text-sm font-medium"
              >
                {t(
                  'Or browse all products',
                  '\u0623\u0648 \u062a\u0635\u0641\u062d \u062c\u0645\u064a\u0639 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
                )}
              </Link>
            </div>
          )}
        </div>
      </div>
    </ShopChrome>
  );
}

function SearchFallback() {
  const { t } = useLanguage();
  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold mb-8">{t('Search', translations['Search'])}</h1>
        <div className="animate-pulse bg-muted h-12 max-w-2xl rounded-lg" />
      </div>
    </ShopChrome>
  );
}

export default function SearchClient() {
  return (
    <Suspense fallback={<SearchFallback />}>
      <SearchContent />
    </Suspense>
  );
}
