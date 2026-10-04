'use client';

import { pickLocalizedName } from '../../templates/shared/display-helpers';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  api,
  type Product,
  type Category,
  type PaginationMeta,
  type ProductFacet,
} from '@/lib/api';
import type {
  ProductCardDefaults,
  FilterSidebarSettings,
  ProductsPageSettings,
} from '@force/shared';
import { resolveColor, colorToHslTriplet } from '@force/shared';
import { pageSurfaceStyle } from '@/lib/page-surface';
import { useToast } from '@force/ui';
import { useCart } from '../../contexts/CartContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { ShopChrome } from '../../components';
import { toggleCompare } from '@/lib/compare';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { toTemplateProduct } from '../../templates/adapters';
import { PecannbeeProductCard } from '../../templates/shared/PecannbeeProductCard';
import { gridGapClass } from '../../templates/shared/card-size';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import { ProductListItem } from './ProductListItem';
import { ProductsFilterSidebar } from './ProductsFilterSidebar';
import { ProductsPagination } from './ProductsPagination';
import { recordLastListing, consumeFocusProduct } from '@/lib/last-listing';

import { roundToMinor } from '@force/shared';
/**
 * How many products the user can choose to load per PLP page. Capped at 96
 * because larger pages start to hurt mobile data + LCP without much UX win.
 */
/** Price-filter slider range, in MAJOR units (EGP). Not a data scale — a UX bound. */
const PRICE_SLIDER_MAX = 5000;
const PRICE_SLIDER_STEP = 10;

const PER_PAGE_OPTIONS: readonly number[] = [12, 24, 48, 96];

