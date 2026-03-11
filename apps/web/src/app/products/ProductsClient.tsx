'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, type Product, type Category, type PaginationMeta } from '@/lib/api';
import { useToast, Select } from '@force/ui';
import { useCart } from '../../contexts/CartContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { Header, Footer } from '../../components';
import { toggleCompare } from '@/lib/compare';
import { ProductGridCard } from './ProductGridCard';
import { ProductListItem } from './ProductListItem';
import { ProductsFilterSidebar } from './ProductsFilterSidebar';
import { ProductsPagination } from './ProductsPagination';

/** Sort option labels are translated at render time via the t() helper */
function getSortOptions(t: (en: string, ar: string) => string) {
  return [
    { value: 'featured', label: t('Featured', '\u0645\u0645\u064a\u0632') },
    { value: 'newest', label: t('Newest', '\u0627\u0644\u0623\u062d\u062f\u062b') },
    {
      value: 'price-asc',
      label: t(
        'Price: Low to High',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0642\u0644 \u0644\u0644\u0623\u0639\u0644\u0649'
      ),
    },
    {
      value: 'price-desc',
      label: t(
        'Price: High to Low',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0639\u0644\u0649 \u0644\u0644\u0623\u0642\u0644'
      ),
    },
  ];
}

function ProductSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-border bg-card overflow-hidden">
      <div className="aspect-square bg-muted" />
      <div className="p-4 space-y-3">
        <div className="h-3 w-16 rounded bg-muted" />
        <div className="h-4 w-3/4 rounded bg-muted" />
        <div className="h-3 w-20 rounded bg-muted" />
        <div className="h-5 w-24 rounded bg-muted" />
      </div>
    </div>
  );
}

interface ProductsClientProps {
  initialCategories?: Category[];
  initialProducts?: Product[];
  initialMeta?: PaginationMeta | null;
}

