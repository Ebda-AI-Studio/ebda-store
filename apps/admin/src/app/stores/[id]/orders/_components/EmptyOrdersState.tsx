'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

interface EmptyOrdersStateProps {
  hasActiveFilters: boolean;
}

export function EmptyOrdersState({ hasActiveFilters }: EmptyOrdersStateProps) {
  const t = useT('orders.list.empty');
  const params = useParams();
  const storeId = params?.id as string;

  return (
    <div className="force-empty-state">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
        <svg
          className="h-8 w-8 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
      </div>
      <p className="font-semibold text-foreground">
        {hasActiveFilters ? t('filteredTitle') : t('title')}
      </p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {hasActiveFilters ? t('filteredDescription') : t('description')}
      </p>
      {!hasActiveFilters && storeId && (
        <Link href={`/stores/${storeId}/products/new`} className="mt-4 inline-block">
          <Button size="sm">{t('addProduct')}</Button>
        </Link>
      )}
    </div>
  );
}
