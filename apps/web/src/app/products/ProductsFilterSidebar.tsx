'use client';

import { useEffect, useState } from 'react';
import type { Category, PaginationMeta } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

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
}

const SEARCH_DEBOUNCE_MS = 300;

export function ProductsFilterSidebar({
  search,
  categoryFilter,
  categories,
  meta,
  language,
  onSearchChange,
  onCategoryChange,
  onClearAll,
  onSearchSubmit,
}: ProductsFilterSidebarProps) {
  const { t } = useLanguage();

  // Local controlled value for the input. Submitting via Enter still works,
  // but we also fire `onSearchChange` after 300ms of keystroke stillness
  // so listings update without requiring a click on a Search button.
  const [localSearch, setLocalSearch] = useState(search);
  const debouncedSearch = useDebouncedValue(localSearch, SEARCH_DEBOUNCE_MS);

  // Keep local state aligned when parent resets the search (e.g. "Clear all")
  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  // Push debounced changes back up to the parent. The empty-string update is
  // important so clearing the input refilters immediately on debounce tick.
  useEffect(() => {
    if (debouncedSearch !== search) {
      onSearchChange(debouncedSearch);
    }
    // We deliberately exclude `search` and `onSearchChange` from deps —
    // the effect's job is to fire on local changes only; including parent
    // values causes a feedback loop with the prop-sync effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  return (
    <aside className="w-full shrink-0 lg:w-64">
      <div className="sticky top-24 space-y-6">
        {/* Search */}
        <form onSubmit={onSearchSubmit}>
          <label
            htmlFor="products-search"
            className="mb-2 block text-sm font-medium text-foreground"
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
              id="products-search"
              type="text"
              placeholder={t('Search products...', 'ابحث عن المنتجات...')}
              value={localSearch}
              onChange={e => setLocalSearch(e.target.value)}
              className="search-input"
            />
          </div>
        </form>

        {/* Categories */}
        <div>
          <h3 className="mb-3 text-sm font-medium text-foreground">
            {t('Categories', translations['Categories'])}
          </h3>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => onCategoryChange('')}
              aria-pressed={!categoryFilter}
              className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-sm transition-all ${
                !categoryFilter
                  ? 'bg-primary text-white shadow-md shadow-primary/25'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <span>{t('All', '\u0627\u0644\u0643\u0644')}</span>
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
                  onClick={() => onCategoryChange(cat.slug)}
                  aria-pressed={categoryFilter === cat.slug}
                  className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-sm transition-all ${
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

        {/* Clear Filters */}
        <button
          type="button"
          onClick={onClearAll}
          className="w-full rounded-xl border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          {t(
            'Clear All Filters',
            '\u0645\u0633\u062d \u062c\u0645\u064a\u0639 \u0627\u0644\u0641\u0644\u0627\u062a\u0631'
          )}
        </button>
      </div>
    </aside>
  );
}
