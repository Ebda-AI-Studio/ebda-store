'use client';

import { useEffect, useState } from 'react';
import type { Category, PaginationMeta } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

interface SortOption {
  value: string;
  label: string;
}

interface ProductsFilterSidebarProps {
  search: string;
  categoryFilter: string;
  categories: Category[];
  meta: PaginationMeta | null;
  language: string;
  onSearchChange: (value: string) => void;
  onCategoryChange: (slug: string) => void;
  onClearAll: () => void;
  onSearchSubmit: (e: React.FormEvent) => void;
  /** Sort state — when omitted the sidebar hides its sort section. */
  sortBy?: string;
  sortOptions?: SortOption[];
  onSortChange?: (value: string) => void;
  /** Price range state in MAJOR currency units (KD, USD…), not fils. */
  priceMin?: number;
  priceMax?: number;
  /** Lower bound that the data could possibly contain (data-driven, not hardcoded). */
  priceFloor?: number;
  /** Upper bound that the data could possibly contain. */
  priceCeil?: number;
  onPriceChange?: (min: number, max: number) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export function ProductsFilterSidebar(props: ProductsFilterSidebarProps) {
  const {
    search,
    categoryFilter,
    categories,
    meta,
    language,
    onSearchChange,
    onCategoryChange,
    onClearAll,
    onSearchSubmit,
    sortBy,
    sortOptions,
    onSortChange,
    priceMin,
    priceMax,
    priceFloor,
    priceCeil,
    onPriceChange,
  } = props;
  const { t } = useLanguage();

  // Local controlled value for the input. Submitting via Enter still works,
  // but we also fire `onSearchChange` after 300ms of keystroke stillness
  // so listings update without requiring a click on a Search button.
  const [localSearch, setLocalSearch] = useState(search);
  const debouncedSearch = useDebouncedValue(localSearch, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  useEffect(() => {
    if (debouncedSearch !== search) {
      onSearchChange(debouncedSearch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Mobile renders a slide-up bottom-sheet with backdrop (Pecannbee spec § 4.4).
  // Desktop renders inline as a sticky sidebar.
  const [isOpen, setIsOpen] = useState(false);

  // Lock background scroll while the bottom-sheet is open.
  useEffect(() => {
    if (!isOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [isOpen]);

  const activeFilterCount = (search.trim() ? 1 : 0) + (categoryFilter ? 1 : 0);

  // Close-and-act helpers — when the user picks an option inside the mobile
  // sheet, we close it so they see the filtered results immediately.
  const closeAfter =
    <T extends unknown[]>(fn: ((...args: T) => void) | undefined) =>
    (...args: T) => {
      fn?.(...args);
      setIsOpen(false);
    };

  // Render the body once per surface so we don't try to share DOM nodes
  // between the desktop sidebar and the mobile sheet.
  const renderBody = (mobile: boolean) => (
    <>
      {sortOptions && onSortChange && (
        <div>
          <label
            htmlFor={`products-sort-${mobile ? 'm' : 'd'}`}
            className="mb-2 block text-base lg:text-lg font-medium text-foreground"
          >
            {t('Sort by', 'ترتيب')}
          </label>
          <select
            id={`products-sort-${mobile ? 'm' : 'd'}`}
            value={sortBy ?? ''}
            onChange={e => onSortChange(e.target.value)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-base text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:text-sm"
          >
            {sortOptions.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm lg:text-base font-semibold text-foreground">
          {t('Filters', 'فلاتر')}
        </h3>
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs lg:text-sm font-medium text-primary hover:underline"
        >
          {t('Remove filters', 'إزالة الفلاتر')}
        </button>
      </div>

      {onPriceChange &&
        priceFloor !== undefined &&
        priceCeil !== undefined &&
        priceMin !== undefined &&
        priceMax !== undefined && (
          <div>
            <h3 className="mb-3 text-lg font-medium text-foreground">
              {t('Price range', 'مجال السعر')}
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs lg:text-sm text-muted-foreground">
                <span>
                  {priceMin.toFixed(3)} {t('KWD', 'د.ك')}
                </span>
                <span>
                  {priceMax.toFixed(3)} {t('KWD', 'د.ك')}
                </span>
              </div>
              <div className="relative h-1.5 rounded-full bg-muted">
                <div
                  className="absolute h-full rounded-full bg-primary"
                  style={{
                    insetInlineStart: `${
                      ((priceMin - priceFloor) / Math.max(1, priceCeil - priceFloor)) * 100
                    }%`,
                    insetInlineEnd: `${
                      ((priceCeil - priceMax) / Math.max(1, priceCeil - priceFloor)) * 100
                    }%`,
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="range"
                  min={priceFloor}
                  max={priceCeil}
                  step={0.5}
                  value={priceMin}
                  onChange={e => {
                    const v = Math.min(Number(e.target.value), priceMax);
                    onPriceChange(v, priceMax);
                  }}
                  className="w-full accent-primary"
                  aria-label={t('Minimum price', 'الحد الأدنى للسعر')}
                />
                <input
                  type="range"
                  min={priceFloor}
                  max={priceCeil}
                  step={0.5}
                  value={priceMax}
                  onChange={e => {
                    const v = Math.max(Number(e.target.value), priceMin);
                    onPriceChange(priceMin, v);
                  }}
                  className="w-full accent-primary"
                  aria-label={t('Maximum price', 'الحد الأقصى للسعر')}
                />
              </div>
            </div>
          </div>
        )}

      <form onSubmit={mobile ? closeAfter(onSearchSubmit) : onSearchSubmit}>
        <label
          htmlFor={`products-search-${mobile ? 'm' : 'd'}`}
          className="mb-2 block text-base lg:text-lg font-medium text-foreground"
        >
          {t('Search', translations['Search'])}
        </label>
        <div className="search-box">
          <svg
            className="h-5 w-5 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            id={`products-search-${mobile ? 'm' : 'd'}`}
            type="text"
            placeholder={t('Search products...', 'ابحث عن المنتجات...')}
            value={localSearch}
            onChange={e => setLocalSearch(e.target.value)}
            className="search-input"
          />
        </div>
      </form>

      <div>
        <h3 className="mb-3 text-lg font-medium text-foreground">
          {t('Categories', translations['Categories'])}
        </h3>
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => (mobile ? closeAfter(onCategoryChange)('') : onCategoryChange(''))}
            aria-pressed={!categoryFilter}
            className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-base lg:text-lg transition-all ${
              !categoryFilter
                ? 'bg-primary text-white shadow-md shadow-primary/25'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <span>{t('All', 'الكل')}</span>
            {meta && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  !categoryFilter ? 'bg-white/20' : 'bg-background'
                }`}
              >
                {meta.total}
              </span>
            )}
          </button>
          {categories
            .filter(cat => cat.slug)
            .map(cat => (
              <button
                key={cat.id}
                type="button"
                onClick={() =>
                  mobile ? closeAfter(onCategoryChange)(cat.slug) : onCategoryChange(cat.slug)
                }
                aria-pressed={categoryFilter === cat.slug}
                className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-base lg:text-lg transition-all ${
                  categoryFilter === cat.slug
                    ? 'bg-primary text-white shadow-md shadow-primary/25'
                    : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <span>{language === 'ar' && cat.nameAr ? cat.nameAr : cat.name}</span>
                {cat.productCount !== undefined && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      categoryFilter === cat.slug ? 'bg-white/20' : 'bg-background'
                    }`}
                  >
                    {cat.productCount}
                  </span>
                )}
              </button>
            ))}
        </div>
      </div>

      {/* Clear-filters button doubles as the bottom action on desktop;
          mobile has its own primary "View results" CTA in the sheet footer. */}
      {!mobile && (
        <button
          type="button"
          onClick={onClearAll}
          className="w-full rounded-xl border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          {t('Clear All Filters', 'مسح جميع الفلاتر')}
        </button>
      )}
    </>
  );

  return (
    // data-zone="filters" lets the merchant set typography
    // (size / colour / family) on the entire filter sidebar
    // independently of the broader "Products" zone — sort dropdown,
    // search input, price range labels, category chips, mobile sheet
    // trigger, the lot.
    <aside className="w-full shrink-0 lg:w-64" data-zone="filters">
      {/* Mobile trigger — opens the bottom-sheet. */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className="lg:hidden mb-4 flex h-11 w-full items-center justify-between rounded-xl border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
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
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-white">
              {activeFilterCount}
            </span>
          )}
        </span>
      </button>

      {/* Mobile bottom-sheet (spec § 4.4). Rendered into the regular tree —
          z-50 + fixed positioning is enough for our z stack here, no portal
          needed. Tapping the backdrop closes; tapping inside doesn't. */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 lg:hidden animate-in fade-in duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="products-filter-sheet-title"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="max-h-[85vh] overflow-hidden rounded-t-3xl bg-background shadow-2xl flex flex-col animate-in slide-in-from-bottom duration-300"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex flex-col items-center bg-background pt-3 pb-2 shrink-0">
              <span className="h-1 w-12 rounded-full bg-muted-foreground/30" aria-hidden />
              <div className="mt-2 flex w-full items-center justify-between px-5">
                <h2
                  id="products-filter-sheet-title"
                  className="text-base font-semibold text-foreground"
                >
                  {t('Filters', 'فلاتر')}
                </h2>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-muted"
                  aria-label={t('Close', 'إغلاق')}
                >
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-6">{renderBody(true)}</div>

            <div className="border-t border-border bg-background px-5 py-3 shrink-0">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t('View results', 'عرض النتائج')}
                {meta && <span className="ms-2 opacity-80">({meta.total})</span>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Desktop inline sidebar */}
      <div id="products-filter-panel" className="hidden lg:block lg:sticky lg:top-24 space-y-6">
        {renderBody(false)}
      </div>
    </aside>
  );
}
