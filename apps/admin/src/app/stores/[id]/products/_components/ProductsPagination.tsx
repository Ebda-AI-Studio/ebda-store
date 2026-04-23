'use client';

import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import type { Pagination } from './types';

interface ProductsPaginationProps {
  pagination: Pagination;
  page: number;
  onPageChange: (updater: (prev: number) => number) => void;
}

export function ProductsPagination({ pagination, page, onPageChange }: ProductsPaginationProps) {
  const t = useT('products.list.pagination');

  if (pagination.totalPages <= 1) return null;

  const from = (page - 1) * pagination.limit + 1;
  const to = Math.min(page * pagination.limit, pagination.total);

  return (
    <div className="mt-4 flex items-center justify-between">
      <p className="text-sm text-muted-foreground">
        {t('showing', { from, to, total: pagination.total })}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 1}
          onClick={() => onPageChange(p => p - 1)}
        >
          {t('previous')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page === pagination.totalPages}
          onClick={() => onPageChange(p => p + 1)}
        >
          {t('next')}
        </Button>
      </div>
    </div>
  );
}
