'use client';

import { Input } from '@force/ui';
import { useT } from '@/i18n/useT';
import type { StatusFilter } from './types';

interface ProductFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit: (e: React.FormEvent) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (status: StatusFilter) => void;
}

const STATUS_VALUES: StatusFilter[] = ['all', 'active', 'draft', 'archived'];

export function ProductFilters({
  search,
  onSearchChange,
  onSearchSubmit,
  statusFilter,
  onStatusFilterChange,
}: ProductFiltersProps) {
  const t = useT('products.list.filters');

  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-2">
        <div className="relative">
          <svg
            className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
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
          <form onSubmit={onSearchSubmit}>
            <Input
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={e => onSearchChange(e.target.value)}
              className="w-64 ps-9"
            />
          </form>
        </div>
      </div>

      <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
        {STATUS_VALUES.map(s => (
          <button
            type="button"
            key={s}
            onClick={() => onStatusFilterChange(s)}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-all duration-200 ${
              statusFilter === s
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(s)}
          </button>
        ))}
      </div>
    </div>
  );
}
