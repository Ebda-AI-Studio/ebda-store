'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { EmptyState } from '@/components/EmptyState';

interface EmptyOrdersStateProps {
  hasActiveFilters: boolean;
}

export function EmptyOrdersState({ hasActiveFilters }: EmptyOrdersStateProps) {
  const t = useT('orders.list.empty');
  const params = useParams();
  const storeId = params?.id as string;

  return (
    <EmptyState
      icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
      title={hasActiveFilters ? t('filteredTitle') : t('title')}
      description={hasActiveFilters ? t('filteredDescription') : t('description')}
      action={
        !hasActiveFilters && storeId
          ? { label: t('addProduct'), href: `/stores/${storeId}/products/new` }
          : undefined
      }
    />
  );
}