export default function ProductsClient({
  initialCategories = [],
  initialProducts = [],
  initialMeta = null,
}: ProductsClientProps) {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '');
  const [sortBy, setSortBy] = useState('newest');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);

  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [meta, setMeta] = useState<PaginationMeta | null>(initialMeta);
  const [isLoading, setIsLoading] = useState(!initialProducts.length);
  const [error, setError] = useState<string | null>(null);
  // Track which product ids are in the compare list so buttons re-render on change
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const { addItem } = useCart();
  const { language, t } = useLanguage();
  const { warning } = useToast();
  const sortOptions = getSortOptions(t);

  // Sync compare state from localStorage on mount (client-only)
  useEffect(() => {
    const ids = new Set(
      (() => {
        try {
          const raw = localStorage.getItem('compareProducts');
          return raw ? (JSON.parse(raw) as Array<{ id: string }>).map(p => p.id) : [];
        } catch {
          return [];
        }
      })()
    );
    setCompareIds(ids);
  }, []);

  // Track previous filter values to detect filter changes vs. page changes
  const prevFiltersRef = useRef({ search, categoryFilter, sortBy });

  const fetchProducts = useCallback(
    async (targetPage: number) => {
      setIsLoading(true);
      setError(null);
      try {
        const params: Record<string, string> = {
          page: String(targetPage),
          limit: '12',
        };
        if (search) params.search = search;
        if (categoryFilter) params.category = categoryFilter;
        if (sortBy === 'newest') params.sort = 'newest';
        if (sortBy === 'price-asc') params.sort = 'price_asc';
        if (sortBy === 'price-desc') params.sort = 'price_desc';
        if (sortBy === 'featured') params.featured = 'true';

        const response = await api.getProducts(params);
        if (response.success && response.data) {
          setProducts(response.data.products || []);
          setMeta(response.data.meta || null);
        } else {
          setError(response.error?.message || 'Failed to load products');
        }
      } catch {
        setError('Unable to load products. Please check your connection.');
      } finally {
        setIsLoading(false);
      }
    },
    [search, categoryFilter, sortBy]
  );

  const fetchCategories = useCallback(async () => {
    try {
      const response = await api.getCategories();
      if (response.success && response.data) {
        setCategories(response.data.categories || []);
      }
    } catch {
      // Categories are non-critical, fail silently
    }
  }, []);

  useEffect(() => {
    // Skip if categories were provided via server-side props
    if (initialCategories.length === 0) {
      fetchCategories();
    }
  }, [fetchCategories, initialCategories.length]);

  // Single effect handles both filter changes and page changes.
  // When filters change, reset to page 1 and fetch once (no cascading re-render).
  // When only page changes, fetch the requested page directly.
  useEffect(() => {
    const prev = prevFiltersRef.current;
    const filtersChanged =
      prev.search !== search || prev.categoryFilter !== categoryFilter || prev.sortBy !== sortBy;

    if (filtersChanged) {
      prevFiltersRef.current = { search, categoryFilter, sortBy };
      // Reset page to 1 and fetch with page 1 in a single pass
      setPage(1);
      fetchProducts(1);
    } else {
      fetchProducts(page);
    }
  }, [page, search, categoryFilter, sortBy, fetchProducts]);

  const handleAddToCart = (product: Product, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({
      id: product.id,
      name: product.name,
      price: product.price,
      slug: product.slug,
      image: product.images?.[0]?.url,
      category: product.categories?.[0]?.category?.name,
    });
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchProducts(1);
  };

  const handleToggleCompare = (product: Product, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const result = toggleCompare({
      id: product.id,
      name: product.name,
      slug: product.slug,
      price: product.price,
      compareAtPrice: product.compareAtPrice,
      images: product.images?.map(img => img.url) ?? [],
    });
    if (result === 'max_reached') {
      warning(
        'Compare Limit',
        t(
          'You can compare up to 4 products at a time. Remove one to add another.',
          '\u064a\u0645\u0643\u0646\u0643 \u0645\u0642\u0627\u0631\u0646\u0629 \u0645\u0627 \u064a\u0635\u0644 \u0625\u0644\u0649 4 \u0645\u0646\u062a\u062c\u0627\u062a. \u0623\u0632\u0644 \u0648\u0627\u062d\u062f\u064b\u0627 \u0644\u0625\u0636\u0627\u0641\u0629 \u0622\u062e\u0631.'
        )
      );
      return;
    }
    // Update local state to reflect the new compare list
    setCompareIds(prev => {
      const next = new Set(prev);
      if (result === 'added') {
        next.add(product.id);
      } else {
        next.delete(product.id);
      }
      return next;
    });
  };

  const handleClearAll = () => {
    setSearch('');
    setCategoryFilter('');
    setSortBy('newest');
  };

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />

      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/" className="transition-colors hover:text-primary">
            {t('Home', translations['Home'])}
          </Link>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-foreground">{t('Products', translations['Products'])}</span>
        </nav>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            {t('All Products', translations['All Products'])}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              'Browse our collection of premium products',
              '\u062a\u0635\u0641\u062d \u0645\u062c\u0645\u0648\u0639\u062a\u0646\u0627 \u0645\u0646 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a \u0627\u0644\u0645\u0645\u064a\u0632\u0629'
            )}
          </p>
        </div>

        <div className="flex flex-col gap-8 lg:flex-row">
          {/* Sidebar Filters */}
          <ProductsFilterSidebar
            search={search}
            categoryFilter={categoryFilter}
            categories={categories}
            meta={meta}
            language={language}
            onSearchChange={setSearch}
            onCategoryChange={setCategoryFilter}
            onClearAll={handleClearAll}
            onSearchSubmit={handleSearch}
          />

          {/* Products Grid */}
          <div className="flex-1">
            {/* Toolbar */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">
                {isLoading ? (
                  'Loading...'
                ) : (
                  <>
                    Showing <span className="font-medium text-foreground">{products.length}</span>{' '}
                    {meta ? `of ${meta.total}` : ''} products
                  </>
                )}
              </p>
              <div className="flex items-center gap-4">
                {/* Sort */}
                <div className="flex items-center gap-2">
                  <Select
                    label={t('Sort by:', '\u062a\u0631\u062a\u064a\u0628 \u062d\u0633\u0628:')}
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value)}
                    options={sortOptions.map(option => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                {/* View Mode */}
                <div className="hidden items-center gap-1 rounded-lg border border-border bg-background p-1 sm:flex">
                  <button
                    onClick={() => setViewMode('grid')}
                    aria-label={t('Grid view', '\u0639\u0631\u0636 \u0634\u0628\u0643\u064a')}
                    className={`rounded-md p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                  >
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
                        d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
                      />
                    </svg>
                    <span className="sr-only">
                      {t('Grid view', '\u0639\u0631\u0636 \u0634\u0628\u0643\u064a')}
                    </span>
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    aria-label={t('List view', '\u0639\u0631\u0636 \u0642\u0627\u0626\u0645\u0629')}
                    className={`rounded-md p-1.5 transition-colors ${viewMode === 'list' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                  >
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
                        d="M4 6h16M4 10h16M4 14h16M4 18h16"
                      />
                    </svg>
                    <span className="sr-only">
                      {t('List view', '\u0639\u0631\u0636 \u0642\u0627\u0626\u0645\u0629')}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Error State */}
            {error && (
              <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4">
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
                    onClick={() => fetchProducts(page)}
                    className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {/* Loading State */}
            {isLoading && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {[...Array(6)].map((_, i) => (
                  <ProductSkeleton key={i} />
                ))}
              </div>
            )}

            {/* Grid View */}
            {!isLoading && !error && viewMode === 'grid' && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {products.map((product, index) => (
                  <ProductGridCard
                    key={product.id}
                    product={product}
                    index={index}
                    isInCompare={compareIds.has(product.id)}
                    onToggleCompare={handleToggleCompare}
                    onAddToCart={handleAddToCart}
                  />
                ))}
              </div>
            )}

            {/* List View */}
            {!isLoading && !error && viewMode === 'list' && (
              <div className="space-y-4">
                {products.map(product => (
                  <ProductListItem
                    key={product.id}
                    product={product}
                    isInCompare={compareIds.has(product.id)}
                    onToggleCompare={handleToggleCompare}
                    onAddToCart={handleAddToCart}
                  />
                ))}
              </div>
            )}

            {/* No Results */}
            {!isLoading && !error && products.length === 0 && (
              <div className="py-16 text-center">
                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-muted">
                  <svg
                    className="h-10 w-10 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  {t(
                    'No products found',
                    '\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0645\u0646\u062a\u062c\u0627\u062a'
                  )}
                </h3>
                <p className="mt-1 text-muted-foreground">
                  {t(
                    'Try adjusting your search or filter criteria',
                    '\u062d\u0627\u0648\u0644 \u062a\u0639\u062f\u064a\u0644 \u0627\u0644\u0628\u062d\u062b \u0623\u0648 \u0645\u0639\u0627\u064a\u064a\u0631 \u0627\u0644\u062a\u0635\u0641\u064a\u0629'
                  )}
                </p>
                <button
                  onClick={() => {
                    setSearch('');
                    setCategoryFilter('');
                  }}
                  className="mt-4 rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
                >
                  {t(
                    'Clear Filters',
                    '\u0645\u0633\u062d \u0627\u0644\u0641\u0644\u0627\u062a\u0631'
                  )}
                </button>
              </div>
            )}

            {/* Pagination */}
            {meta && <ProductsPagination meta={meta} page={page} onPageChange={setPage} />}
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
