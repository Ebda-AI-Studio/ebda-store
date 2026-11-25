'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import type { Pagination } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

// 500 covers the largest catalog we've seen from a tenant (Demo Shop at
// 264) on a single page. Server caps at 500 in product.service.ts; keep
// the two in sync if either is changed.
const PER_PAGE_OPTIONS = [10, 25, 50, 100, 200, 500] as const;

interface ProductsPaginationProps {
  pagination: Pagination;
  page: number;
  onPageChange: (updater: (prev: number) => number) => void;
  /** Optional — when provided the user can switch how many products per page. */
  onLimitChange?: (limit: number) => void;
}

export function ProductsPagination({
  pagination,
  page,
  onPageChange,
  onLimitChange,
}: ProductsPaginationProps) {
  const t = useT('products.list.pagination');

  // Always render so the per-page selector is reachable, even on a single
  // page of results. The Prev/Next buttons stay disabled appropriately.
  const from = pagination.total === 0 ? 0 : (page - 1) * pagination.limit + 1;
  const to = Math.min(page * pagination.limit, pagination.total);

  return (
    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {t('showing', { from, to, total: pagination.total })}
          {pagination.truncated && <span> · {t('truncated')}</span>}
        </p>
        {onLimitChange && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="hidden sm:inline">{t('perPage')}</span>
            <select
              value={pagination.limit}
              onChange={e => onLimitChange(Number(e.target.value))}
              className={FIELD_CLASSES}
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
        <Button variant="outline" disabled={page <= 1} onClick={() => onPageChange(p => p - 1)}>
          {t('previous')}
        </Button>
        <Button
          variant="outline"
          disabled={page >= pagination.totalPages}
          onClick={() => onPageChange(p => p + 1)}
        >
          {t('next')}
        </Button>
      </div>
    </div>
  );
}
