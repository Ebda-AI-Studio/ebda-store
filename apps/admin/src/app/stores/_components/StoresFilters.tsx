'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { StatusFilterPills } from '@/components/StatusFilterPills';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface StoresFiltersProps {
  search: string;
  setSearch: (val: string) => void;
  statusFilter: string;
  setStatusFilter: (val: string) => void;
  viewMode: 'grid' | 'table';
  setViewMode: (mode: 'grid' | 'table') => void;
  onSearchSubmit: (e: React.FormEvent) => void;
}

const STATUS_KEYS: Array<{
  value: string;
  labelKey: 'filterAll' | 'filterActive' | 'filterInactive' | 'filterSuspended';
}> = [
  { value: 'all', labelKey: 'filterAll' },
  { value: 'active', labelKey: 'filterActive' },
  { value: 'inactive', labelKey: 'filterInactive' },
  { value: 'suspended', labelKey: 'filterSuspended' },
];

export function StoresFilters({
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  viewMode,
  setViewMode,
  onSearchSubmit,
}: StoresFiltersProps) {
  const t = useT('stores.list');

  return (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <form onSubmit={onSearchSubmit} className="flex flex-1 gap-3">
        <div className="relative flex-1 max-w-md">
          <svg
            className="absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
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
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={FIELD_CLASSES}
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          {t('search')}
        </Button>
      </form>

      <div className="flex items-center gap-3">
        {/* Status Filter Pills */}
        <div className="hidden sm:block">
          <StatusFilterPills
            ariaLabel={t('filterStatusLabel')}
            options={STATUS_KEYS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
            value={statusFilter}
            onChange={setStatusFilter}
            className="flex items-center gap-1 rounded-xl bg-muted/50 p-1"
          />
        </div>

        {/* Mobile Status Dropdown */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label={t('filterStatusLabel')}
          className={`${FIELD_CLASSES} sm:hidden`}
        >
          <option value="all">{t('filterAllStatus')}</option>
          <option value="active">{t('filterActive')}</option>
          <option value="inactive">{t('filterInactive')}</option>
          <option value="suspended">{t('filterSuspended')}</option>
        </select>

        {/* View Toggle */}
        <div className="flex items-center gap-1 rounded-xl bg-muted/50 p-1">
          <Button
            variant={viewMode === 'grid' ? 'soft' : 'ghost'}
            size="icon-sm"
            type="button"
            onClick={() => setViewMode('grid')}
            title={t('gridView')}
            aria-label={t('gridView')}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
              />
            </svg>
          </Button>
          <Button
            variant={viewMode === 'table' ? 'soft' : 'ghost'}
            size="icon-sm"
            type="button"
            onClick={() => setViewMode('table')}
            title={t('tableView')}
            aria-label={t('tableView')}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 10h16M4 14h16M4 18h16"
              />
            </svg>
          </Button>
        </div>
      </div>
    </div>
  );
}