/** Sort option labels are translated at render time via the t() helper */
function getSortOptions(t: (en: string, ar: string) => string) {
  return [
    // Default = the merchant's curated per-category order. Sends NO sort/featured
    // param so the API uses the ProductCategory.position path (all products in the
    // store's chosen order). MUST stay first + be the default \u2014 a category browse
    // should show the whole category, not a filtered collection.
    {
      value: 'default',
      label: t('Recommended', '\u0627\u0644\u0645\u064f\u0648\u0635\u0649 \u0628\u0647'),
    },
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
  /** Filter sidebar merchant preferences (enabled toggle + defaultOpen). */
  filterSidebar?: FilterSidebarSettings;
  /** Products listing page settings (bgColor, etc.) from the merchant's layout settings. */
  productsPage?: ProductsPageSettings;
}

export default function ProductsClient({
  initialCategories = [],
  initialProducts = [],
  initialMeta = null,
  productCardDefaults,
  filterSidebar,
  productsPage,
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
    const allowed = new Set([
      'default',
      'newest',
      'price-asc',
      'price-desc',
      'featured',
      'best_seller',
    ]);
    // Default to the merchant's curated order ('default') so a plain category /
    // all-products browse shows EVERY product, not the new-arrivals filter that
    // 'newest' applies. Homepage carousel deep-links (?sort=newest / ?sort=best_seller)
    // still pass through the allow-list and filter as before.
    return fromUrl && allowed.has(fromUrl) ? fromUrl : 'default';
  });
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);
  // How many products to load per page. The user can pick from a small
  // allow-list (12 / 24 / 48 / 96); we persist their choice to localStorage
  // so it survives reloads but never trust it blindly — anything outside the
  // allow-list falls back to 96 (default: show all items).
  const [perPage, setPerPage] = useState<number>(() => {
    if (typeof window === 'undefined') return 96;
    const stored = Number(window.localStorage.getItem('plp-per-page'));
    return PER_PAGE_OPTIONS.includes(stored) ? stored : 96;
  });

  // Price range in MAJOR units (EGP). 0–5000 EGP covers most catalogue SKUs;
  // see PRICE_SLIDER_MAX.
  const [priceMin, setPriceMin] = useState(0);
  const [priceMax, setPriceMax] = useState(PRICE_SLIDER_MAX);

  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [meta, setMeta] = useState<PaginationMeta | null>(initialMeta);
  const [isLoading, setIsLoading] = useState(!initialProducts.length);
  /** Facets returned by the API alongside products — option name → distinct values. */
  const [facets, setFacets] = useState<ProductFacet[]>([]);
  /**
   * Active option filter selections: option name → Set of selected values.
   * Serialised to URL as ?opt_<name>=val1,val2 and to API as optionFilters.
   * Read from URL on mount so deep links work.
   */
  const [optionFilters, setOptionFilters] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    searchParams.forEach((val, key) => {
      if (key.startsWith('opt_') && val) {
        const optName = key.slice(4);
        if (optName) {
          const vals = val
            .split(',')
            .map(v => v.trim())
            .filter(Boolean);
          if (vals.length > 0) initial[optName] = vals;
        }
      }
    });
    return initial;
  });
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

  // Resolve productCardDefaults typography zones for PLP cards. The global
  // zones are not accessible from this client component (they're emitted as
  // CSS in layout.tsx), so we pass undefined for the global zone arg — same
  // pattern as HomePageContent.tsx. When no per-section override is set,
  // resolveSectionZone returns undefined and PecannbeeProductCard falls back
  // to its pack-styles CSS classes (no inline style applied).
  const plpProductNameZone = resolveSectionZone(
    productCardDefaults?.typography?.productName,
    undefined,
    store.theme
  );
  const plpProductPriceZone = resolveSectionZone(
    productCardDefaults?.typography?.productPrice,
    undefined,
    store.theme
  );
  const plpProductCtaZone = resolveSectionZone(
    productCardDefaults?.typography?.productCta,
    undefined,
    store.theme
  );

  // Products-list page typography (page-builder → Products list page).
  const plpHeadingZone = resolveSectionZone(
    productsPage?.typography?.heading,
    undefined,
    store.theme
  );
  const plpSubtitleZone = resolveSectionZone(
    productsPage?.typography?.subtitle,
    undefined,
    store.theme
  );
  const plpScale = pageTextScale(productsPage?.textScale);
  const plpDensity = pageDensityStyle(productsPage?.density);

  // PLP text color overrides — breadcrumb, heading, subheading.
  // Resolved from token:* or hex; undefined when unset → falls back to Tailwind class.
  const plpBreadcrumbColorStyle = store.theme?.plpBreadcrumbColor
    ? { color: resolveColor(store.theme.plpBreadcrumbColor, store.theme) ?? undefined }
    : undefined;
  const plpHeadingColorStyle = store.theme?.plpHeadingColor
    ? { color: resolveColor(store.theme.plpHeadingColor, store.theme) ?? undefined }
    : undefined;
  const plpSubheadingColorStyle = store.theme?.plpSubheadingColor
    ? { color: resolveColor(store.theme.plpSubheadingColor, store.theme) ?? undefined }
    : undefined;

  // Task 7: derive active category context for breadcrumb / H1 / subtitle.
  const activeCategory = categoryFilter ? categories.find(c => c.slug === categoryFilter) : null;
  const ctxEn =
    categoryFilter === 'best-sellers' ? 'Best Sellers' : (activeCategory?.name ?? 'All Products');
  const ctxAr =
    categoryFilter === 'best-sellers'
      ? 'الأكثر مبيعاً'
      : (pickLocalizedName(activeCategory, true) ?? translations['All Products']);
  // Arabic reads "تصفح الدراجية" (with the definite article ال), not "تصفح دراجية".
  // Prepend ال for the subtitle phrase unless the name already carries it.
  const ctxArDefinite = ctxAr.startsWith('ال') ? ctxAr : `ال${ctxAr}`;

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

  // Record this listing page as the shopper's last-browsed category/PLP so
  // the "Continue Shopping" button in the cart can return them here.
  // We capture pathname+search (store-relative) on mount; the storeUrl() call
  // in useLastListing re-applies the correct prefix at read time.
  useEffect(() => {
    const path = window.location.pathname + window.location.search;
    // Strip the platform slug prefix (/<slug>/...) to store a store-relative path.
    // useStoreUrl() will re-apply it when the href is built in useLastListing.
    const storePrefix = store?.slug && store.id !== 'demo' ? `/${store.slug}` : '';
    const relative =
      storePrefix && path.startsWith(storePrefix) ? path.slice(storePrefix.length) : path;
    recordLastListing(store?.id, relative || '/products');
  }, [store?.id, store?.slug]);

  // Focus-scroll: when the shopper returns from cart via "Continue Shopping",
  // scroll their previously-added product into view and briefly highlight it.
  // consumeFocusProduct reads + clears the sessionStorage key atomically so
  // the highlight fires only once. We wait until loading is done and products
  // are rendered before attempting the scroll (the DOM node must exist).
  useEffect(() => {
    if (isLoading || products.length === 0) return;

    const focusId = consumeFocusProduct(store?.id);
    if (!focusId) return;

    // rAF gives React one frame to flush the card DOM nodes before we query
    // them. Even if the product isn't on this page the effect fails gracefully
    // (no node → no scroll, no error).
    const rafId = requestAnimationFrame(() => {
      const el = document.getElementById(`product-${focusId}`);
      if (!el) return;

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Temporary highlight ring: add a CSS class, then remove it after
      // the animation completes. Uses a Tailwind-compatible ring so it
      // respects the store's --primary token. RTL-safe (ring has no dir dependency).
      el.classList.add('focus-product-ring');
      setTimeout(() => {
        el.classList.remove('focus-product-ring');
      }, 2000);
    });

    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, products, store?.id]);

  // Track previous filter values to detect filter changes vs. page changes.
  // perPage is treated as a filter so increasing it snaps the user back to
  // page 1 (otherwise they could land on an out-of-range page when the new
  // page count drops).
  const prevFiltersRef = useRef({
    search,
    categoryFilter,
    sortBy,
    priceMin,
    priceMax,
    perPage,
    optionFilters,
  });

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
        // API stores prices as integer piastres — multiply major units by 1000.
        // Skip the bound when it equals the slider's natural rest position so
        // we don't restrict the result set unnecessarily.
        if (priceMin > 0) params.minPrice = String(roundToMinor(priceMin));
        if (priceMax < PRICE_SLIDER_MAX) params.maxPrice = String(roundToMinor(priceMax));

        // Pass active option filters — API serialises them to ?opt_<name>=val1,val2
        const activeOptionFilters =
          Object.keys(optionFilters).length > 0 ? optionFilters : undefined;

        const response = await api.getProducts(params, activeOptionFilters);
        if (response.success && response.data) {
          setProducts(response.data.products || []);
          setMeta(response.data.meta || null);
          // Update facets from the latest response so they stay in sync with
          // the current category / price / search context.
          setFacets(response.data.facets || []);
        } else {
          setError(response.error?.message || 'LOAD_FAILED');
        }
      } catch {
        setError('CONNECTION_ERROR');
      } finally {
        setIsLoading(false);
      }
    },
    [search, categoryFilter, sortBy, priceMin, priceMax, perPage, optionFilters]
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
      prev.perPage !== perPage ||
      // Deep-compare the option filters object so a toggle triggers a page-1 reset.
      JSON.stringify(prev.optionFilters) !== JSON.stringify(optionFilters);

    if (filtersChanged) {
      prevFiltersRef.current = {
        search,
        categoryFilter,
        sortBy,
        priceMin,
        priceMax,
        perPage,
        optionFilters,
      };
      // Reset page to 1 and fetch with page 1 in a single pass
      setPage(1);
      fetchProducts(1);
    } else {
      fetchProducts(page);
    }
  }, [
    page,
    search,
    categoryFilter,
    sortBy,
    priceMin,
    priceMax,
    perPage,
    optionFilters,
    fetchProducts,
  ]);

  const handleAddToCart = (product: Product, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({
      id: product.id,
      name: product.name,
      nameAr: product.nameAr ?? undefined,
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

  /**
   * Toggle a single option value in/out of the active filter selection.
   * Multiple values for the same option = OR; toggling a value that's already
   * selected removes it. Removes the option name key entirely when no values
   * remain selected (keeps the object clean and the cache key short).
   */
  const handleOptionToggle = useCallback((optionName: string, value: string) => {
    setOptionFilters(prev => {
      const existing = prev[optionName] ?? [];
      const isSelected = existing.includes(value);
      const next = isSelected ? existing.filter(v => v !== value) : [...existing, value];
      if (next.length === 0) {
        const { [optionName]: _removed, ...rest } = prev;
        void _removed;
        return rest;
      }
      return { ...prev, [optionName]: next };
    });
  }, []);

  const handleClearAll = () => {
    setSearch('');
    setCategoryFilter('');
    setSortBy('default');
    setPriceMin(0);
    setPriceMax(100);
    setOptionFilters({});
  };

  return (
    <ShopChrome>
      <div
        className="flex-1"
        style={pageSurfaceStyle(productsPage?.bgColor, store.theme, productsPage?.colorScheme)}
      >
        {/* data-zone="products" wraps the entire listing — header h1 +
          breadcrumb + filter sidebar (sort, price range, search,
          category chips) + product grid + counter — so the merchant's
          "Products" zone typography settings cascade to every text
          element on this page in one shot. */}
        <div
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8"
          style={plpDensity}
          data-zone="products"
        >
          {/* Breadcrumb */}
          <nav
            className="mb-6 flex items-center gap-2 text-sm text-muted-foreground"
            style={{ ...zoneStyle(plpSubtitleZone, plpScale), ...plpBreadcrumbColorStyle }}
          >
            <Link href={storeUrl('/')} className="transition-colors hover:text-primary">
              {t('Home', translations['Home'])}
            </Link>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {categoryFilter && (
              <>
                <Link
                  href={storeUrl('/products')}
                  onClick={() => setCategoryFilter('')}
                  className="transition-colors hover:text-primary"
                >
                  {t('Products', translations['Products'])}
                </Link>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </>
            )}
            <span
              className="text-foreground"
              style={{ ...zoneStyle(plpSubtitleZone, plpScale), ...plpBreadcrumbColorStyle }}
            >
              {t(ctxEn, ctxAr)}
            </span>
          </nav>

          {/* Header */}
          <div className="mb-8">
            <h1
              className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl"
              style={{ ...zoneStyle(plpHeadingZone, plpScale), ...plpHeadingColorStyle }}
            >
              {t(ctxEn, ctxAr)}
            </h1>
            <p
              className="mt-2 text-muted-foreground"
              style={{ ...zoneStyle(plpSubtitleZone, plpScale), ...plpSubheadingColorStyle }}
            >
              {categoryFilter
                ? t(`Browse ${ctxEn}`, `\u062a\u0635\u0641\u062d ${ctxArDefinite}`)
                : t(
                    'Browse our collection of premium products',
                    '\u062a\u0635\u0641\u062d \u0645\u062c\u0645\u0648\u0639\u062a\u0646\u0627 \u0645\u0646 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a \u0627\u0644\u0645\u0645\u064a\u0632\u0629'
                  )}
            </p>
          </div>

          <div className="flex flex-col gap-8 lg:flex-row">
            {/* Sidebar Filters — hidden when merchant sets filterSidebar.enabled = false.
              defaultOpen drives the initial collapsed/open state on desktop. */}
            {filterSidebar?.enabled !== false && (
              <div className="flex shrink-0 flex-col gap-4 lg:w-72">
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
                  resultCount={products.length}
                  isLoading={isLoading}
                  perPage={perPage}
                  perPageOptions={PER_PAGE_OPTIONS}
                  onPerPageChange={next => {
                    if (PER_PAGE_OPTIONS.includes(next)) {
                      setPerPage(next);
                      if (typeof window !== 'undefined') {
                        window.localStorage.setItem('plp-per-page', String(next));
                      }
                    }
                  }}
                  priceMin={priceMin}
                  priceMax={priceMax}
                  priceFloor={0}
                  priceCeil={PRICE_SLIDER_MAX}
                  priceStep={PRICE_SLIDER_STEP}
                  onPriceChange={(min, max) => {
                    setPriceMin(min);
                    setPriceMax(max);
                  }}
                  facets={facets}
                  optionFilters={optionFilters}
                  onOptionToggle={handleOptionToggle}
                  defaultOpen={filterSidebar?.defaultOpen}
                  bgTriplet={
                    filterSidebar?.bgColor
                      ? colorToHslTriplet(filterSidebar.bgColor, store.theme) || undefined
                      : undefined
                  }
                  fgTriplet={
                    filterSidebar?.textColor
                      ? colorToHslTriplet(filterSidebar.textColor, store.theme) || undefined
                      : undefined
                  }
                />
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
            )}

            {/* Products Grid */}
            <div className="flex-1">
              {/* Error State */}
              {error && (
                <div
                  role="alert"
                  className="mb-6 rounded-xl border border-destructive/30 bg-destructive/10 p-4"
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
                    <p className="text-destructive-ink flex-1">
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
                      className="px-3 py-1 text-sm bg-destructive/20 text-destructive-ink rounded hover:bg-destructive/30"
                    >
                      {t('Retry', 'إعادة المحاولة')}
                    </button>
                  </div>
                </div>
              )}

              {/* Loading State */}
              {isLoading && (
                <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 lg:gap-6 xl:grid-cols-5 2xl:grid-cols-6">
                  {[...Array(12)].map((_, i) => (
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
                  className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 ${productCardDefaults?.cardGap ? gridGapClass(productCardDefaults.cardGap) : 'gap-3 sm:gap-4 lg:gap-6'}`}
                  dir={language === 'ar' ? 'rtl' : 'ltr'}
                >
                  {products.map((p, i) => (
                    // id="product-{id}" anchors the focus-scroll that fires
                    // when the shopper returns from cart via "Continue Shopping"
                    // after adding this product on the PDP.
                    <div key={p.id} id={`product-${p.id}`}>
                      <PecannbeeProductCard
                        key={p.id}
                        // First row(s) are above the fold — eager-load + preload
                        // their images to improve LCP (audit). Rest stay lazy.
                        priority={i < 6}
                        // productCardDefaults override the "md" fallback when set.
                        // Per-section overrides don't apply on PLP; only the global
                        // defaults slot applies here (Sprint 4, 2026-05-18).
                        cardSize={productCardDefaults?.cardSize ?? 'md'}
                        cardAspect={productCardDefaults?.cardAspect}
                        cardShape={productCardDefaults?.cardShape}
                        showCardFrame={productCardDefaults?.showCardFrame}
                        cardFrameStyle={productCardDefaults?.cardFrameStyle}
                        cardFrameWidth={productCardDefaults?.cardFrameWidth}
                        cardFrameSize={productCardDefaults?.cardFrameSize}
                        cardFrameColor={productCardDefaults?.cardFrameColor}
                        showLabel={productCardDefaults?.showLabel}
                        showHover={productCardDefaults?.showHover}
                        cardImageAspect={productCardDefaults?.cardImageAspect}
                        cardImageRadius={productCardDefaults?.cardImageRadius}
                        showCardName={productCardDefaults?.showCardName}
                        showCardPrice={
                          store.theme?.showPriceOnCards === false
                            ? false
                            : productCardDefaults?.showCardPrice
                        }
                        productNameZone={plpProductNameZone}
                        productPriceZone={plpProductPriceZone}
                        productCtaZone={plpProductCtaZone}
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
                              nameAr: found.nameAr ?? undefined,
                              price: found.price,
                              slug: found.slug,
                              image: found.images?.[0]?.url,
                              category: found.categories?.[0]?.category?.name,
                            });
                        }}
                        urlPrefix={storeUrl('')}
                      />
                    </div>
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
                      showCardPrice={
                        store.theme?.showPriceOnCards === false
                          ? false
                          : productCardDefaults?.showCardPrice
                      }
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
                    onClick={handleClearAll}
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
      </div>
    </ShopChrome>
  );
}
