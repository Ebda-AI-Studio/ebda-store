'use client';

import { useT } from '@/i18n/useT';
import type { CouponStatusFilter } from './types';

interface CouponsFiltersProps {
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  filterActive: CouponStatusFilter;
  onFilterActiveChange: (value: CouponStatusFilter) => void;
  onSubmitSearch: () => void;
}

/**
 * Search input + status select for the coupons list.
 */
export function CouponsFilters({
  searchTerm,
  onSearchTermChange,
  filterActive,
  onFilterActiveChange,
  onSubmitSearch,
}: CouponsFiltersProps) {
  const t = useT('coupons.filters');

  return (
    <div className="flex gap-4 items-center">
      <div className="flex-1">
        <input
          type="text"
          placeholder={t('searchPlaceholder')}
          value={searchTerm}
          onChange={e => onSearchTermChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmitSearch()}
          className="w-full max-w-md px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
        />
      </div>
      <select
        value={filterActive}
        onChange={e => onFilterActiveChange(e.target.value as CouponStatusFilter)}
        aria-label={t('statusAriaLabel')}
        className="px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
      >
        <option value="all">{t('statusAll')}</option>
        <option value="active">{t('statusActive')}</option>
        <option value="inactive">{t('statusInactive')}</option>
      </select>
    </div>
  );
}
