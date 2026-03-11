'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { api, type Category, type Product } from '@/lib/api';
import { Select } from '@force/ui';
import { Header, Footer } from '../../components';
import { useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { trackSearch } from '../../components/MarketingPixels';

const sortValues = ['newest', 'price-asc', 'price-desc', 'name-asc'] as const;

type SortValue = (typeof sortValues)[number];

/** Build sort options with translated labels */
function getSortOptions(t: (en: string, ar: string) => string) {
  return [
    { value: 'newest' as const, label: t('Newest', '\u0627\u0644\u0623\u062d\u062f\u062b') },
    {
      value: 'price-asc' as const,
      label: t(
        'Price: Low to High',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0642\u0644 \u0644\u0644\u0623\u0639\u0644\u0649'
      ),
    },
    {
      value: 'price-desc' as const,
      label: t(
        'Price: High to Low',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0639\u0644\u0649 \u0644\u0644\u0623\u0642\u0644'
      ),
    },
    {
      value: 'name-asc' as const,
      label: t('Name A-Z', '\u0627\u0644\u0627\u0633\u0645 \u0623-\u064a'),
    },
  ];
}

/** Sort products client-side so the UI responds instantly. */
function sortProducts(products: Product[], sortBy: SortValue): Product[] {
  const copy = [...products];
  switch (sortBy) {
    case 'price-asc':
      return copy.sort((a, b) => a.price - b.price);
    case 'price-desc':
      return copy.sort((a, b) => b.price - a.price);
    case 'name-asc':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'newest':
    default:
      return copy.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        return 0;
      });
  }
}

