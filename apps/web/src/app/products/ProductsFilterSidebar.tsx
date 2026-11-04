'use client';

import { useEffect, useState } from 'react';
import type { Category, PaginationMeta, ProductFacet } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useNumerals } from '../../hooks/useNumerals';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { buildSidebarVars, countActiveFilters } from './filter-sidebar-state';
import { countText, ITEMS } from '../../lib/plural';
import { localizeOptionName, localizeOptionValue } from '@/lib/option-localization';
import { Sheet } from '@/components/ui/Sheet';
import { PriceRangeSlider } from './PriceRangeSlider';

import { roundToMinor } from '@ebda/shared';
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
   * panel, mobile trigger, AND the mobile bottom-sheet. Passed as an HSL TRIPLET
   * ("36 36% 52%", via `colorToHslTriplet(value, theme)`) and applied as a
   * local `--filter-bg` override on the <aside>, so it cascades to every
   * descendant — including the fixed-position mobile sheet. Undefined → the
   * quiet default from globals.css (`--filter-bg: var(--bg-page)`, Ruling B1-31);
   * the store's primary marks only the active state.
   */
  bgTriplet?: string;
  /**
   * Merchant-controlled text/icon color for the whole filter UI, as an HSL
   * triplet. Applied as a local `--filter-fg` override on the <aside>.
   * Undefined → `--filter-fg: var(--foreground)` (globals.css, B1-31).
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

/** One chip look for every filter value (facet value, category): a pill, 44 px tall, the active
 *  one filled with the store primary. Replaces full-width grey bars + 24 px checkboxes. */
const CHIP_BASE =
  'inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background cursor-pointer';
const CHIP_ON = 'filter-active border-primary bg-primary text-primary-foreground font-semibold';
const CHIP_OFF =
  'border-[hsl(var(--filter-fg)/0.2)] bg-transparent text-[hsl(var(--filter-fg)/0.9)] hover:border-[hsl(var(--filter-fg)/0.45)] hover:text-[hsl(var(--filter-fg))]';
