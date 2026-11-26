'use client';

import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { RateFilter, TaxRate } from './types';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
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
      header: t('columns.status'),
      mobileBadge: true,
      cell: rate => (
        <Button
          type="button"
          onClick={() => onToggle(rate)}
          variant={rate.isActive ? 'soft' : 'ghost'}
          size="sm"
        >
          {rate.isActive ? t('status.active') : t('status.inactive')}
        </Button>
      ),
    },
    {
      header: t('columns.actions'),
      alignEnd: true,
      mobileActions: true,
      cell: rate => (
        <div className="flex items-center gap-2 md:justify-end">
          <Button
            type="button"
            onClick={() => onEdit(rate)}
            title={t('actions.edit')}
            aria-label={t('actions.edit')}
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </Button>
          <Button
            type="button"
            onClick={() => onDelete(rate)}
            title={t('actions.delete')}
            aria-label={t('actions.delete')}
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </Button>
        </div>
      ),
    },
  ];

  const emptyState = (
    <EmptyState
      card
      icon="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
      title={t('empty.title')}
      description={taxEnabled ? t('empty.enabled') : t('empty.disabled')}
      action={taxEnabled ? { label: t('empty.createFirst'), onClick: onAdd } : undefined}
    />
  );

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-md border border-border overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-6 border-b border-border">
          <div>
            <h2 data-setting-id="tax.rates" className="text-lg font-semibold text-foreground">
              {t('title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
          <Button
            type="button"
            onClick={onAdd}
            disabled={!taxEnabled}
            variant="default"
            className="gap-2"
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
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 p-4 bg-muted border-b border-border">
          {FILTERS.map(f => (
            <Button
              type="button"
              key={f}
              onClick={() => onFilterChange(f)}
              variant={filter === f ? 'soft' : 'outline'}
              size="sm"
            >
              {t(`filters.${f}`)}
            </Button>
          ))}
        </div>
      </div>

      <DataTable<TaxRate>
        ariaLabel={t('tableLabel')}
        columns={columns}
        rows={rates}
        rowKey={r => r.id}
        emptyState={emptyState}
      />
    </div>
  );
}
