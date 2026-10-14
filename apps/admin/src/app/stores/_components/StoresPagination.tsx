'use client';

import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import type { Pagination } from './types';

interface StoresPaginationProps {
  pagination: Pagination;
  onPageChange: (page: number) => void;
}

export function StoresPagination({ pagination, onPageChange }: StoresPaginationProps) {
  const t = useT('stores.list');

  if (pagination.totalPages <= 1) return null;

  const from = (pagination.page - 1) * pagination.limit + 1;
  const to = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
    <div className="mt-6 flex items-center justify-between">
      <p className="text-sm text-muted-foreground">
        {t('paginationShowing', { from, to, total: pagination.total })}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl"
          disabled={pagination.page === 1}
          onClick={() => onPageChange(pagination.page - 1)}
        >
          {t('previous')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl"
          disabled={pagination.page === pagination.totalPages}
          onClick={() => onPageChange(pagination.page + 1)}
        >
          {t('next')}
        </Button>
      </div>
    </div>
  );
}
