'use client';

import { useEffect, useState } from 'react';
import type { Category, PaginationMeta, ProductFacet } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useNumerals } from '../../hooks/useNumerals';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { buildSidebarVars, countActiveFilters } from './filter-sidebar-state';
import { localizeOptionName, localizeOptionValue } from '@/lib/option-localization';
import { Sheet } from '@/components/ui/Sheet';

import { REGION, roundToMinor } from '@ebda/shared';
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
  /**
   * Results summary + per-page control rendered INSIDE the filter panel (top
   * of body), so the shopper sees "showing X of Y" + "Show: N" when they open
   * the filters — instead of a separate bar above the grid. All optional; the
   * block hides when resultCount / onPerPageChange aren't provided.
   */
  resultCount?: number;
  isLoading?: boolean;
  perPage?: number;
  perPageOptions?: readonly number[];
  onPerPageChange?: (value: number) => void;
  /** Price range state in MAJOR currency units (EGP, USD…), not piastres. */
  priceMin?: number;
  priceMax?: number;
  /** Lower bound that the data could possibly contain (data-driven, not hardcoded). */
  priceFloor?: number;
  /** Upper bound that the data could possibly contain. */
  priceCeil?: number;
  /** Slider step in major units (default 1). */
  priceStep?: number;
  onPriceChange?: (min: number, max: number) => void;
  /**
   * Merchant-controlled initial open/collapsed state for the desktop sticky
   * sidebar. On mobile the sidebar is a slide-over bottom-sheet — it always
   * starts closed (the user taps the filter button to open it). On desktop
   * ≥lg the sidebar is always visible in the layout; `defaultOpen` controls
   * whether it starts in the expanded state. Defaults to true when undefined.
   */
  defaultOpen?: boolean;
  /**
   * Merchant-controlled background color for the WHOLE filter UI — desktop
   * panel, mobile trigger, AND the mobile bottom-sheet + every inner accent
   * (category chips, price slider, sort/search). Passed as an HSL TRIPLET
   * ("26 100% 50%", via `colorToHslTriplet(value, theme)`) and applied as a
   * local `--primary` override on the <aside>, so it cascades to every
   * descendant — including the fixed-position mobile sheet — and works with the
   * existing `hsl(var(--primary)/alpha)` shades. Undefined → inherits the
   * store's global `--primary` (existing look, no opt-in cost).
   */
  bgTriplet?: string;
  /**
   * Merchant-controlled text/icon color for the whole filter UI, as an HSL
   * triplet. Applied as a local `--primary-foreground` override on the
   * <aside>. Undefined → inherits the global `--primary-foreground`.
   */
  fgTriplet?: string;
  /**
   * Variant-option facets returned by the API. Each entry is one option axis
   * (e.g. "Size") with its available values. Renders as a collapsible group
   * below the price filter. Empty array → no facet groups rendered (stores
   * without options are visually identical to today).
   */
  facets?: ProductFacet[];
  /**
   * Currently selected option values per option name.
   * Keyed by option name (English), values are the selected strings.
   */
  optionFilters?: Record<string, string[]>;
  /**
   * Called when the shopper checks/unchecks a facet value.
   * Parent toggles the value in/out of optionFilters and triggers a refetch.
   */
  onOptionToggle?: (optionName: string, value: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * One variant-option facet axis (e.g. "Size") with a checkbox per value.
 *
 * Pulled out of ProductsFilterSidebar's render body: nesting facets.map inside
 * values.map inside the panel JSX was the depth-6 hot spot the code-health scan
 * flagged. Rendering is unchanged — same markup, same ids, same handlers.
 *
 * `surface` distinguishes the desktop sidebar from the mobile bottom-sheet so the
 * two copies of the panel never collide on checkbox ids / htmlFor pairs.
 */
function FacetGroup({
  facet,
  selectedValues,
  isArabic,
  surface,
  onOptionToggle,
}: {
  facet: ProductFacet;
  selectedValues: string[];
  isArabic: boolean;
  surface: 'm' | 'd';
  onOptionToggle?: (name: string, value: string) => void;
}) {
  const facetLabel = localizeOptionName(
    facet.name,
    facet.nameAr,
    isArabic,
    facet.values.map(v => v.value)
  );
  return (
    <div>
      <h3 className="mb-3 text-lg font-medium text-[hsl(var(--primary-foreground))]">
        {facetLabel}
      </h3>
      <div className="space-y-2">
        {facet.values.map(v => {
          const isChecked = selectedValues.includes(v.value);
          const valueLabel = localizeOptionValue(v.value, v.valueAr, isArabic);
          const checkboxId = `facet-${facet.name}-${v.value}-${surface}`;
          return (
            <label
              key={v.value}
              htmlFor={checkboxId}
              className={`flex cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-base transition-all ${
                isChecked
                  ? 'bg-[hsl(var(--primary-foreground)/0.2)] text-[hsl(var(--primary-foreground))] font-semibold'
                  : 'bg-[hsl(var(--primary-foreground)/0.08)] text-[hsl(var(--primary-foreground)/0.75)] hover:bg-[hsl(var(--primary-foreground)/0.15)] hover:text-[hsl(var(--primary-foreground))]'
              }`}
            >
              <input
                id={checkboxId}
                type="checkbox"
                checked={isChecked}
                onChange={() => {
                  // Multi-value facet — do NOT close the mobile sheet on each
                  // tick (shopper may pick several sizes). The "View results"
                  // button is the explicit done action.
                  onOptionToggle?.(facet.name, v.value);
                }}
                className="h-4 w-4 shrink-0 accent-[hsl(var(--primary-foreground))] rounded"
                aria-label={valueLabel}
              />
              <span>{valueLabel}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

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
    resultCount,
    isLoading,
    perPage,
    perPageOptions,
    onPerPageChange,
    priceMin,
    priceMax,
    priceFloor,
    priceCeil,
    priceStep = 1,
    onPriceChange,
    facets = [],
    optionFilters = {},
    onOptionToggle,
    defaultOpen,
    bgTriplet,
    fgTriplet,
  } = props;
  const { t } = useLanguage();
  const { localize, money } = useNumerals();

  const sidebarVars = buildSidebarVars(bgTriplet, fgTriplet);

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

  // Mobile renders a slide-up bottom-sheet with backdrop (Demo Store spec § 4.4).
  // Desktop renders inline as a sticky sidebar — merchant can set
  // filterSidebar.defaultOpen to start it collapsed.
  const [isOpen, setIsOpen] = useState(false);
  // Desktop expanded/collapsed state — initialised from the merchant's
  // filterSidebar.defaultOpen setting (defaults to open when unset).
  const [isDesktopExpanded, setIsDesktopExpanded] = useState(defaultOpen !== false);

  useBodyScrollLock(isOpen);

  const activeFilterCount = countActiveFilters(search, categoryFilter, optionFilters);

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
      {/* Results summary + per-page — shown at the top of the filter panel so
          it's visible the moment the shopper opens the filters. */}
      {(resultCount !== undefined || onPerPageChange) && (
        <div className="space-y-3 border-b border-[hsl(var(--primary-foreground)/0.2)] pb-4">
          {resultCount !== undefined && (
            <p className="text-sm text-[hsl(var(--primary-foreground)/0.8)]">
              {isLoading ? (
                t('Loading...', translations['Loading...'])
              ) : (
                <>
                  {t('Showing', 'عرض')}{' '}
                  <span className="font-medium text-[hsl(var(--primary-foreground))]">
                    {localize(resultCount)}
                  </span>{' '}
                  {meta ? t(`of ${meta.total}`, `من ${localize(meta.total)}`) : ''}{' '}
                  {t('products', 'منتجات')}
                </>
              )}
            </p>
          )}
          {onPerPageChange && perPageOptions && perPage !== undefined && (
            <div>
              <label
                htmlFor={`products-perpage-${mobile ? 'm' : 'd'}`}
                className="mb-2 block text-base lg:text-lg font-medium text-[hsl(var(--primary-foreground))]"
              >
                {t('Show:', 'عرض:')}
              </label>
              <select
                id={`products-perpage-${mobile ? 'm' : 'd'}`}
                value={String(perPage)}
                onChange={e => onPerPageChange(Number(e.target.value))}
                className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-base text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:text-sm"
              >
                {perPageOptions.map(n => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {sortOptions && onSortChange && (
        <div>
          <label
            htmlFor={`products-sort-${mobile ? 'm' : 'd'}`}
            className="mb-2 block text-base lg:text-lg font-medium text-[hsl(var(--primary-foreground))]"
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
        <h3 className="text-sm lg:text-base font-semibold text-[hsl(var(--primary-foreground))]">
          {t('Filters', 'فلاتر')}
        </h3>
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs lg:text-sm font-medium text-[hsl(var(--primary-foreground))] underline opacity-80 hover:opacity-100"
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
            <h3 className="mb-3 text-lg font-medium text-[hsl(var(--primary-foreground))]">
              {t('Price range', 'مجال السعر')}
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs lg:text-sm text-[hsl(var(--primary-foreground)/0.8)]">
                <span>
                  {money(roundToMinor(priceMin))}{' '}
                  {t(REGION.currencySymbol.en, REGION.currencySymbol.ar)}
                </span>
                <span>
                  {money(roundToMinor(priceMax))}{' '}
                  {t(REGION.currencySymbol.en, REGION.currencySymbol.ar)}
                </span>
              </div>
              <div className="relative h-1.5 rounded-full bg-[hsl(var(--primary-foreground)/0.25)]">
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
                  step={priceStep}
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
                  step={priceStep}
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

      {/* Variant-option facet groups — rendered only when the API returns facets.
          Zero facets = stores without options: no visual change. One group per
          option axis (e.g. "Size"), checkboxes for each value. */}
      {facets.map(facet => (
        <FacetGroup
          key={facet.name}
          facet={facet}
          selectedValues={optionFilters[facet.name] ?? []}
          isArabic={language === 'ar'}
          surface={mobile ? 'm' : 'd'}
          onOptionToggle={onOptionToggle}
        />
      ))}

      <form onSubmit={mobile ? closeAfter(onSearchSubmit) : onSearchSubmit}>
        <label
          htmlFor={`products-search-${mobile ? 'm' : 'd'}`}
          className="mb-2 block text-base lg:text-lg font-medium text-[hsl(var(--primary-foreground))]"
        >
          {t('Search', translations['Search'])}
        </label>
        <div className="search-box">
          <svg
            className="h-5 w-5 text-[hsl(var(--primary-foreground)/0.6)]"
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
        <h3 className="mb-3 text-lg font-medium text-[hsl(var(--primary-foreground))]">
          {t('Categories', translations['Categories'])}
        </h3>
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => (mobile ? closeAfter(onCategoryChange)('') : onCategoryChange(''))}
            aria-pressed={!categoryFilter}
            className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-base lg:text-lg transition-all ${
              !categoryFilter
                ? 'bg-[hsl(var(--primary-foreground)/0.2)] text-[hsl(var(--primary-foreground))] font-semibold'
                : 'bg-[hsl(var(--primary-foreground)/0.08)] text-[hsl(var(--primary-foreground)/0.75)] hover:bg-[hsl(var(--primary-foreground)/0.15)] hover:text-[hsl(var(--primary-foreground))]'
            }`}
          >
            <span>{t('All', 'الكل')}</span>
            {meta && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  !categoryFilter
                    ? 'bg-[hsl(var(--primary-foreground)/0.2)]'
                    : 'bg-[hsl(var(--primary-foreground)/0.12)]'
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
                    ? 'bg-[hsl(var(--primary-foreground)/0.2)] text-[hsl(var(--primary-foreground))] font-semibold'
                    : 'bg-[hsl(var(--primary-foreground)/0.08)] text-[hsl(var(--primary-foreground)/0.75)] hover:bg-[hsl(var(--primary-foreground)/0.15)] hover:text-[hsl(var(--primary-foreground))]'
                }`}
              >
                <span>{language === 'ar' && cat.nameAr ? cat.nameAr : cat.name}</span>
                {cat.productCount !== undefined && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      categoryFilter === cat.slug
                        ? 'bg-[hsl(var(--primary-foreground)/0.2)]'
                        : 'bg-[hsl(var(--primary-foreground)/0.12)]'
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
          className="w-full rounded-xl border border-[hsl(var(--primary-foreground)/0.3)] py-2.5 text-sm text-[hsl(var(--primary-foreground)/0.8)] transition-colors hover:bg-[hsl(var(--primary-foreground)/0.1)] hover:border-[hsl(var(--primary-foreground)/0.5)]"
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
    <aside
      className="w-full shrink-0 lg:w-64 lg:rounded-2xl lg:overflow-hidden lg:p-4 lg:bg-[hsl(var(--primary))] lg:text-[hsl(var(--primary-foreground))]"
      style={sidebarVars}
      data-zone="filters"
    >
      {/* Mobile trigger — opens the bottom-sheet. */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="products-filter-sheet"
        className="lg:hidden mb-4 flex h-11 w-full items-center justify-between rounded-xl bg-[hsl(var(--primary))] px-4 text-sm font-semibold text-[hsl(var(--primary-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.9)]"
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
            <span className="rounded-full bg-[hsl(var(--primary-foreground))] px-2 py-0.5 text-xs font-bold text-[hsl(var(--primary))]">
              {activeFilterCount}
            </span>
          )}
        </span>
      </button>

      {/* Mobile bottom-sheet (spec § 4.4) on the shared Sheet primitive (R-04):
          Escape, focus in/trap/return, scroll lock, a 44px close. */}
      <Sheet
        open={isOpen}
        onClose={() => setIsOpen(false)}
        side="bottom"
        id="products-filter-sheet"
        focusClose
        title={t('Filters', 'فلاتر')}
        closeLabel={t('Close', 'إغلاق')}
        className="bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] lg:hidden"
        titleClassName="text-base font-semibold text-[hsl(var(--primary-foreground))]"
        closeClassName="text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary-foreground)/0.15)]"
        bodyClassName="px-5 pb-4 space-y-6"
        footerClassName="border-t border-[hsl(var(--primary-foreground)/0.2)] px-5 py-3"
        footer={
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('View results', 'عرض النتائج')}
            {meta && <span className="ms-2 opacity-80">({meta.total})</span>}
          </button>
        }
      >
        {renderBody(true)}
      </Sheet>

      {/* Desktop inline sidebar — collapsible via the header button. Initial
          open state driven by the merchant's filterSidebar.defaultOpen setting. */}
      <div id="products-filter-panel" className="hidden lg:block lg:sticky lg:top-24">
        {/* Collapse toggle header */}
        <button
          type="button"
          onClick={() => setIsDesktopExpanded(v => !v)}
          aria-expanded={isDesktopExpanded}
          aria-controls="products-filter-panel-body"
          className="mb-4 flex w-full items-center justify-between text-sm font-semibold text-[hsl(var(--primary-foreground))] hover:text-[hsl(var(--primary-foreground)/0.7)] transition-colors"
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
          </span>
          <svg
            className={`h-4 w-4 transition-transform duration-200 ${isDesktopExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {isDesktopExpanded && (
          <div id="products-filter-panel-body" className="space-y-6">
            {renderBody(false)}
          </div>
        )}
      </div>
    </aside>
  );
}
