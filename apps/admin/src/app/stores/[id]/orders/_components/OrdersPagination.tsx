'use client';

import { useT } from '@/i18n/useT';
import type { Pagination } from './types';

interface OrdersPaginationProps {
  pagination: Pagination;
  onPageChange: (updater: (prev: number) => number) => void;
}

export function OrdersPagination({ pagination, onPageChange }: OrdersPaginationProps) {
  const t = useT('orders.list.pagination');

  if (pagination.totalPages <= 1) return null;

  const from = (pagination.page - 1) * pagination.limit + 1;
  const to = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
    <div className="flex items-center justify-between border-t px-6 py-3">
      <p className="text-sm text-muted-foreground">
        {t('showing', { from, to, total: pagination.total })}
      </p>
      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={pagination.page === 1}
          onClick={() => onPageChange(p => p - 1)}
        >
          {t('previous')}
        </button>
        <button
          className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={pagination.page === pagination.totalPages}
          onClick={() => onPageChange(p => p + 1)}
        >
          {t('next')}
        </button>
      </div>
    </div>
  );
}
