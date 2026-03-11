'use client';

import type { Category, PaginationMeta } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';

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

  return (
    <aside className="w-full shrink-0 lg:w-64">
      <div className="sticky top-24 space-y-6">
        {/* Search */}
        <form onSubmit={onSearchSubmit}>
          <label className="mb-2 block text-sm font-medium text-foreground">
            {t('Search', translations['Search'])}
          </label>
          <div className="search-box">
            <svg
              className="h-5 w-5 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              placeholder="Search products..."
              value={search}
              onChange={e => onSearchChange(e.target.value)}
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
              onClick={() => onCategoryChange('')}
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
                  onClick={() => onCategoryChange(cat.slug)}
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