function SearchContent() {
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const searchParams = useSearchParams();

  // Derive initial values from URL params for shareability
  const committedQuery = searchParams?.get('q') || '';
  const committedCategory = searchParams?.get('category') || '';
  const committedSort = (searchParams?.get('sort') as SortValue | null) || 'newest';

  const [searchTerm, setSearchTerm] = useState(committedQuery);
  const [categoryFilter, setCategoryFilter] = useState(committedCategory);
  const [sortBy, setSortBy] = useState<SortValue>(committedSort);

  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      } else {
        setError(response.error?.message || 'Failed to search products');
      }
    } catch {
      setError('Unable to search. Please check your connection and try again.');
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
    }
  }, [committedQuery, committedCategory, committedSort, performSearch]);

  /** Update URL params so filters are shareable / back-button-friendly. */
  function pushParams(term: string, category: string, sort: SortValue) {
    const params = new URLSearchParams();
    if (term) params.set('q', term);
    if (category) params.set('category', category);
    if (sort && sort !== 'newest') params.set('sort', sort);
    router.push(storeUrl(`/search?${params.toString()}`));
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
  const products = sortProducts(filtered, sortBy);

  const displayQuery = committedQuery || searchTerm;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 flex-1">
        <h1 className="text-3xl font-bold mb-6">
          {t(
            'Search Products',
            '\u0627\u0644\u0628\u062d\u062b \u0639\u0646 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
          )}
        </h1>

        {/* Search form */}
        <form onSubmit={handleSearch} role="search" className="mb-6">
          <div className="flex gap-3 max-w-2xl">
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={t(
                'Search for products...',
                '\u0627\u0644\u0628\u062d\u062b \u0639\u0646 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a...'
              )}
              className="flex-1 px-4 py-3 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
            />
            <button
              type="submit"
              className="px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium"
            >
              {t('Search', translations['Search'])}
            </button>
          </div>
        </form>

        {/* Filter & Sort bar */}
        {(categories.length > 0 || committedQuery) && (
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl bg-muted/30 p-4">
            {categories.length > 0 && (
              <div className="flex items-center gap-2">
                <Select
                  id="search-category"
                  label={t('Category:', '\u0627\u0644\u0641\u0626\u0629:')}
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
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <Select
                id="search-sort"
                label={t('Sort by:', '\u062a\u0631\u062a\u064a\u0628 \u062d\u0633\u0628:')}
                value={sortBy}
                onChange={e => handleSortChange(e.target.value as SortValue)}
                options={getSortOptions(t).map(opt => ({ value: opt.value, label: opt.label }))}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {categoryFilter && (
              <button
                onClick={() => handleCategoryChange('')}
                className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
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
          <div role="alert" className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5 text-red-500 flex-shrink-0"
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
              <p className="text-red-700 flex-1">{error}</p>
              <button
                onClick={() => performSearch(committedQuery, categoryFilter)}
                className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
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
              {products.length} {t('result', '\u0646\u062a\u064a\u062c\u0629')}
              {products.length !== 1 ? t('s', '') : ''} {t('for', '\u0644\u0640')} &quot;
              {displayQuery}&quot;
              {categoryFilter && (
                <>
                  {' '}
                  {t('in', '\u0641\u064a')}{' '}
                  <span className="font-medium text-foreground">
                    {categories.find(c => c.id === categoryFilter)?.name ?? categoryFilter}
                  </span>
                </>
              )}
            </p>
            <div role="list" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {products.map(product => (
                <div key={product.id} role="listitem">
                  <Link
                    href={storeUrl(`/products/${product.slug}`)}
                    className="group rounded-2xl border border-border bg-card overflow-hidden hover:shadow-lg transition-shadow block"
                  >
                    <div className="aspect-square bg-gradient-to-br from-primary/5 to-primary/10 relative overflow-hidden">
                      {product.images?.[0]?.url ? (
                        <Image
                          src={product.images[0].url}
                          alt={product.images[0].alt || product.name}
                          width={500}
                          height={500}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                          <svg
                            className="w-12 h-12"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                            />
                          </svg>
                        </div>
                      )}
                      {product.compareAtPrice && product.compareAtPrice > product.price && (
                        <span className="absolute top-2 left-2 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                          Sale
                        </span>
                      )}
                    </div>
                    <div className="p-4">
                      {product.categories?.[0] && (
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                          {product.categories[0].category?.name}
                        </p>
                      )}
                      <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-2">
                        {product.name}
                      </h3>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="font-bold text-lg text-primary">
                          {(product.price / 1000).toFixed(3)} KWD
                        </span>
                        {product.compareAtPrice && product.compareAtPrice > product.price && (
                          <span className="text-muted-foreground line-through text-sm">
                            {(product.compareAtPrice / 1000).toFixed(3)} KWD
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
          </>
        )}

        {/* No results */}
        {!isLoading && !error && committedQuery && products.length === 0 && (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-3">
              {t(
                'No products found for',
                '\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0645\u0646\u062a\u062c\u0627\u062a \u0644\u0640'
              )}{' '}
              &quot;{committedQuery}
              &quot;
              {categoryFilter
                ? t(
                    ' in the selected category',
                    ' \u0641\u064a \u0627\u0644\u0641\u0626\u0629 \u0627\u0644\u0645\u062d\u062f\u062f\u0629'
                  )
                : ''}
            </p>
            {categoryFilter && (
              <button
                onClick={() => handleCategoryChange('')}
                className="block mx-auto mb-3 text-sm text-primary hover:underline"
              >
                {t(
                  'Clear category filter',
                  '\u0645\u0633\u062d \u0641\u0644\u062a\u0631 \u0627\u0644\u0641\u0626\u0629'
                )}
              </button>
            )}
            <Link href={storeUrl('/products')} className="text-primary hover:underline text-sm">
              {t(
                'Browse all products',
                '\u062a\u0635\u0641\u062d \u0643\u0644 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
              )}
            </Link>
          </div>
        )}

        {/* Empty state when no query entered yet */}
        {!isLoading && !error && !committedQuery && (
          <div className="text-center py-12">
            <svg
              className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4"
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
                '\u0623\u062f\u062e\u0644 \u0643\u0644\u0645\u0629 \u0628\u062d\u062b \u0623\u0639\u0644\u0627\u0647 \u0644\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a \u062d\u0633\u0628 \u0627\u0644\u0627\u0633\u0645 \u0623\u0648 \u0627\u0644\u0648\u0635\u0641 \u0623\u0648 \u0627\u0644\u0641\u0626\u0629.'
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
      <Footer />
    </main>
  );
}

export default function SearchClient() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen flex-col bg-background">
          <Header />
          <div className="container mx-auto px-4 py-8 flex-1">
            <h1 className="text-3xl font-bold mb-8">Search</h1>
            <div className="animate-pulse bg-muted h-12 max-w-2xl rounded-lg" />
          </div>
          <Footer />
        </main>
      }
    >
      <SearchContent />
    </Suspense>
  );
}
