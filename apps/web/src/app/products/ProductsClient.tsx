'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, type Product, type Category, type PaginationMeta } from '@/lib/api';
import type { ProductCardDefaults } from '@force/shared';
import { useToast, Select } from '@force/ui';
import { useCart } from '../../contexts/CartContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { ShopChrome } from '../../components';
import { toggleCompare } from '@/lib/compare';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { toTemplateProduct } from '../../templates/adapters';
import { PecannbeeProductCard } from '../../templates/shared/PecannbeeProductCard';
import { ProductListItem } from './ProductListItem';
import { ProductsFilterSidebar } from './ProductsFilterSidebar';
import { ProductsPagination } from './ProductsPagination';

/**
 * How many products the user can choose to load per PLP page. Capped at 96
 * because larger pages start to hurt mobile data + LCP without much UX win.
 */
const PER_PAGE_OPTIONS: readonly number[] = [12, 24, 48, 96];

/** Sort option labels are translated at render time via the t() helper */
function getSortOptions(t: (en: string, ar: string) => string) {
  return [
    { value: 'featured', label: t('Featured', '\u0645\u0645\u064a\u0632') },
    { value: 'newest', label: t('Newest', '\u0627\u0644\u0623\u062d\u062f\u062b') },
    {
      value: 'best_seller',
      label: t(
        'Best sellers',
        '\u0627\u0644\u0623\u0643\u062b\u0631 \u0645\u0628\u064a\u0639\u0627\u064b'
      ),
    },
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
  /** Global product-card defaults from the merchant's layout settings. */
  productCardDefaults?: ProductCardDefaults;
}

export default function ProductsClient({
  initialCategories = [],
  initialProducts = [],
  initialMeta = null,
  productCardDefaults,
}: ProductsClientProps) {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '');
  // Honour the `?sort=` URL parameter on initial render so deep links from
  // the homepage carousels ("Newest" → /products?sort=newest, "Best
  // Sellers" → /products?sort=best_seller) actually filter the list.
  // Without this both links landed on the unsorted default and looked
  // identical to "see all products". Allow-list the supported values so
  // a junk param can't corrupt state.
  const [sortBy, setSortBy] = useState<string>(() => {
    const fromUrl = searchParams.get('sort');
    const allowed = new Set(['newest', 'price-asc', 'price-desc', 'featured', 'best_seller']);
    return fromUrl && allowed.has(fromUrl) ? fromUrl : 'newest';
  });
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);
  // How many products to load per page. The user can pick from a small
  // allow-list (12 / 24 / 48 / 96); we persist their choice to localStorage
  // so it survives reloads but never trust it blindly — anything outside the
  // allow-list falls back to 12 (Pecannbee default).
  const [perPage, setPerPage] = useState<number>(() => {
    if (typeof window === 'undefined') return 12;
    const stored = Number(window.localStorage.getItem('plp-per-page'));
    return PER_PAGE_OPTIONS.includes(stored) ? stored : 12;
  });

  // Price range in MAJOR units (KD). 0–100 KD covers most KW grocery / spice
  // SKUs; tenants with a wider catalog get the upper bound auto-extended on
  // the next render via the data-driven ceil below.
  const [priceMin, setPriceMin] = useState(0);
  const [priceMax, setPriceMax] = useState(100);

  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [meta, setMeta] = useState<PaginationMeta | null>(initialMeta);
  const [isLoading, setIsLoading] = useState(!initialProducts.length);
  const [error, setError] = useState<string | null>(null);
  // Track which product ids are in the compare list so buttons re-render on change
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const { addItem, items: cartItems } = useCart();
  const { language, t } = useLanguage();
  const { warning } = useToast();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { templateId } = useTemplateComponents();
  const sortOptions = getSortOptions(t);

  // Cart-id → quantity is consumed by ProductListItem (list view). The grid
  // view's PecannbeeProductCard handles its own optimistic add state.
  const cartQuantities = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const item of cartItems) map[item.productId] = item.quantity;
    return map;
  }, [cartItems]);
  void cartQuantities;

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

  // Track previous filter values to detect filter changes vs. page changes.
  // perPage is treated as a filter so increasing it snaps the user back to
  // page 1 (otherwise they could land on an out-of-range page when the new
  // page count drops).
  const prevFiltersRef = useRef({ search, categoryFilter, sortBy, priceMin, priceMax, perPage });

  const fetchProducts = useCallback(
    async (targetPage: number) => {
      setIsLoading(true);
      setError(null);
      try {
        const params: Record<string, string> = {
          page: String(targetPage),
          limit: String(perPage),
        };
        if (search) params.search = search;
        // `best-sellers` is a VIRTUAL category surfaced by the API
        // alongside the real categories — its membership is driven by
        // `Product.isBestSeller`, not by a ProductCategory link. So
        // when the URL says `?category=best-sellers`, translate that
        // into the API's `sort=best_seller` filter (which already
        // applies `where.isBestSeller=true` server-side) instead of
        // sending it as a category slug that the API would fail to
        // resolve.
        const isVirtualBestSellers = categoryFilter === 'best-sellers';
        if (categoryFilter && !isVirtualBestSellers) params.category = categoryFilter;
        if (sortBy === 'newest') params.sort = 'newest';
        if (sortBy === 'price-asc') params.sort = 'price_asc';
        if (sortBy === 'price-desc') params.sort = 'price_desc';
        if (sortBy === 'featured') params.featured = 'true';
        if (sortBy === 'best_seller' || isVirtualBestSellers) params.sort = 'best_seller';
        // API stores prices as integer fils — multiply major units by 1000.
        // Skip the bound when it equals the slider's natural rest position so
        // we don't restrict the result set unnecessarily.
        if (priceMin > 0) params.minPrice = String(Math.round(priceMin * 1000));
        if (priceMax < 100) params.maxPrice = String(Math.round(priceMax * 1000));

        const response = await api.getProducts(params);
        if (response.success && response.data) {
          setProducts(response.data.products || []);
          setMeta(response.data.meta || null);
        } else {
          setError(response.error?.message || 'LOAD_FAILED');
        }
      } catch {
        setError('CONNECTION_ERROR');
      } finally {
        setIsLoading(false);
      }
    },
    [search, categoryFilter, sortBy, priceMin, priceMax, perPage]
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
      prev.search !== search ||
      prev.categoryFilter !== categoryFilter ||
      prev.sortBy !== sortBy ||
      prev.priceMin !== priceMin ||
      prev.priceMax !== priceMax ||
      prev.perPage !== perPage;

    if (filtersChanged) {
      prevFiltersRef.current = {
        search,
        categoryFilter,
        sortBy,
        priceMin,
        priceMax,
        perPage,
      };
      // Reset page to 1 and fetch with page 1 in a single pass
      setPage(1);
      fetchProducts(1);
    } else {
      fetchProducts(page);
    }
  }, [page, search, categoryFilter, sortBy, priceMin, priceMax, perPage, fetchProducts]);

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
    setPriceMin(0);
    setPriceMax(100);
  };

  return (
    <ShopChrome>
      {/* data-zone="products" wraps the entire listing — header h1 +
          breadcrumb + filter sidebar (sort, price range, search,
          category chips) + product grid + counter — so the merchant's
          "Products" zone typography settings cascade to every text
          element on this page in one shot. */}
      <div
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8"
        data-zone="products"
      >
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
            sortBy={sortBy}
            sortOptions={sortOptions.map(o => ({ value: o.value, label: o.label }))}
            onSortChange={setSortBy}
            priceMin={priceMin}
            priceMax={priceMax}
            priceFloor={0}
            priceCeil={100}
            onPriceChange={(min, max) => {
              setPriceMin(min);
              setPriceMax(max);
            }}
          />

          {/* Products Grid */}
          <div className="flex-1">
            {/* Toolbar — always stacked rows (mobile pattern applied to
                desktop too, per Ahmad's 2026-05-16 standing rule 'apply
                mobile's fix to desktop'). Each filter occupies its own
                row so Arabic labels never truncate. The @force/ui Select
                wraps its <select> in a w-full div which made the older
                lg:flex-row layout fight itself — always-stacked sidesteps
                the wrapper issue entirely. */}
            <div className="mb-6 flex flex-col items-stretch gap-3 rounded-xl bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">
                {isLoading ? (
                  t('Loading...', translations['Loading...'])
                ) : (
                  <>
                    {t('Showing', 'عرض')}{' '}
                    <span className="font-medium text-foreground">{products.length}</span>{' '}
                    {meta ? t(`of ${meta.total}`, `من ${meta.total}`) : ''}{' '}
                    {t('products', 'منتجات')}
                  </>
                )}
              </p>
              <div className="flex w-full flex-col items-stretch gap-3">
                {/* Per-page — shoppers can see more products on a single
                    page instead of paginating. Allow-list capped at 96.
                    Persisted to localStorage. min-w-[6rem] reserves room
                    for any value 12/24/48/96. */}
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {t('Show:', 'عرض:')}
                  </span>
                  <Select
                    value={String(perPage)}
                    onChange={e => {
                      const next = Number(e.target.value);
                      if (PER_PAGE_OPTIONS.includes(next)) {
                        setPerPage(next);
                        if (typeof window !== 'undefined') {
                          window.localStorage.setItem('plp-per-page', String(next));
                        }
                      }
                    }}
                    options={PER_PAGE_OPTIONS.map(n => ({ value: String(n), label: String(n) }))}
                    className="h-11 min-w-[6rem] flex-1 rounded-lg border border-border bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                {/* Sort — min-w-[12rem] keeps room for the longest Arabic
                    label without truncation. */}
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {t('Sort by:', '\u062a\u0631\u062a\u064a\u0628 \u062d\u0633\u0628:')}
                  </span>
                  <Select
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value)}
                    options={sortOptions.map(option => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    className="h-11 min-w-[12rem] flex-1 rounded-lg border border-border bg-background px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                {/* View Mode */}
                <div className="hidden items-center gap-1 rounded-lg border border-border bg-background p-1 sm:flex">
                  <button
                    type="button"
                    aria-pressed={viewMode === 'grid'}
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
                    type="button"
                    aria-pressed={viewMode === 'list'}
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
              <div
                role="alert"
                className="mb-6 rounded-xl border border-destructive/30 bg-destructive/10 p-4"
              >
                <div className="flex items-center gap-3">
                  <svg
                    className="h-5 w-5 text-destructive flex-shrink-0"
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
                  <p className="text-destructive flex-1">
                    {error === 'LOAD_FAILED'
                      ? t('Failed to load products', 'فشل في تحميل المنتجات')
                      : error === 'CONNECTION_ERROR'
                        ? t(
                            'Unable to load products. Please check your connection.',
                            'تعذر تحميل المنتجات. يرجى التحقق من اتصالك.'
                          )
                        : error}
                  </p>
                  <button
                    type="button"
                    onClick={() => fetchProducts(page)}
                    className="px-3 py-1 text-sm bg-destructive/20 text-destructive rounded hover:bg-destructive/30"
                  >
                    {t('Retry', 'إعادة المحاولة')}
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

            {/* Grid View — Pecannbee-spec PLP card (sold-out ribbon, wishlist
                top-START, full-width pill CTA). 6 cols desktop / 3 tablet /
                2 mobile per spec § 4.4. The per-pack visual treatment comes
                from the `pack` prop (see templates/shared/pack-styles.ts). */}
            {!isLoading && !error && viewMode === 'grid' && (
              <div
                className="grid gap-4 grid-cols-2 sm:gap-5 md:grid-cols-3 lg:grid-cols-4 lg:gap-6 xl:grid-cols-5 2xl:grid-cols-6"
                dir={language === 'ar' ? 'rtl' : 'ltr'}
              >
                {products.map(p => (
                  <PecannbeeProductCard
                    key={p.id}
                    // productCardDefaults override the "md" fallback when set.
                    // Per-section overrides don't apply on PLP; only the global
                    // defaults slot applies here (Sprint 4, 2026-05-18).
                    cardSize={productCardDefaults?.cardSize ?? 'md'}
                    cardAspect={productCardDefaults?.cardAspect}
                    cardShape={productCardDefaults?.cardShape}
                    showCardFrame={productCardDefaults?.showCardFrame}
                    cardFrameStyle={productCardDefaults?.cardFrameStyle}
                    cardFrameWidth={productCardDefaults?.cardFrameWidth}
                    cardFrameColor={productCardDefaults?.cardFrameColor}
                    product={toTemplateProduct(p)}
                    isRtl={language === 'ar'}
                    currency={store.currency}
                    pack={templateId}
                    onAddToCart={async productId => {
                      const found = products.find(x => x.id === productId);
                      if (found)
                        addItem({
                          id: found.id,
                          name: found.name,
                          price: found.price,
                          slug: found.slug,
                          image: found.images?.[0]?.url,
                          category: found.categories?.[0]?.category?.name,
                        });
                    }}
                    urlPrefix={storeUrl('')}
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
                  type="button"
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
    </ShopChrome>
  );
}
