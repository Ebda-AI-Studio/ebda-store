'use client';

import { useT } from '@/i18n/useT';
import type { Pagination } from './types';

import { Button } from '@/components/ui/Button';
const PER_PAGE_OPTIONS = [10, 25, 50, 100] as const;

interface OrdersPaginationProps {
  pagination: Pagination;
  onPageChange: (updater: (prev: number) => number) => void;
  onLimitChange?: (limit: number) => void;
}

export function OrdersPagination({
  pagination,
  onPageChange,
  onLimitChange,
}: OrdersPaginationProps) {
  const t = useT('orders.list.pagination');

  // Always render the bar so the per-page selector is reachable, even when
  // there's only one page of results. The Prev/Next pair below stays disabled
  // appropriately.
  const from = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const to = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
    <div className="flex flex-col gap-3 border-t px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {t('showing', { from, to, total: pagination.total })}
        </p>
        {onLimitChange && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="hidden sm:inline">{t('perPage')}</span>
            <select
              value={pagination.limit}
              onChange={e => onLimitChange(Number(e.target.value))}
              className="rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              aria-label={t('perPage')}
            >
              {PER_PAGE_OPTIONS.map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={pagination.page <= 1}
          onClick={() => onPageChange(p => p - 1)}
          variant="outline"
          size="sm"
        >
          {t('previous')}
        </Button>
        <Button
          type="button"
          disabled={pagination.page >= pagination.totalPages}
          onClick={() => onPageChange(p => p + 1)}
          variant="outline"
          size="sm"
        >
          {t('next')}
        </Button>
      </div>
    </div>
  );
}
