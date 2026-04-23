'use client';

import { useT } from '@/i18n/useT';

interface EmptyOrdersStateProps {
  hasActiveFilters: boolean;
}

export function EmptyOrdersState({ hasActiveFilters }: EmptyOrdersStateProps) {
  const t = useT('orders.list.empty');

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
      <p className="mt-1 text-sm text-muted-foreground">
        {hasActiveFilters ? t('filteredDescription') : t('description')}
      </p>
    </div>
  );
}
