'use client';

import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { RateFilter, TaxRate } from './types';

interface TaxRatesTableProps {
  rates: TaxRate[];
  filter: RateFilter;
  taxEnabled: boolean;
  onFilterChange: (filter: RateFilter) => void;
  onAdd: () => void;
  onEdit: (rate: TaxRate) => void;
  onToggle: (rate: TaxRate) => void;
  onDelete: (rate: TaxRate) => void;
}

const FILTERS: RateFilter[] = ['all', 'active', 'inactive'];

/**
 * Tax rates list: header with add button, status filter pills, then a
 * `<DataTable>` that renders the rates as a desktop table or a mobile
 * card stack. All row-level actions stay delegated to the parent so it
 * still owns mutations.
 */
export function TaxRatesTable({
  rates,
  filter,
  taxEnabled,
  onFilterChange,
  onAdd,
  onEdit,
  onToggle,
  onDelete,
}: TaxRatesTableProps) {
  const t = useT('tax.rates');

  const columns: DataTableColumn<TaxRate>[] = [
    {
      header: t('columns.name'),
      primaryOnMobile: true,
      cell: rate => (
        <div>
          <div className="font-medium text-foreground">{rate.name}</div>
          {rate.nameAr && (
            <div className="text-sm text-muted-foreground font-arabic">{rate.nameAr}</div>
          )}
        </div>
      ),
    },
    {
      header: t('columns.rate'),
      cell: rate => <span className="font-medium text-foreground">{rate.rate}%</span>,
    },
    {
      header: t('columns.region'),
      cell: rate =>
        rate.country || rate.state ? (
          <div className="text-sm text-muted-foreground">
            {rate.country && <span className="uppercase">{rate.country}</span>}
            {rate.country && rate.state && <span> / </span>}
            {rate.state && <span>{rate.state}</span>}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{t('allRegions')}</span>
        ),
    },
    {
      header: t('columns.priority'),
      hideOnMobile: true,
      cell: rate => <span className="text-sm text-muted-foreground">{rate.priority}</span>,
    },
    {
      header: t('columns.type'),
      cell: rate => (
        <span className="px-2 py-1 rounded text-xs font-medium bg-info/10 text-info dark:bg-info/30 dark:text-info">
          {rate.isCompound ? t('types.compound') : t('types.standard')}
        </span>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: rate => (
        <button
          type="button"
          onClick={() => onToggle(rate)}
          className={`px-2 py-1 rounded-full text-xs font-medium ${
            rate.isActive
              ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {rate.isActive ? t('status.active') : t('status.inactive')}
        </button>
      ),
    },
    {
      header: t('columns.actions'),
      alignEnd: true,
      mobileActions: true,
      cell: rate => (
        <div className="flex items-center gap-2 md:justify-end">
          <button
            type="button"
            onClick={() => onEdit(rate)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-primary transition-colors"
            title={t('actions.edit')}
            aria-label={t('actions.edit')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onDelete(rate)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-destructive transition-colors"
            title={t('actions.delete')}
            aria-label={t('actions.delete')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        </div>
      ),
    },
  ];

  const emptyState = (
    <div className="bg-card rounded-xl border border-border p-12 text-center">
      <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
        <svg
          className="w-8 h-8 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{t('empty.title')}</h3>
      <p className="text-muted-foreground mb-6">
        {taxEnabled ? t('empty.enabled') : t('empty.disabled')}
      </p>
      {taxEnabled && (
        <button
          type="button"
          onClick={onAdd}
          className="px-4 py-2 min-h-11 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
        >
          {t('empty.createFirst')}
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-6 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onAdd}
            className="px-4 py-2 min-h-11 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50"
            disabled={!taxEnabled}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('addButton')}
          </button>
        </div>

        <div className="flex flex-wrap gap-2 p-4 bg-muted border-b border-border">
          {FILTERS.map(f => (
            <button
              type="button"
              key={f}
              onClick={() => onFilterChange(f)}
              className={`px-4 py-2 min-h-9 rounded-lg text-sm font-medium transition-colors ${
                filter === f
                  ? 'bg-primary text-white'
                  : 'bg-card text-foreground hover:bg-muted border border-border'
              }`}
            >
              {t(`filters.${f}`)}
            </button>
          ))}
        </div>
      </div>

      <DataTable<TaxRate>
        columns={columns}
        rows={rates}
        rowKey={r => r.id}
        emptyState={emptyState}
      />
    </div>
  );
}