const chip = (on: boolean) => `${CHIP_BASE} ${on ? CHIP_ON : CHIP_OFF}`;

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
      <h3 className="mb-3 text-base font-semibold text-[hsl(var(--filter-fg))]">{facetLabel}</h3>
      <div className="flex flex-wrap gap-2">
        {facet.values.map(v => {
          const isChecked = selectedValues.includes(v.value);
          const valueLabel = localizeOptionValue(v.value, v.valueAr, isArabic);
          const checkboxId = `facet-${facet.name}-${v.value}-${surface}`;
          return (
            <label key={v.value} htmlFor={checkboxId} className={chip(isChecked)}>
              {/* A real checkbox stays the control (keyboard, screen reader, label): the chip is
                  its skin. Multi-value facet: the sheet stays open per tick, "View results" is done. */}
              <input
                id={checkboxId}
                type="checkbox"
                checked={isChecked}
                onChange={() => onOptionToggle?.(facet.name, v.value)}
                className="sr-only"
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
  const { localize } = useNumerals();
  const money = useLocalePrice();

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
  // L-07: the one clear action shows only when something is filtered (a narrowed price too).
  const priceNarrowed =
    (priceMin !== undefined && priceFloor !== undefined && priceMin > priceFloor) ||
    (priceMax !== undefined && priceCeil !== undefined && priceMax < priceCeil);
  const activeCount = activeFilterCount + (categoryFilter ? 1 : 0) + (priceNarrowed ? 1 : 0);

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
        <div className="space-y-3 border-b border-[hsl(var(--filter-fg)/0.2)] pb-4">
          {resultCount !== undefined && (
            <p className="text-sm text-[hsl(var(--filter-fg)/0.8)]">
              {isLoading ? (
                t('Loading...', translations['Loading...'])
              ) : (
                <>
                  {t('Showing', 'عرض')}{' '}
                  <span className="font-medium text-[hsl(var(--filter-fg))]">
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
                className="mb-2 block text-base lg:text-lg font-medium text-[hsl(var(--filter-fg))]"
              >
                {t('Show:', 'عرض:')}
              </label>
              <select
                id={`products-perpage-${mobile ? 'm' : 'd'}`}
                value={String(perPage)}
                onChange={e => onPerPageChange(Number(e.target.value))}
                className="min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2.5 text-base text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:text-sm"
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
            className="mb-2 block text-base lg:text-lg font-medium text-[hsl(var(--filter-fg))]"
          >
            {t('Sort by', 'ترتيب')}
          </label>
          <select
            id={`products-sort-${mobile ? 'm' : 'd'}`}
            value={sortBy ?? ''}
            onChange={e => onSortChange(e.target.value)}
            className="min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2.5 text-base text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:text-sm"
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
        <h2 className="text-sm lg:text-base font-semibold text-[hsl(var(--filter-fg))]">
          {t('Filters', 'الفلاتر')}
        </h2>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="min-h-11 text-sm font-medium text-[hsl(var(--filter-fg))] underline underline-offset-4"
          >
            {t('Remove filters', 'إزالة الفلاتر')}
          </button>
        )}
      </div>

      {onPriceChange &&
        priceFloor !== undefined &&
        priceCeil !== undefined &&
        priceMin !== undefined &&
        priceMax !== undefined && (
          <div>
            <h3 className="mb-3 text-base font-semibold text-[hsl(var(--filter-fg))]">
              {t('Price range', 'مجال السعر')}
            </h3>
            <PriceRangeSlider
              idPrefix={`price-${mobile ? 'm' : 'd'}`}
              floor={priceFloor}
              ceil={priceCeil}
              min={priceMin}
              max={priceMax}
              step={priceStep}
              onChange={onPriceChange}
              format={v => money(roundToMinor(v))}
              minLabel={t('Minimum price', 'الحد الأدنى للسعر')}
              maxLabel={t('Maximum price', 'الحد الأقصى للسعر')}
            />
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
          className="mb-2 block text-base lg:text-lg font-medium text-[hsl(var(--filter-fg))]"
        >
          {t('Search', translations['Search'])}
        </label>
        <div className="search-box">
          <svg
            className="h-5 w-5 text-[hsl(var(--filter-fg)/0.6)]"
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
        <h3 className="mb-3 text-base font-semibold text-[hsl(var(--filter-fg))]">
          {t('Categories', translations['Categories'])}
        </h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => (mobile ? closeAfter(onCategoryChange)('') : onCategoryChange(''))}
            aria-pressed={!categoryFilter}
            className={chip(!categoryFilter)}
          >
            <span>{t('All', 'الكل')}</span>
            {meta && (
              <span className="text-xs tabular-nums opacity-75">{localize(meta.total)}</span>
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
                className={chip(categoryFilter === cat.slug)}
              >
                <span>{language === 'ar' && cat.nameAr ? cat.nameAr : cat.name}</span>
                {cat.productCount !== undefined && (
                  <span className="text-xs tabular-nums opacity-75">
                    {localize(cat.productCount)}
                  </span>
                )}
              </button>
            ))}
        </div>
      </div>
    </>
  );

  return (
    // data-zone="filters" lets the merchant set typography
    // (size / colour / family) on the entire filter sidebar
    // independently of the broader "Products" zone — sort dropdown,
    // search input, price range labels, category chips, mobile sheet
    // trigger, the lot.
    <aside
      className="w-full shrink-0 lg:w-64 lg:rounded-[var(--radius)] lg:p-4 lg:sticky lg:top-[calc(var(--header-h,0px)+1rem)] lg:max-h-[calc(100dvh-var(--header-h,0px)-2rem)] lg:overflow-y-auto lg:border lg:border-[hsl(var(--filter-fg)/0.12)] lg:bg-[hsl(var(--filter-bg))] lg:text-[hsl(var(--filter-fg))]"
      style={sidebarVars}
      data-zone="filters"
      // merchant filter colours: the active chip gets an ink ring so it never blends into a
      // panel painted in the same colour as the store primary (review N3)
      data-filter-custom={sidebarVars ? '' : undefined}
    >
      {/* Mobile trigger row — the filter sheet, the item count and a sort (IA-11). */}
      <div className="lg:hidden mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls="products-filter-sheet"
          className="flex h-11 min-w-0 flex-1 items-center justify-between rounded-[var(--radius)] border border-input bg-[hsl(var(--filter-bg))] px-4 text-sm font-semibold text-[hsl(var(--filter-fg))] transition-colors hover:bg-[hsl(var(--filter-fg)/0.05)]"
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
              <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </span>
          {!isLoading && (meta?.total ?? resultCount) !== undefined && (
            <span
              data-filter-result-count
              className="text-xs font-normal text-[hsl(var(--filter-fg)/0.8)] tabular-nums"
            >
              {(() => {
                const n = meta?.total ?? resultCount ?? 0;
                return countText(language === 'ar' ? 'ar' : 'en', n, ITEMS, localize(n));
              })()}
            </span>
          )}
        </button>
        {sortOptions && onSortChange && (
          <>
            <label htmlFor="products-sort-bar" className="sr-only">
              {t('Sort by', 'ترتيب')}
            </label>
            <select
              id="products-sort-bar"
              value={sortBy ?? ''}
              onChange={e => onSortChange(e.target.value)}
              className="h-11 max-w-[45%] rounded-[var(--radius)] border border-input bg-[hsl(var(--filter-bg))] px-3 text-base sm:text-sm text-[hsl(var(--filter-fg))] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {sortOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Mobile bottom-sheet (spec § 4.4) on the shared Sheet primitive (R-04):
          Escape, focus in/trap/return, scroll lock, a 44px close. */}
      <Sheet
        open={isOpen}
        onClose={() => setIsOpen(false)}
        side="bottom"
        id="products-filter-sheet"
        focusClose
        title={t('Filters', 'الفلاتر')}
        closeLabel={t('Close', 'إغلاق')}
        className="bg-[hsl(var(--filter-bg))] text-[hsl(var(--filter-fg))] lg:hidden"
        titleClassName="text-base font-semibold text-[hsl(var(--filter-fg))]"
        closeClassName="text-[hsl(var(--filter-fg))] hover:bg-[hsl(var(--filter-fg)/0.15)]"
        bodyClassName="px-5 pb-4 space-y-6"
        footerClassName="border-t border-[hsl(var(--filter-fg)/0.2)] px-5 py-3"
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
      <div id="products-filter-panel" className="hidden lg:block">
        {/* Collapse toggle header */}
        <button
          type="button"
          onClick={() => setIsDesktopExpanded(v => !v)}
          aria-expanded={isDesktopExpanded}
          aria-controls="products-filter-panel-body"
          className="mb-4 flex min-h-11 w-full items-center justify-between text-sm font-semibold text-[hsl(var(--filter-fg))] hover:text-[hsl(var(--filter-fg)/0.7)] transition-colors"
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
