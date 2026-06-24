'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { ProductReorderPage } from '../../../_components/ProductReorderPage';

export default function NewArrivalsOrderPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('products.newArrivalsOrder');

  return (
    <ProductReorderPage
      storeId={storeId}
      listEndpoint={`/api/v1/stores/${storeId}/products/new-arrivals`}
      reorderEndpoint={`/api/v1/stores/${storeId}/products/new-arrivals/reorder`}
      backHref={`/stores/${storeId}/products`}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        backLabel: t('backToProducts'),
        save: t('save'),
        saving: t('saving'),
        unsavedChanges: t('unsavedChanges'),
        fetchFailed: t('fetchFailed'),
        connectionError: t('connectionError'),
        saveFailed: t('saveFailed'),
        saveSuccess: t('saveSuccess'),
        retry: t('retry'),
        empty: t('empty'),
        emptyDescription: t('emptyDescription'),
        moveUp: t('moveUp'),
        moveDown: t('moveDown'),
        inactive: t('inactive'),
        productCount: (count: number) => t('productCount', { count }),
        sku: (sku: string) => t('sku', { sku }),
        goToProducts: t('goToProducts'),
      }}
      emptyIcon={
        <svg
          className="h-8 w-8 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
        </svg>
      }
    />
  );
}
