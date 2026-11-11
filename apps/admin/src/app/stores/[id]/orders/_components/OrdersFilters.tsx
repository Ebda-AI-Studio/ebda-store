'use client';

import { useT } from '@/i18n/useT';
import { STATUS_FILTERS, type StatusFilter } from './types';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
interface OrdersFiltersProps {
  statusFilter: StatusFilter;
  onStatusFilterChange: (status: StatusFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

export function OrdersFilters({
  statusFilter,
  onStatusFilterChange,
  search,
  onSearchChange,
}: OrdersFiltersProps) {
  const t = useT('orders.list');

  return (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-1 rounded-xl bg-muted p-1 overflow-x-auto">
        {STATUS_FILTERS.map(status => (
          <Button
            type="button"
            key={status}
            onClick={() => onStatusFilterChange(status)}
            variant={statusFilter === status ? 'soft' : 'ghost'}
            size="sm"
            className="whitespace-nowrap"
          >
            {t(`filters.${status}`)}
          </Button>
        ))}
      </div>

      <div className="relative w-full sm:w-72">
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
        <input
          type="text"
          placeholder={t('search.placeholder')}
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          className={FIELD_CLASSES}
        />
      </div>
    </div>
  );
}
