'use client';

import Link from 'next/link';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';

interface EmptyProductsStateProps {
  storeId: string;
  hasActiveFilters: boolean;
  /** Current products-list URL, used as the `returnTo` target for the
   *  "Add product" CTA so creating a product lands back on this view. */
  listUrl: string;
}

export function EmptyProductsState({
  storeId,
  hasActiveFilters,
  listUrl,
}: EmptyProductsStateProps) {
  const t = useT('products.list.empty');

  return (
    <div className="force-empty-state py-0">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted mx-auto">
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
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      </div>
      <p className="font-semibold text-foreground">
        {hasActiveFilters ? t('titleFiltered') : t('title')}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {hasActiveFilters ? t('descriptionFiltered') : t('description')}
      </p>
      {!hasActiveFilters && (
        <Link
          href={`/stores/${storeId}/products/new?returnTo=${encodeURIComponent(listUrl)}`}
          className="mt-4 inline-block"
        >
          <Button size="sm">{t('addProduct')}</Button>
        </Link>
      )}
    </div>
  );
}
