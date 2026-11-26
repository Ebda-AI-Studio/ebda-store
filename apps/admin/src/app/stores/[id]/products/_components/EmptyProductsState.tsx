'use client';

import { useT } from '@/i18n/useT';
import { EmptyState } from '@/components/EmptyState';

interface EmptyProductsStateProps {
  storeId: string;
  hasActiveFilters: boolean;
  /** Current products-list URL, used as the `returnTo` target for the
   *  "Add product" CTA so creating a product lands back on this view. */
  listUrl: string;
  /** The default Active view is empty with no search or category: some products may be drafts. Offers a switch. */
  onShowDrafts?: () => void;
}

export function EmptyProductsState({
  storeId,
  hasActiveFilters,
  listUrl,
  onShowDrafts,
}: EmptyProductsStateProps) {
  const t = useT('products.list.empty');
  const draftsHint = !hasActiveFilters && Boolean(onShowDrafts);

  return (
    <EmptyState
      className="py-0"
      icon="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
      title={hasActiveFilters ? t('titleFiltered') : draftsHint ? t('titleActiveOnly') : t('title')}
      description={
        hasActiveFilters
          ? t('descriptionFiltered')
          : draftsHint
            ? t('descriptionActiveOnly')
            : t('description')
      }
      secondaryAction={draftsHint ? { label: t('showDrafts'), onClick: onShowDrafts } : undefined}
      action={
        hasActiveFilters
          ? undefined
          : {
              label: t('addProduct'),
              href: `/stores/${storeId}/products/new?returnTo=${encodeURIComponent(listUrl)}`,
            }
      }
    />
  );
}
