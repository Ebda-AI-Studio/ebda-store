'use client';

import { useMemo } from 'react';
import { useT } from '@/i18n/useT';
import { StatusFilterPills } from '../../../../../components/StatusFilterPills';
import { SearchInput } from '../../../../../components/SearchInput';
import type { StatusFilter } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface ProductFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (status: StatusFilter) => void;
  categoryFilter: string;
  categoryOptions: { value: string; label: string }[];
  onCategoryFilterChange: (categoryId: string) => void;
}

const STATUS_VALUES: StatusFilter[] = ['all', 'active', 'draft', 'archived'];

export function ProductFilters({
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  categoryFilter,
  categoryOptions,
  onCategoryFilterChange,
}: ProductFiltersProps) {
  const t = useT('products.list.filters');

  // Options depend on translation state so we memoize them; keeping the
  // array reference stable also keeps StatusFilterPills' effect deps tidy.
  const options = useMemo(() => STATUS_VALUES.map(v => ({ value: v, label: t(v) })), [t]);

  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-2">
        {/* Shared debounced search — same component the Inventory page uses. */}
        <SearchInput
          value={search}
          onSearch={onSearchChange}
          placeholder={t('searchPlaceholder')}
        />
        {categoryOptions.length > 0 && (
          <select
            value={categoryFilter}
            onChange={e => onCategoryFilterChange(e.target.value)}
            aria-label={t('categoryAriaLabel')}
            className={FIELD_CLASSES}
          >
            <option value="">{t('allCategories')}</option>
            {categoryOptions.map(c => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <StatusFilterPills
        ariaLabel={t('ariaLabel')}
        options={options}
        value={statusFilter}
        onChange={onStatusFilterChange}
      />
    </div>
  );
}
